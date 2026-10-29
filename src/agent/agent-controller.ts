/**
 * AgentController —— 一次对话会话的状态机与编排。
 *
 * 它把三样东西串起来，自己不碰 DOM、不碰 React：
 *
 *   transport（SSE 事件流） → ui-transform（归约） → MessageStore（消息）
 *                    ↕
 *              status$（状态机）
 *
 * ## 为什么要单独一层，而不是写在 React 里
 *
 * - **状态机需要同步读**：判断"能不能发"必须读当前 status 的值，而不是等下一次渲染。
 * - **生命周期比组件长**：切换会话时组件会卸载重建，但请求要能继续跑（Day 5 会用到）。
 * - **可测试**：不依赖 React 就能跑「提交 → 收事件 → 状态回流」的完整链路。
 *
 * ## 三条铁律
 *
 * 1. `threadId` 只从 `RUN_STARTED` 事件里取，绝不自己生成。
 * 2. 中止（AbortError）不是错误，必须与网络失败分开处理。
 * 3. 每次提交都带全量历史（网关只取最后一条，但重生成要靠完整历史回溯）。
 */

import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';

import { MessageStore } from '../message/message-store';
import { createAssistantPlaceholder, getTextContent, type LiveContext, type UIMessage } from '../message/type';
import { aggregateSnapshot, applyLiveEvent, createErrorPart, createTextPart } from '../message/ui-transform';
import { connectAgentStream } from '../transport/agent-gateway';
import type { AgentEvent, WireMessage } from '../transport/types';

/** 会话运行状态。Day 2 只有两个；Day 5 会加 Restoring（历史回放中）。 */
export enum AgentStatus {
  /** 可接受新输入。 */
  Ready = 'ready',
  /** 正在生成回复。 */
  Generating = 'generating',
}

export interface AgentControllerOptions {
  /** 事件观察口，用于调试面板/埋点。不影响归约。 */
  onEvent?: (event: AgentEvent) => void;
  /** 可注入的连接函数，测试时替换成假的。默认用真实的 connectAgentStream。 */
  connect?: typeof connectAgentStream;
}

export interface ImageInput {
  url: string;
  filename: string;
  mimeType: string;
}

export class AgentController {
  /** 运行状态流。 */
  readonly status$ = new BehaviorSubject<AgentStatus>(AgentStatus.Ready);

  /** 会话 ID。初始为空串；收到 RUN_STARTED 后回填。 */
  readonly threadId$ = new BehaviorSubject<string>('');

  /** UI 消息流（透传 store）。渲染层只订阅这个。 */
  readonly messages$: Observable<UIMessage[]>;

  private readonly store = new MessageStore();

  /** 本轮正在写的消息；由 applyLiveEvent 维护，submit 时重置。 */
  private readonly liveCtx: LiveContext = { currentAssistantId: null };
  private readonly options: AgentControllerOptions;
  private abortController: AbortController | null = null;
  private subscription: Subscription | null = null;

  constructor(options: AgentControllerOptions = {}) {
    this.options = options;
    this.messages$ = this.store.messages$;
  }

  /** 同步读取消息快照。 */
  get snapshot(): UIMessage[] {
    return this.store.snapshot;
  }

  /** 同步读取当前状态。 */
  get status(): AgentStatus {
    return this.status$.value;
  }

  /**
   * 用一份协议消息列表整体替换当前消息（快照路径）。
   *
   * Day 5 打开历史会话时用；现在先给 demo 一个"看快照长什么样"的入口。
   */
  loadSnapshot(messages: WireMessage[]): void {
    this.store.replaceAll(aggregateSnapshot(messages));
    this.liveCtx.currentAssistantId = null;
  }

  /** 手动指定会话 ID（打开已有会话时用；Day 5 的入口）。 */
  setThreadId(threadId: string): void {
    this.threadId$.next(threadId);
  }

  /**
   * 提交一轮对话。
   *
   * @param text 用户输入（已 trim；空串由调用方拦截）
   * @returns 是否真的发起；正在生成中返回 false
   *
   * 步骤：
   * 1. **状态门禁**：status === Generating 直接 return false
   * 2. **落用户消息**：store.push({ id, role: 'user', parts: [text part] })
   * 3. **落占位**：store.push(createAssistantPlaceholder()) —— 用户要立刻看到"正在回答"
   * 4. **切状态**：status$ = Generating；新建 AbortController 并保存
   * 5. **组装历史**：把 store 里每一条消息转成 WireMessage（用 getTextContent）
   * 6. **订阅流**：
   *    - next：先调 options.onEvent（如果传了），再 applyLiveEvent(store, event)
   *      其中 RUN_STARTED 要额外把 event.threadId 写进 threadId$
   *    - error：AbortError → 追加「用户已取消」error part；其他 → 追加其 message
   *      两路最后都要：status$ = Ready、abortController 置 null
   *    - complete：status$ = Ready、abortController 置 null
   * 7. return true
   *
   * 边界：
   * - 空文本：不加任何消息，return false
   * - 上一轮未结束就再次提交：拒绝，不能产生两条在途流
   */
  submit(text: string, images: ImageInput[]): boolean {
    // TODO(wendy): 按上面 7 步实现
    if (this.status === AgentStatus.Generating) {
      return false;
    }

    if (text.trim() === '') {
      return false;
    }

    this.store.push({
      // 只要唯一即可：既是 React key，也是 store.find 的键。
      // 用毫秒 + 随机后缀，避免连发两条时 Date.now() 相同导致重复。
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      parts: [createTextPart(text)],
    });

    this.store.push(createAssistantPlaceholder());
    this.liveCtx.currentAssistantId = null;

    this.status$.next(AgentStatus.Generating);
    const controller = new AbortController();
    this.abortController = controller;
    const messages = this.buildWireHistory();
    const connect = this.options.connect ?? connectAgentStream;

    /**
     * 收尾：把状态交还给 Ready。
     *
     * 三条终止路径共用它（RUN_FINISHED / error / complete），所以必须**幂等**：
     * RUN_FINISHED 之后流还会再触发一次 complete，不做保护就会收尾两次。
     *
     * 身份比较（`this.abortController !== controller`）解决另一个竞态：
     * 用户中止 → 立刻发下一条 → 上一轮的 error 姗姗来迟，会把新一轮的 controller 清掉。
     */
    const finish = (): void => {
      if (this.abortController !== controller) return;

      this.abortController = null;
      this.status$.next(AgentStatus.Ready);
    };

    this.subscription = connect({
      threadId: this.threadId$.value,
      messages,
      channel: 'doc',
      signal: controller.signal,
    }).subscribe({
      next: (event: AgentEvent) => {
        this.options.onEvent?.(event);
        if (event.type === 'RUN_STARTED' && event.threadId) {
          this.threadId$.next(event.threadId);
        }

        applyLiveEvent(this.store, event, this.liveCtx);

        // 这一轮回答结束。readstream 长连接上每轮都会来一次 RUN_FINISHED，
        // 但连接不会关闭，所以不能只靠 complete 收尾。
        if (event.type === 'RUN_FINISHED') finish();
        if (event.type === 'RUN_ERROR') finish();
      },
      error: (error: Error) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          this.appendError('用户已取消');
        } else {
          this.appendError(error.message);
        }

        finish();
      },
      complete: () => finish(),
    });

    return true;
  }

  /**
   * 中止当前生成。
   *
   * 步骤：
   * 1. 没有在途请求 → 直接 return（不报错）
   * 2. 调 abortController.abort()
   * 3. 状态与错误的收尾**不在这里做**——交给 subscribe 的 error 回调统一处理，
   *    否则会和 error 回调重复执行（这是最容易写出双重收尾的地方）
   */
  abort(): void {
    // TODO(wendy): 按上面 3 步实现
    if (!this.abortController) return;
    this.abortController.abort();
  }

  dispose(): void {
    this.subscription?.unsubscribe();
    this.abortController?.abort();
    this.store.dispose();
    this.status$.complete();
    this.threadId$.complete();
  }

  /**
   * 把当前消息列表转成协议历史（已给好）。
   *
   * 只取文本内容：Day 2 的消息只有 user 文本 + assistant 文本。
   * Day 3 加了工具调用之后，这里要补 tool_calls / tool 消息，否则后端会丢上下文。
   */
  buildWireHistory(): WireMessage[] {
    return this.store.snapshot.map(message => ({
      id: message.id,
      role: message.role,
      content: getTextContent(message),
    }));
  }

  /** 供派生逻辑使用：把一段错误追加到当前回答末尾（已给好）。 */
  appendError(message: string): void {
    const last = this.store.snapshot.at(-1);
    const targetId = last?.role === 'assistant' ? last.id : createAssistantPlaceholder().id;
    this.store.appendPart(targetId, createErrorPart(message));
  }

  /** @internal 供 submit 内部使用，外部不要调。 */
  private _store(): MessageStore {
    return this.store;
  }
}

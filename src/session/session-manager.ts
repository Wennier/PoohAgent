/**
 * SessionManager —— 多会话的「表」与「指针」。
 *
 * ## 它解决的产品问题
 *
 * - P3 状态归属：每个会话有**自己的** AgentController（消息、状态机、threadId），
 *   切换会话只是换一个被订阅的实例，旧会话的流写不进新会话。
 * - P4 草稿提升：新建会话在发出第一条消息前只是 `draft`，**不进列表**；
 *   拿到真实 threadId 后才落成 ready。三步顺序写死，保证任意中间态都能解析出活动会话。
 * - P1/P2：列表顺序 + activeId 持久化，刷新后能回到上次的会话（历史由服务端拉取）。
 *
 * ## 不做什么
 *
 * - 不持有消息：消息在各自的 controller 里；
 * - 不拉接口：`hydrate()` 由调用方把服务端列表灌进来，便于单测；
 * - 不做同步：跨 Tab / 跨设备不在 Day 5 范围。
 */

import { BehaviorSubject, type Subscription } from 'rxjs';

import type { AgentController } from '../agent/agent-controller';

import type { SessionMeta, SessionPointer } from './types';

export interface SessionManagerDeps {
  /** 每个会话一个 controller。传入 sessionId 是为了日志/埋点能区分来源。 */
  createController: (sessionId: string) => AgentController;
  /** 上次停在哪。 */
  pointer: SessionPointer;
  /**
   * 草稿拿到 threadId 后，用这个函数生成列表标题。
   *
   * 注入而不是在会话层解析消息：会话层不该依赖"消息长什么样"，
   * 标题规则（首句前 20 字）属于产品层。
   */
  titleOf?: (controller: AgentController) => string;
  now?: () => number;
  makeDraftId?: () => string;
}

export class SessionManager {
  /** 列表只含 ready 会话：草稿在发出第一条消息前不该出现在界面上。 */
  readonly sessions$ = new BehaviorSubject<SessionMeta[]>([]);

  /** 当前活动会话 id；null 表示空态（没有会话，显示引导）。 */
  readonly activeId$ = new BehaviorSubject<string | null>(null);

  private readonly controllers = new Map<string, AgentController>();
  /** controller → threadId$ 订阅（草稿自动提升用），删除/销毁时要退订。 */
  private readonly promotions = new Map<AgentController, Subscription>();
  /** 草稿不进 sessions$，但同样要有 controller，否则第一条消息无处可发。 */
  private readonly drafts = new Map<string, SessionMeta>();

  private readonly createController: (sessionId: string) => AgentController;
  private readonly pointer: SessionPointer;
  private readonly titleOf?: (controller: AgentController) => string;
  private readonly now: () => number;
  private readonly makeDraftId: () => string;

  constructor(deps: SessionManagerDeps) {
    this.createController = deps.createController;
    this.pointer = deps.pointer;
    this.titleOf = deps.titleOf;
    this.now = deps.now ?? (() => Date.now());
    this.makeDraftId =
      deps.makeDraftId ?? (() => `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  }

  get activeId(): string | null {
    return this.activeId$.value;
  }

  /** 当前活动会话的元信息（草稿也能取到，列表里看不到但标题要用）。 */
  get activeMeta(): SessionMeta | null {
    const id = this.activeId$.value;

    return id === null ? null : this.metaOf(id);
  }

  /** 任意会话的元信息（草稿或正式会话）；不存在返回 null。 */
  metaOf(id: string): SessionMeta | null {
    return this.drafts.get(id) ?? this.sessions$.value.find(meta => meta.id === id) ?? null;
  }

  /**
   * 取（或懒创建）会话对应的 controller。
   *
   * 懒创建的原因：切回一个没打开过的历史会话时，消息还没拉到，
   * 先建空壳没有意义；等真要渲染/发送时再建。
   */
  controllerOf(id: string): AgentController {
    const existing = this.controllers.get(id);
    if (existing) return existing;

    const created = this.createController(id);
    this.controllers.set(id, created);

    /**
     * 草稿自动提升：只认**这个 controller 自己**的 threadId。
     *
     * 为什么不能放在 UI 的 effect 里用「当前活动会话的 threadId 状态」判断：
     * 切换会话时，activeId 已经变了、threadId 状态还停留在上一个会话，
     * 那一帧会把新草稿提升成旧会话的 threadId —— 表现就是"点新建又被弹回旧会话"。
     *
     * 放在这里还顺带修了另一个洞：用户在 RUN_STARTED 之前就切走，
     * 旧草稿也能在后台正常落成正式会话。
     */
    this.promotions.set(
      created,
      created.threadId$.subscribe(threadId => {
        if (threadId === '') return;

        const meta = this.metaOf(id);
        if (meta?.kind !== 'draft') return;

        this.promote(id, threadId, this.titleOf?.(created));
      }),
    );

    return created;
  }

  /**
   * 是否已经建过 controller（**不会顺手创建**）。
   *
   * 列表要给"正在生成"画转圈时用：没打开过的会话不该为了一个图标去造实例。
   */
  hasController(id: string): boolean {
    return this.controllers.has(id);
  }

  /** 新建草稿并切过去。不走列表（P4：避免"未命名"占位）。 */
  createDraft(): string {
    const id = this.makeDraftId();
    const timestamp = this.now();

    this.drafts.set(id, {
      id,
      title: '未命名',
      kind: 'draft',
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    this.activate(id);

    return id;
  }

  /** 切换活动会话。未知 id 直接忽略并 warn：切到已删除的会话不该炸。 */
  activate(id: string): void {
    if (!this.isKnown(id)) {
      console.warn(`[session] 激活了未知会话：${id}`);
      return;
    }

    // 幂等：重复激活同一个会话不重复写指针
    if (this.activeId$.value === id) return;

    this.activeId$.next(id);
    this.pointer.write(id);
  }

  /**
   * 删除会话（本地）。删的是活动会话时自动切到相邻的一条（P5）。
   *
   * 相邻的定义：列表中的**下一条**，没有就**上一条**；全删完回到空态。
   * 不在这里调远端删除接口——那是 demo 层的事，管理器只管本地状态。
   */
  remove(id: string): void {
    const list = this.sessions$.value;
    const index = list.findIndex(meta => meta.id === id);
    const isDraft = this.drafts.has(id);
    if (index === -1 && !isDraft) return;

    // 先算好"接班的人"，再动列表，避免删完找不到相邻项
    const neighbor = index === -1 ? undefined : (list[index + 1] ?? list[index - 1]);

    if (index !== -1) {
      this.sessions$.next(list.filter(meta => meta.id !== id));
    }
    this.drafts.delete(id);

    const controller = this.controllers.get(id);
    if (controller) {
      this.promotions.get(controller)?.unsubscribe();
      this.promotions.delete(controller);
      controller.dispose();
    }
    this.controllers.delete(id);

    if (this.activeId$.value !== id) return;

    const next = neighbor ?? this.sessions$.value[0];
    if (next) {
      this.activate(next.id);
    } else {
      this.activeId$.next(null);
      this.pointer.write(null);
    }
  }

  /**
   * 草稿提升：拿到真实 threadId 后把草稿变成正式会话（P4）。
   *
   * 顺序是硬要求：**先入列表 → 再切活动 → 最后清草稿**。
   * 每一步之间都可能被渲染/刷新打断，这个顺序保证任意中间态下
   * 「活动会话」都能被解析出来（否则会出现"发送后回到初始页"）。
   */
  promote(draftId: string, threadId: string, title?: string): void {
    const draft = this.drafts.get(draftId);
    if (!draft) {
      console.warn(`[session] 提升了一个不存在的草稿：${draftId}`);
      return;
    }

    const timestamp = this.now();
    const meta: SessionMeta = {
      id: threadId,
      title: title ?? draft.title,
      kind: 'ready',
      createdAt: draft.createdAt,
      updatedAt: timestamp,
    };

    // ① 入列表
    const exists = this.sessions$.value.some(item => item.id === threadId);
    if (!exists) this.sessions$.next([meta, ...this.sessions$.value]);

    // 顺带把 controller 的键从草稿 id 换成 threadId（没建过就不管）
    const controller = this.controllers.get(draftId);
    if (controller) {
      this.controllers.delete(draftId);
      this.controllers.set(threadId, controller);
    }

    // ② 切活动（内部会写指针）
    if (this.activeId$.value === draftId) this.activate(threadId);

    // ③ 清草稿
    this.drafts.delete(draftId);
  }

  /**
   * 用服务端返回的会话列表重建列表（`/runtimes` 回来后调用）。
   *
   * 保留已有 controller：切换回来时消息还在，不必重新拉。
   */
  hydrate(sessions: SessionMeta[]): void {
    this.sessions$.next(sessions);
  }

  /**
   * 启动时恢复上次的会话（P2）。
   *
   * 指针里的 id 可能已经失效（被删/换设备/清缓存）→ 回退到列表第一项；列表也空就回空态。
   */
  restore(): void {
    const saved = this.pointer.read();
    if (saved !== null && this.isKnown(saved)) {
      this.activate(saved);
      return;
    }

    const first = this.sessions$.value[0];
    if (first) {
      this.activate(first.id);
    } else {
      this.activeId$.next(null);
      this.pointer.write(null);
    }
  }

  /** 更新标题（本轮不做重命名 UI，留给"首轮结束后回填服务端标题"）。 */
  rename(id: string, title: string): void {
    const draft = this.drafts.get(id);
    if (draft) {
      this.drafts.set(id, { ...draft, title, updatedAt: this.now() });
      return;
    }

    this.sessions$.next(
      this.sessions$.value.map(meta =>
        meta.id === id ? { ...meta, title, updatedAt: this.now() } : meta,
      ),
    );
  }

  dispose(): void {
    for (const subscription of this.promotions.values()) subscription.unsubscribe();
    this.promotions.clear();
    for (const controller of this.controllers.values()) controller.dispose();
    this.controllers.clear();
    this.drafts.clear();
    this.sessions$.complete();
    this.activeId$.complete();
  }

  private isKnown(id: string): boolean {
    return this.drafts.has(id) || this.sessions$.value.some(meta => meta.id === id);
  }
}

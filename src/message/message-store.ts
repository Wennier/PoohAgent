/**
 * MessageStore —— UI 消息的唯一可变持有者。
 *
 * 为什么不用 useState 存消息数组：
 * - 流式更新是**高频、局部**的（一帧改最后一条消息的一个 part），
 *   用 setState 会因为引用变化把整个列表重渲染；
 * - 归约逻辑需要一个"同步可读可写"的容器，而 React state 是异步快照。
 *
 * 所以：Store 持有 BehaviorSubject，React 侧通过订阅拿到不可变快照（Day 2 接线时接）。
 */

import { BehaviorSubject } from 'rxjs';

import type { Part, ToolPart, UIMessage } from './type';

export class MessageStore {
  /** 消息列表流。每次变更都推送**新的数组引用**（保持不可变，方便 React 比对）。 */
  readonly messages$ = new BehaviorSubject<UIMessage[]>([]);

  /** 同步读取当前快照（归约逻辑内部用，不要放进渲染依赖）。 */
  get snapshot(): UIMessage[] {
    return this.messages$.value;
  }

  /** 整体替换（快照重建路径用）。 */
  replaceAll(messages: UIMessage[]): void {
    this.messages$.next(messages);
  }

  /** 追加一条消息到末尾。 */
  push(message: UIMessage): void {
    this.messages$.next([...this.messages$.value, message]);
  }

  /** 按 id 查找。 */
  find(messageId: string): UIMessage | undefined {
    return this.messages$.value.find(message => message.id === messageId);
  }

  /**
   * 把某条消息的 id 改成新 id。
   *
   * 用途：占位消息被后端真实 messageId 接管。
   *
   * @param fromId 原 id（占位 id）
   * @param toId   新 id（RUN_STARTED 之后首个 TEXT_MESSAGE_START 的 messageId）
   * @returns 是否命中并完成替换；未命中返回 false（不抛错，调用方决定要不要兜底）
   */
  replaceId(fromId: string, toId: string): boolean {
    // 步骤 1：找到 fromId 的下标；找不到 return false
    // 步骤 2：若已存在 toId，说明后端重复下发，直接丢弃占位（避免两条同 id）
    // 步骤 3：拷贝数组、替换该元素的 id、next 出去、return true
    // TODO(wendy): 实现上面三步
    const messages = this.messages$.value;
    const index = messages.findIndex(message => message.id === fromId);
    if (index === -1) {
      return false;
    }

    if (messages.some(message => message.id === toId)) {
      // 真实消息已经到了，占位没有存在价值 → 直接删掉占位
      this.messages$.next(messages.filter(message => message.id !== fromId));
      return true;
    }

    const newMessages = [...messages];
    newMessages[index] = { ...newMessages[index], id: toId };
    this.messages$.next(newMessages);
    return true;
  }

  /**
   * 向指定消息追加文本增量。
   *
   * 规则（这三条决定了流式内容会不会"串味"）：
   * - 目标是消息的**最后一个 text part**；没有 text part 就新建一个
   * - 消息不存在时**忽略并 warn，不抛错**（流式过程中容忍乱序/缺 START）
   * - 必须产生新的数组 / 新的 part 对象引用，不能原地改
   *
   * @param messageId UI 消息 id（一轮回答只有一个）
   * @param delta     本次增量（可能为空字符串，此时应该直接返回）
   * @param partId    段 id（该段 TEXT_MESSAGE 的 messageId）；不传则续写最后一段
   */
  appendText(messageId: string, delta: string, partId?: string): void {
    // 步骤 1：delta 为空 → return（避免无意义的渲染）
    // 步骤 2：找到 messageId 对应消息；找不到 → console.warn 并 return
    // 步骤 3：从后往前找最后一个 type === 'text' 的 part
    //         - 找到：newParts 里把这个 part 的 content 拼接 delta
    //         - 没找到：push 一个新的 TextPart（id 用 messageId，content 为 delta）
    // 步骤 4：next 出去（新数组 + 新消息对象 + 新 parts 数组）
    // TODO(wendy): 实现上面四步
    if (delta === '') {
      return;
    }

    const currentMessage = this.find(messageId);
    if (!currentMessage) {
      console.warn(`Message not found for id: ${messageId}`);
      return;
    }

    const parts = [...currentMessage.parts];
    const lastTextPartIndex = parts.findLastIndex(part => part.type === 'text');
    const lastTextPart = lastTextPartIndex === -1 ? undefined : parts[lastTextPartIndex];

    // 同段续写 vs 新开一段：靠 partId 判断。换段时若还续写，段1/工具卡/段2 就排不开了。
    const canAppendToLast = lastTextPart?.type === 'text'
      && (partId === undefined || lastTextPart.id === partId);

    if (canAppendToLast && lastTextPart?.type === 'text') {
      parts[lastTextPartIndex] = {
        ...lastTextPart,
        content: lastTextPart.content + delta,
      };
    } else {
      parts.push({ type: 'text', id: partId ?? messageId, content: delta });
    }

    this.messages$.next([
      ...this.messages$.value.map((message) => {
        if (message.id === messageId) {
          return { ...message, parts };
        }

        return message;
      }),
    ]);
  }

  /**
   * 向指定消息追加一个 part（错误段落用得到，Day 3 的工具卡也会用）。
   *
   * 消息不存在时：**新建一条 assistant 消息并挂上该 part**，而不是丢弃——
   * 因为"出错了却没有消息可挂"是最常见的边界情况（请求还没开始就失败）。
   *
   * @param messageId 目标消息 id
   * @param part      要追加的 part
   */
  appendPart(messageId: string, part: Part): void {
    // 步骤 1：找到目标消息
    // 步骤 2：命中 → 拷贝并追加 part
    // 步骤 3：未命中 → 创建一条以其 id 为 id 的 assistant 消息，只含这个 part
    // TODO(wendy): 实现上面三步
    const currentMessage = this.find(messageId);
    if (currentMessage) {
      const newParts = [...currentMessage.parts, part];
      this.messages$.next([
        ...this.messages$.value.map((message) => {
          if (message.id === messageId) {
            return { ...message, parts: newParts };
          }

          return message;
        }),
      ]);
    } else {
      this.messages$.next([...this.messages$.value, { id: messageId, role: 'assistant', parts: [part] }]);
    }
  }

  /**
   * 记录一次工具调用开始（对应 `TOOL_CALL_START`）。
   *
   * 步骤：
   * 1. 找 `messageId` 对应消息；不存在 → `console.warn` 并 return
   * 2. 已有 `type==='tool' && id===toolCallId` → return（重复 START 不产生第二个卡片）
   * 3. 否则追加 `{ type:'tool', id, name, args:'', result:null, status:'calling' }`
   * 4. next 出去（新数组 + 新 message + 新 parts）
   *
   * @param messageId  这条工具调用所属的 assistant 消息 id
   * @param toolCallId 协议里的 toolCallId
   * @param name       工具名（如 webSearch），显示为卡片标题
   */
  startToolPart(messageId: string, toolCallId: string, name: string): void {
    this.updateParts(messageId, (parts) => {
    // 重复 START（续流会重放）不能变出第二张卡
      if (parts.some(part => part.type === 'tool' && part.id === toolCallId)) return null;

      return [
        ...parts,
        { type: 'tool', id: toolCallId, name, args: '', result: null, status: 'calling' },
      ];
    });
  }

  /**
   * 追加工具参数分片（对应 `TOOL_CALL_ARGS`）。
   *
   * 步骤：
   * 1. 找消息；不存在 → warn 并 return
   * 2. `delta` 为空 → return
   * 3. 找对应 tool part；找不到 → warn 并 return
   *    （**不要自动创建**：这条事件不带 name，建出来是无名卡片）
   * 4. 命中：`args += delta`（新对象），status 保持 `calling`，next
   *
   * 边界：`args` 全程可能是不完整 JSON，**不能在这里解析**——界面就是原样显示。
   */
  appendToolArgs(messageId: string, toolCallId: string, delta: string): void {
    if (delta === '') return;
    const currentMessage = this.find(messageId);
    if (!currentMessage) {
      console.warn(`Message not found for id: ${messageId}`);
      return;
    }

    this.updateToolPart(messageId, toolCallId, part => ({ ...part, args: part.args + delta }));
  }

  /**
   * 参数发完（对应 `TOOL_CALL_END`）：`calling` → `running`。
   *
   * 为什么单独一个方法：产品上这两种状态的文案不同（"正在使用" vs "正在执行"），
   * 且 END 只表示"参数已发完"，**不代表有结果**。UI 若把它当成完成，会出现"已完成但没有结果"。
   */
  markToolRunning(messageId: string, toolCallId: string): void {
    this.updateToolPart(messageId, toolCallId, part => ({ ...part, status: 'running' }));
  }

  /**
   * 回填工具结果（对应 `TOOL_CALL_RESULT`）—— 只改字段，不新增 part。
   *
   * 步骤：
   * 1. 找消息；不存在 → warn 并 return
   * 2. 找对应 tool part；找不到 → warn 并 return
   * 3. 命中：`result = 传入值`，`status = 'done'`，next
   * 4. 原来已有 result（重复 RESULT）→ 用新值覆盖并 warn
   *
   * 为什么是"回填"而不是"追加 part"：直播侧结果是一条事件、快照侧结果是一条独立消息，
   * 只有把 result 做成 part 的字段，两条路径才能折叠成同一形状。
   */
  patchToolResult(messageId: string, toolCallId: string, result: string): void {
    this.updateToolPart(messageId, toolCallId, (part) => {
      if (part.result !== null) console.warn(`重复的 TOOL_CALL_RESULT: ${toolCallId}`);

      return { ...part, result, status: 'done' };
    });
  }

  /**
   * 把工具调用标记为失败（对应本轮 `RUN_ERROR`，或流中断）。
   *
   * 为什么需要它：失败**不一定**来自 RESULT 事件。如果整轮异常结束，
   * 那些停在 `calling` / `running` 的卡片必须一起标红，否则界面会永远转圈。
   *
   * 步骤：
   * 1. 找消息；不存在 → warn 并 return
   * 2. 找对应 tool part；找不到 → warn 并 return
   * 3. 命中：`status = 'failed'`（`result` 保持原值，若有就一起展示），next
   */
  failToolPart(messageId: string, toolCallId: string): void {
    this.updateToolPart(messageId, toolCallId, part => ({ ...part, status: 'failed' }));
  }

  dispose(): void {
    this.messages$.complete();
  }

  /** 统一的 parts 更新入口：消息不存在就 warn + 丢弃，返回 null 表示不更新。 */
  private updateParts(messageId: string, updater: (parts: Part[]) => Part[] | null): void {
    const current = this.find(messageId);
    if (!current) {
      console.warn(`Message not found for id: ${messageId}`);
      return;
    }

    const nextParts = updater([...current.parts]);
    if (!nextParts) return;

    this.messages$.next(
      this.messages$.value.map(message => (message.id === messageId ? { ...message, parts: nextParts } : message)),
    );
  }

  /** 定位某个 tool part 并就地更新；找不到就 warn + 丢弃。 */
  private updateToolPart(
    messageId: string,
    toolCallId: string,
    updater: (part: ToolPart) => ToolPart | null,
  ): void {
    this.updateParts(messageId, (parts) => {
      const index = parts.findIndex(part => part.type === 'tool' && part.id === toolCallId);
      const part = index === -1 ? undefined : parts[index];
      if (part?.type !== 'tool') {
        console.warn(`Tool part not found: ${toolCallId}`);
        return null;
      }

      const next = updater(part);
      if (!next) return null;

      parts[index] = next;
      return parts;
    });
  }
}

/**
 * UI 归约 —— 协议数据 → UI 消息。这是 Day 2 的技术核心。
 *
 * ## 为什么有两条路径，而不是一条
 *
 * 同一个会话的消息可能从两个方向进入：
 *
 * 1. **直播**：用户刚发一条消息，后端一条条推事件过来（TEXT_MESSAGE_START/CONTENT/...）。
 *    此时消息是"逐字长出来"的，只能**增量**追加。
 * 2. **快照**：打开历史会话时，后端一次性返回完整消息列表（MESSAGES_SNAPSHOT）。
 *    此时**全量重建**最快、最不容易错。
 *
 * 关键约束：**两条路径必须产出结构完全一致的 UIMessage**。
 * 否则会出现"刚发的消息"和"刷新后同一条消息"长得不一样的低级 bug。
 *
 * 所以这里刻意分成两个入口、共享同一套 Part 结构；快照路径**不复用**增量逻辑
 * （用增量去重放历史，会被缺 START / 乱序 / 重复投递搞得很难查）。
 */

import type { AgentEvent, WireMessage } from '../transport/types';

import type { MessageStore } from './message-store';
import {
  createAssistantMessage,
  createAssistantPlaceholder,
  isAssistantPlaceholder } from './type';
import type {
  ErrorPart,
  LiveContext,
  Part,
  TextPart,
  ToolPart,
  UIMessage,
} from './type';

// ============================================================
// 路径一：直播增量
// ============================================================

/** 取"本轮正在写的消息"；为 null 说明事件乱序或流从中间接入，丢这一条比打断整条流划算。 */
function requireCurrent(ctx: LiveContext, eventType: string): string | null {
  if (ctx.currentAssistantId) return ctx.currentAssistantId;

  console.warn(`[ui-transform] ${eventType} 到达时没有当前消息，已忽略`);
  return null;
}

/**
 * 把一个直播事件应用到 store。
 *
 * 事件与动作的对应关系：
 *
 * | 事件 | 动作 |
 * | --- | --- |
 * | TEXT_MESSAGE_START | 占位消息接管真实 id；没有占位则新建 assistant 消息 |
 * | TEXT_MESSAGE_CONTENT | 追加文本增量到对应消息 |
 * | TEXT_MESSAGE_END | 只界定边界，不改内容（内容已在 CONTENT 里写完） |
 * | RUN_ERROR | 追加 error part 到当前回答 |
 * | RUN_STARTED / RUN_FINISHED | 归约层不处理（threadId、状态由 controller 管） |
 * | 未知事件 | 忽略，且**不得抛错** |
 *
 * 边界：
 * - 同一条流里重复来 START：不能产生两条消息
 * - CONTENT 早于 START 到达：要能容错（appendText 内部会兜底）
 * - 流为空（没有任何事件）：store 不应被改动
 */
export function applyLiveEvent(store: MessageStore, event: AgentEvent, ctx: LiveContext): void {
  switch (event.type) {
    case 'RUN_STARTED': {
      ctx.currentAssistantId = null;
      return;
    }

    case 'TEXT_MESSAGE_START': {
      const messages = store.snapshot;
      const lastMessage = messages[messages.length - 1];

      // 占位接管：提交时插的空壳消息，由第一条 START 把它的 id 换成后端真实 id。
      // 注意必须先判 lastMessage 存在——空 store 时直接取 .id 会 TypeError。
      if (lastMessage && lastMessage.role === 'assistant' && isAssistantPlaceholder(lastMessage.id)) {
        store.replaceId(lastMessage.id, event.messageId);
        ctx.currentAssistantId = event.messageId;
        return;
      }

      // 已有 assistant 消息：不造新消息，只记录 id。
      if (ctx.currentAssistantId) return;

      // 重复 START（readstream 续流时会重放最后一条）：不能再造一条同 id 的消息。
      if (store.find(event.messageId)) {
        ctx.currentAssistantId = event.messageId;
        return;
      }

      store.push(createAssistantMessage(event.messageId));
      ctx.currentAssistantId = event.messageId;
      return;
    }

    case 'TEXT_MESSAGE_CONTENT': {
      const target = requireCurrent(ctx, event.type);
      if (!event.delta || !target) return;

      // 第三参是段 id：同段续写，换段新建（段1 / 工具卡 / 段2 才排得开）
      store.appendText(target, event.delta, event.messageId);
      return;
    }

    case 'TOOL_CALL_START': {
      const target = requireCurrent(ctx, event.type);
      if (!target) return;

      store.startToolPart(target, event.toolCallId, event.toolCallName);
      return;
    }

    case 'TOOL_CALL_ARGS': {
      const target = requireCurrent(ctx, event.type);
      if (!target) return;

      store.appendToolArgs(target, event.toolCallId, event.delta);
      return;
    }

    case 'TOOL_CALL_END': {
      const target = requireCurrent(ctx, event.type);
      if (!target) return;

      store.markToolRunning(target, event.toolCallId);
      return;
    }

    case 'TOOL_CALL_RESULT': {
      const target = requireCurrent(ctx, event.type);
      if (!target) return;

      store.patchToolResult(target, event.toolCallId, event.content);
      return;
    }

    case 'RUN_FINISHED': {
      ctx.currentAssistantId = null;
      return;
    }

    case 'RUN_ERROR': {
      // 先把停在 calling / running 的卡片标失败，否则界面会一直转圈
      const currentId = ctx.currentAssistantId;
      if (currentId) {
        for (const part of store.find(currentId)?.parts ?? []) {
          if (part.type === 'tool' && (part.status === 'calling' || part.status === 'running')) {
            store.failToolPart(currentId, part.id);
          }
        }
      }

      // 错误挂到当前回答末尾：有 assistant 就挂它，没有就造一条承载。
      const messages = store.snapshot;
      const lastMessage = messages[messages.length - 1];
      const targetId = lastMessage?.role === 'assistant' ? lastMessage.id : createAssistantPlaceholder().id;

      // code 透传：渲染层靠它决定文案分级与是否给"重试"（不在这里翻译成人话）
      store.appendPart(targetId, createErrorPart(event.message || '生成失败', event.code));
      return;
    }

    default:
      // TEXT_MESSAGE_END / RUN_STARTED / RUN_FINISHED / 未知事件：归约层不改消息。
      // 这里必须 return 而不是抛错，否则新增事件类型会直接打断整条流。
      return;
  }
}

// ============================================================
// 路径二：快照全量重建
// ============================================================

/**
 * 把一份完整的协议消息列表聚合成 UI 消息列表。
 *
 * 纯函数、无副作用，可以直接单测——这是它和增量路径分开的另一个好处。
 *
 * Day 2 只处理 user / assistant 的文本；其余 role（tool / reasoning / custom）
 * 先跳过，Day 3 再接（工具调用要把 tool 结果合并回父 assistant 消息）。
 *
 * @param messages 协议层消息（`/history` 返回的格式）
 * @returns UI 消息数组，顺序与入参一致（跳过的不占位）
 *
 * 边界：
 * - 消息缺 id → 生成一个稳定的本地 id（不能留空，否则后续按 id 更新会错乱）
 * - `content` 与 `content_parts` 同时存在时，`content_parts` 优先（后端约定）
 * - 空内容的消息仍然保留（可能只有 tool_calls，Day 3 用得上）
 */
export function aggregateSnapshot(messages: WireMessage[]): UIMessage[] {
  const result: UIMessage[] = [];
  /** 当前正在折叠的 assistant 消息（上一条是 tool 时，新的 assistant 要并进它）。 */
  let current: UIMessage | null = null;
  /** 上一条 wire 的 role，用来判断"这是续写还是新的一轮"。 */
  let lastRole: string | null = null;

  for (const [index, message] of messages.entries()) {
    const id = message.id || `local_${index}`;
    const { role } = message;

    if (role === 'user') {
      result.push({ id, role: 'user', parts: buildUserParts(message) });
      current = null;
      lastRole = role;
      continue;
    }

    if (role === 'assistant') {
      const text = extractWireText(message);
      const parts: Part[] = [];

      if (text) parts.push(createTextPart(text, id));
      // 历史里的工具调用：没有结果（result 未知）时先标 running——
      // 若这轮仍在跑，后续 readstream 会回填成 done；纯历史里没结果就是脏数据，Day 5 再细化。
      for (const call of message.tool_calls ?? []) {
        parts.push({
          type: 'tool',
          id: call.id,
          name: call.function.name,
          args: call.function.arguments,
          result: null,
          status: 'running',
        });
      }

      // 上一条是 tool → 说明是同一次回答被工具打断后的续写，并进当前消息
      const previous: UIMessage | null = current;
      if (previous !== null && lastRole === 'tool') {
        const merged: UIMessage = { id: previous.id, role: previous.role, parts: [...previous.parts, ...parts] };
        result[result.length - 1] = merged;
        current = merged;
      } else {
        current = { id, role: 'assistant', parts };
        result.push(current);
      }

      lastRole = role;
      continue;
    }

    if (role === 'tool') {
      const toolCallId: string = message.tool_call_id ?? '';
      const content: string = message.content ?? '';
      const target: UIMessage | null = current;
      const partIndex: number = target === null
        ? -1
        : target.parts.findIndex((part: Part) => part.type === 'tool' && part.id === toolCallId);

      if (target !== null && partIndex !== -1) {
        // 回填结果：改字段，不新增 part（与直播路径同一条规则）
        const parts: Part[] = [...target.parts];
        const part: Part | undefined = parts[partIndex];
        if (part !== undefined && part.type === 'tool') {
          parts[partIndex] = { ...part, result: content, status: 'done' };
        }

        const updated: UIMessage = { id: target.id, role: target.role, parts };
        result[result.length - 1] = updated;
        current = updated;
      } else {
        // 孤立结果（找不到父调用）：不丢数据，降级成一条错误消息
        result.push({
          id,
          role: 'assistant',
          parts: [createErrorPart(`工具结果找不到所属调用：${toolCallId || '(缺少 tool_call_id)'}`)],
        });

        current = null;
      }

      lastRole = role;
      continue;
    }

    // reasoning / system 等：Day 3 不处理
    lastRole = role;
  }

  return result;
}

/**
 * 把一条 wire user 消息还原成 parts。
 *
 * 与 `submit()` 组装 user 消息的规则必须一致，否则「发出去再读回来」对不上：
 * - 文字与图片按 `content_parts` 原序排列；
 * - text part 不带 id（直播侧 `createTextPart(text)` 也不带）；
 * - 图片字段做兜底，不能把 undefined 传进 `<img src>`。
 *
 * 只用于 user：图片是用户附件，assistant 的 content_parts 即便含 image 也不还原。
 */
export function buildUserParts(message: WireMessage): Part[] {
  const contentParts = message.content_parts ?? [];

  // 老历史没有 content_parts → 继续用轻量的 content 字段
  if (contentParts.length === 0) {
    const text = message.content ?? '';
    return text === '' ? [] : [createTextPart(text)];
  }

  const parts: Part[] = [];

  contentParts.forEach((item, index) => {
    if (item.type === 'text' && typeof item.text === 'string' && item.text !== '') {
      parts.push(createTextPart(item.text));
      return;
    }

    if (item.type === 'image') {
      parts.push({
        type: 'image',
        url: item.source?.value ?? '',
        filename: item.filename ?? `image-${index + 1}`,
        mimeType: item.source?.mime_type ?? 'image/png',
      });
    }
  });

  // content_parts 里没有能识别的内容（如未来的 online_doc）→ 回退到 content，别丢文字
  if (parts.length === 0) {
    const text = message.content ?? '';
    return text === '' ? [] : [createTextPart(text)];
  }

  return parts;
}

/** 从 wire 消息里提取纯文本（content_parts 的 text 优先，其次 content）。 */
export function extractWireText(message: WireMessage): string {
  const parts = message.content_parts ?? [];
  const textFromParts = parts
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text ?? '')
    .join('');

  if (textFromParts) return textFromParts;
  return message.content ?? '';
}

/** 构造一个文本 part。 */
export function createTextPart(content: string, id?: string): TextPart {
  return id ? { type: 'text', id, content } : { type: 'text', content };
}

/** 构造一个工具调用 part。 */
export function createToolPart(id: string, name: string, result: string, args: string): ToolPart {
  return { type: 'tool', id, name, result, args, status: 'done' };
}

/** 构造一个错误 part。 */
export function createErrorPart(message: string, code?: string): ErrorPart {
  return code ? { type: 'error', message, code } : { type: 'error', message };
}

/** 兼容用：Day 2 里 assistant 消息的 parts 一定以 text 开头，这里给一个安全取值。 */
export function partsOrEmpty(message: UIMessage | undefined): Part[] {
  return message?.parts ?? [];
}

export { createAssistantPlaceholder, isAssistantPlaceholder };

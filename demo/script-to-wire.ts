/**
 * 把 mock 产出的事件数组还原成 wire 消息——`/history` 要返回的形状。
 *
 * 为什么单独抽出来：
 * - 纯函数，能直接单测，不用起 HTTP；
 * - 以后接真实模型时，"provider 的流式响应 → 历史消息"这段逻辑可以照搬这里；
 * - mock 的剧本事件与"历史里长什么样"解耦，避免两边各写一套导致形状不一致。
 *
 * 关键形状（与客户端 aggregateSnapshot 的折叠规则对齐）：
 * - 文本 + 工具调用 = **一条** assistant（content + tool_calls）；
 * - 工具结果是**独立一条** role='tool' 消息；
 * - 工具之后的新文本 = **新的一条** assistant。
 */

import type { WireMessage, WireToolCall } from '../src/transport/types';

/** 只要求具备 type，具体字段按事件类型取（避免和 mock 的事件类型互相耦合）。 */
export interface WireSourceEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * @param events     一条流的事件（RUN_STARTED … RUN_FINISHED）
 * @param idPrefix   生成 wire 消息 id 的前缀，默认 'wire'
 */
export function eventsToWireMessages(events: WireSourceEvent[], idPrefix = 'wire'): WireMessage[] {
  const messages: WireMessage[] = [];
  let text = '';
  let toolCalls: WireToolCall[] = [];
  let sequence = 0;

  const nextId = (): string => {
    sequence += 1;
    return `${idPrefix}_${sequence}`;
  };

  /** 把当前累积的文本与工具调用落成一条 assistant；没有内容就不产生空消息。 */
  const flushAssistant = (): void => {
    if (text === '' && toolCalls.length === 0) return;

    messages.push({
      id: nextId(),
      role: 'assistant',
      ...(text !== '' ? { content: text } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    text = '';
    toolCalls = [];
  };

  for (const event of events) {
    switch (event.type) {
      case 'TEXT_MESSAGE_CONTENT': {
        text += typeof event.delta === 'string' ? event.delta : '';
        break;
      }

      case 'TOOL_CALL_START': {
        // 第一阶段参数为空，后面靠 ARGS 分片补
        toolCalls.push({
          id: String(event.toolCallId ?? ''),
          type: 'function',
          function: { name: String(event.toolCallName ?? ''), arguments: '' },
        });
        break;
      }

      case 'TOOL_CALL_ARGS': {
        const toolCallId = String(event.toolCallId ?? '');
        const call = toolCalls.find(item => item.id === toolCallId);
        if (call) call.function.arguments += typeof event.delta === 'string' ? event.delta : '';
        break;
      }

      case 'TOOL_CALL_RESULT': {
        // 结果必须在 assistant 之后、下一段文本之前：先落 call，再落 tool
        flushAssistant();
        messages.push({
          id: nextId(),
          role: 'tool',
          tool_call_id: String(event.toolCallId ?? ''),
          content: typeof event.content === 'string' ? event.content : '',
        });
        break;
      }

      case 'RUN_FINISHED':
      case 'RUN_ERROR': {
        flushAssistant();
        break;
      }

      default:
        // TEXT_MESSAGE_START/END、RUN_STARTED 等不产生消息内容
        break;
    }
  }

  // 没有 RUN_FINISHED 的流（被截断）也要把已有内容落下来
  flushAssistant();

  return messages;
}

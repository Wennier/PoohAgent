/**
 * 网关接入：请求体组装 + 流式连接编排。
 *
 * 这是 Day 1 的最后一块。它把前面三部分串起来：
 *
 *   buildChatBody(纯函数)  →  fetch  →  parseSseFrames  →  parseAgentEvents  →  Observable
 *
 * 注意 `connectAgentStream` 返回 Observable 而不是 Promise：
 * 一次请求会产出 0~N 个事件，这是"流"，不是"一次结果"。
 */

import type { Observable } from 'rxjs';
import { from } from 'rxjs';

import { parseAgentEvents } from './event-parser';
import { parseSseFrames } from './sse-parser';
import type { AgentEvent, ChatRequestBody, ConnectInput } from './types';

/** 默认端点。用相对路径，交给 dev server 的 proxy 转发；生产环境同域直连。 */
const DEFAULT_CHAT_URL = '/api/v6/agentgateway/chat';

/**
 * 组装 /chat 的请求体（纯函数，先写它并单测，不要碰网络）。
 *
 * @param input 连接参数
 * @returns 符合后端协议的请求体
 *
 * 四个必须对齐的点（顺序就是踩坑概率从高到低）：
 * 1. `thread_id` 新会话是**空字符串**，不是 undefined、不是省略字段
 * 2. `contexts` 是数组且**只填一个元素**（网关只取第一个）
 * 3. `contexts[0].params` 是 **JSON 字符串**，不是对象
 * 4. `messages` 传全量历史，不是只传最后一条
 */
export function buildChatBody(input: ConnectInput): ChatRequestBody {
  // 步骤 1：const { threadId, messages, channel, language, params } = input
  // 步骤 2：组装 contexts —— 注意 params 要 JSON.stringify
  //         对象合并顺序建议：先 params 再显式字段，避免 channel 被参数里的同名字段覆盖
  // 步骤 3：return { thread_id: threadId, messages, contexts: [ctx] }
  // TODO(wendy): 实现上面三步
  const { threadId, messages, channel, language, params } = input;
  const ctx = { channel, language, params: JSON.stringify(params) };
  return {
    thread_id: threadId,
    messages,
    contexts: [ctx],
  };
}

/**
 * 一次 /chat 的完整流式过程（生成器形态，便于逐步调试）。
 *
 * @param input 连接参数
 * @returns 异步生成器，逐条产出 AG-UI 事件
 *
 * 边界：
 * - 先判 `res.ok`：非 2xx 直接抛（不要把错误响应体喂给解析器）
 * - `res.body` 可能为 null（极少数环境），要显式判断并抛错
 * - 请求头要带 `Content-Type: application/json` 与 `Accept: text/event-stream`
 * - `signal` 必须透传给 fetch，否则「中止」只能断解析、断不了请求
 * - 用户中止时 fetch 会抛 `AbortError`（DOMException，name === 'AbortError'），
 *   它必须原样抛出去，由上层区分"用户取消"与"网络错误"
 */
async function* streamEvents(input: ConnectInput): AsyncGenerator<AgentEvent, void, void> {
  // 步骤 1：const body = buildChatBody(input)
  // 步骤 2：const res = await fetch(input.url ?? DEFAULT_CHAT_URL, {
  //           method: 'POST', headers: {…}, body: JSON.stringify(body), signal: input.signal })
  // 步骤 3：if (!res.ok) throw new Error(`/chat failed: ${res.status}`)
  // 步骤 4：if (!res.body) throw new Error('响应体为空')
  // 步骤 5：for await (const event of parseAgentEvents(parseSseFrames(res.body))) yield event
  // TODO(wendy): 实现上面五步

  const body = buildChatBody(input);
  const res = await fetch(input.url ?? DEFAULT_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: input.signal,
  });
  if (!res.ok) throw new Error(`/chat failed: ${res.status}`);
  if (!res.body) throw new Error('响应体为空');

  const frames = parseSseFrames(res.body);
  const events = parseAgentEvents(frames);
  for await (const event of events) {
    yield event;
  }
}

/**
 * 连接 Agent 网关，返回事件流。
 *
 * 已给好，不用改：把生成器包成 Observable 就够了。
 * rxjs 的 from() 原生支持 AsyncIterable，不需要手写 new Observable。
 */
export function connectAgentStream(input: ConnectInput): Observable<AgentEvent> {
  return from(streamEvents(input));
}

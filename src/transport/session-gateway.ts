/**
 * 会话列表与历史接口（Day 5）。
 *
 * 与 `agent-gateway.ts` 分开放：那边是"流式 /chat"，这里是"普通 JSON 请求"，
 * 混在一起会让 URL、错误处理、信号传递的语义互相污染。
 *
 * `fetchImpl` 可注入：单测不碰网络，也不依赖全局 fetch 的存在。
 */

import type { HistoryResponse, RuntimesResponse } from './types';

export interface SessionGatewayOptions {
  /** 接口地址；demo 里由 vite proxy 转发。 */
  url: string;
  signal?: AbortSignal;
  /** 可注入的 fetch，默认用全局实现。 */
  fetchImpl?: typeof fetch;
}

/** 所有会话接口共用的请求 + 错误归一。 */
async function send(
  options: SessionGatewayOptions,
  method: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const request = options.fetchImpl ?? fetch;

  return request(options.url, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;

  // 把服务端错误码带出来：上层要按 404 回退到别的会话、按 400 提示参数问题
  const detail = await response.text().catch(() => '');
  throw new Error(
    `请求失败（HTTP ${response.status}）${detail === '' ? '' : `：${detail.slice(0, 300)}`}`,
  );
}

async function postJson<T>(options: SessionGatewayOptions, body: Record<string, unknown>): Promise<T> {
  const response = await send(options, 'POST', body);
  await assertOk(response);

  return (await response.json()) as T;
}

/** 拉会话列表（分页）。不传 cursor 就是第一页。 */
export function fetchRuntimes(
  options: SessionGatewayOptions & { cursor?: string; limit?: number },
): Promise<RuntimesResponse> {
  return postJson<RuntimesResponse>(options, {
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
}

/** 拉某个会话的历史消息（扁平 wire 格式，交给 aggregateSnapshot 归约）。 */
export function fetchHistory(
  options: SessionGatewayOptions & { threadId: string; cursor?: string; limit?: number },
): Promise<HistoryResponse> {
  return postJson<HistoryResponse>(options, {
    thread_id: options.threadId,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
}

/**
 * 删除会话（本地 + 服务端）。
 *
 * 服务端返回 404 表示"本来就没有了"——调用方可以当成删除成功处理，
 * 这里只负责把状态码原样抛成错误，不做业务判断。
 */
export async function deleteRuntime(
  options: SessionGatewayOptions & { threadId: string },
): Promise<void> {
  const base = options.url.replace(/\/+$/, '');
  const response = await send(
    { ...options, url: `${base}/${encodeURIComponent(options.threadId)}` },
    'DELETE',
  );
  await assertOk(response);
}

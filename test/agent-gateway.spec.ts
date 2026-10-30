/**
 * agent-gateway 的非 2xx 分支。
 *
 * 这个文件此前**一个测试都没有** —— 而它是唯一做 fetch、唯一丢 `Retry-After` 的地方。
 * 这里只测「非 2xx 变成什么」，不测流解析（那是 parse-sse / parse-frame 的职责）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AgentHttpError, connectAgentStream } from '../src/transport/agent-gateway';
import type { ConnectInput } from '../src/transport/types';

const BASE: ConnectInput = {
  threadId: '',
  messages: [],
  channel: 'doc',
  url: 'http://localhost/chat',
  signal: new AbortController().signal,
};

/** 把 fetch 换成一次性桩，函数结束后还原（不能污染其他测试）。 */
async function withFetch(
  response: Response,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** 订阅到出错为止，把错误本身拿出来断言。 */
function firstError(): Promise<unknown> {
  return new Promise(resolve => {
    connectAgentStream(BASE).subscribe({ error: resolve });
  });
}

describe('agent-gateway · 非 2xx', () => {
  it('429 抛 AgentHttpError，并把 Retry-After 解析成毫秒', async () => {
    const response = new Response('{"error":{"code":"http_429"}}', {
      status: 429,
      headers: { 'Retry-After': '3' },
    });

    const error = await withFetch(response, firstError);

    assert.ok(error instanceof AgentHttpError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 3000);
  });

  it('没有 Retry-After 时是 null，不是 0', async () => {
    const error = await withFetch(new Response('', { status: 500 }), firstError);

    assert.ok(error instanceof AgentHttpError);
    assert.equal(error.status, 500);
    assert.equal(error.retryAfterMs, null);
  });

  it('文案保持原样，页面现象不因这次改动变化', async () => {
    const error = await withFetch(new Response('', { status: 500 }), firstError);

    assert.equal((error as Error).message, '/chat failed: 500');
  });
});

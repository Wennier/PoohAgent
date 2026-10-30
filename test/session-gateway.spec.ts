/**
 * session-gateway 单测：只验证「请求长什么样」与「响应怎么解析」。
 *
 * 用假 fetch，不起服务：这一层的职责就是拼请求 + 归一错误，
 * 真正的接口连通性交给 curl 验收。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deleteRuntime, fetchHistory, fetchRuntimes } from '../src/transport/session-gateway';
import type { HistoryResponse, RuntimesResponse } from '../src/transport/types';

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

/** 造一个记录调用的假 fetch。 */
function createFetch(payload: unknown, status = 200): {
  fetchImpl: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: String(init?.method ?? 'GET'),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    });

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as typeof fetch;

  return { fetchImpl, calls };
}

describe('fetchRuntimes', () => {
  it('用 POST 打列表接口，不带游标时 body 为空对象', async () => {
    const list: RuntimesResponse = { data: [], next_cursor: '' };
    const { fetchImpl, calls } = createFetch(list);

    const result = await fetchRuntimes({ url: '/api/v6/agentgateway/runtimes', fetchImpl });

    assert.deepEqual(result, list);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, {});
  });

  it('游标与 limit 原样透传', async () => {
    const { fetchImpl, calls } = createFetch({ data: [], next_cursor: '' });

    await fetchRuntimes({
      url: '/runtimes',
      cursor: '1700000000000_thread_1',
      limit: 20,
      fetchImpl,
    });

    assert.deepEqual(calls[0].body, { cursor: '1700000000000_thread_1', limit: 20 });
  });
});

describe('fetchHistory', () => {
  it('把 thread_id 放进 body，并解析 messages', async () => {
    const history: HistoryResponse = {
      messages: [{ id: 'w1', role: 'user', content: '你好' }],
      display_state: 'ready',
      next_cursor: '',
    };
    const { fetchImpl, calls } = createFetch(history);

    const result = await fetchHistory({
      url: '/api/v6/agentgateway/history',
      threadId: 'thread_1',
      fetchImpl,
    });

    assert.equal(result.messages.length, 1);
    assert.deepEqual(calls[0].body, { thread_id: 'thread_1' });
  });

  it('非 2xx 抛错，并带上 HTTP 状态', async () => {
    const { fetchImpl } = createFetch({ error: { code: 'thread_not_found' } }, 404);

    await assert.rejects(
      () => fetchHistory({ url: '/history', threadId: 'gone', fetchImpl }),
      /HTTP 404/,
    );
  });

  it('把 AbortSignal 透传给 fetch', async () => {
    const { fetchImpl, calls } = createFetch({ messages: [], display_state: 'ready', next_cursor: '' });
    const controller = new AbortController();

    await fetchHistory({ url: '/history', threadId: 't1', signal: controller.signal, fetchImpl });

    assert.equal(calls[0].signal, controller.signal);
  });
});

describe('deleteRuntime', () => {
  it('用 DELETE 打 /runtimes/<id>，路径做 URL 编码', async () => {
    const { fetchImpl, calls } = createFetch(undefined, 204);

    await deleteRuntime({ url: '/api/v6/agentgateway/runtimes', threadId: 'thread_1', fetchImpl });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].url, '/api/v6/agentgateway/runtimes/thread_1');
    assert.deepEqual(calls[0].body, {}, 'DELETE 不带 body');
  });

  it('base url 末尾有斜杠也不会拼出双斜杠', async () => {
    const { fetchImpl, calls } = createFetch(undefined, 204);

    await deleteRuntime({ url: '/runtimes/', threadId: 't1', fetchImpl });

    assert.equal(calls[0].url, '/runtimes/t1');
  });

  it('404 抛错（由调用方判断"本来就没有"）', async () => {
    const { fetchImpl } = createFetch({ error: { code: 'thread_not_found' } }, 404);

    await assert.rejects(() => deleteRuntime({ url: '/runtimes', threadId: 'gone', fetchImpl }), /HTTP 404/);
  });
});

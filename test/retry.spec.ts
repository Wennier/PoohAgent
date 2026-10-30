/**
 * 自动重试包装器（L1）。
 *
 * 用注入的 `schedule` 把"等待"换成立即完成，所以这些用例不花真实时间。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Observable, of, throwError, toArray, firstValueFrom } from 'rxjs';

import { AgentHttpError } from '../src/transport/agent-gateway';
import { withRetry } from '../src/transport/retry';
import type { AgentEvent, ConnectInput } from '../src/transport/types';

type Attempt = 'ok' | 'http500' | 'http429' | 'abort' | 'emit-then-fail';

const INPUT: ConnectInput = {
  threadId: 'thread_1',
  messages: [],
  channel: 'doc',
  signal: new AbortController().signal,
};

const OK_EVENT: AgentEvent = { type: 'RUN_FINISHED' };

interface Harness {
  run: () => Promise<AgentEvent[]>;
  calls: () => number;
  delays: number[];
}

/** 按脚本依次返回每次尝试的结果，同时记录"等了多少毫秒"。 */
function harness(script: Attempt[], shouldRetry = (): boolean => true): Harness {
  let call = 0;
  const delays: number[] = [];

  const connect = (): Observable<AgentEvent> => {
    const kind = script[call] ?? 'http500';
    call += 1;

    switch (kind) {
      case 'ok':
        return of(OK_EVENT);

      case 'abort':
        return throwError(() => new DOMException('aborted', 'AbortError'));

      case 'http429':
        return throwError(() => new AgentHttpError(429, 3000));

      case 'emit-then-fail':
        return new Observable<AgentEvent>(subscriber => {
          subscriber.next({ type: 'RUN_STARTED', threadId: 'thread_1' });
          subscriber.error(new TypeError('terminated'));
        });

      default:
        return throwError(() => new AgentHttpError(500, null));
    }
  };

  const wrapped = withRetry(connect, {
    shouldRetry,
    random: () => 1,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    schedule: delayMs => {
      delays.push(delayMs);
      return of(delayMs);
    },
  });

  return {
    run: () => firstValueFrom(wrapped(INPUT).pipe(toArray())),
    calls: () => call,
    delays,
  };
}

describe('withRetry · 什么时候重试', () => {
  it('一次成功：不重试', async () => {
    const h = harness(['ok']);

    assert.deepEqual(await h.run(), [OK_EVENT]);
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.delays, []);
  });

  it('没收到事件就失败：重试一次后成功', async () => {
    const h = harness(['http500', 'ok']);

    assert.deepEqual(await h.run(), [OK_EVENT]);
    assert.equal(h.calls(), 2);
    assert.deepEqual(h.delays, [100], '第 0 次重试：min(1000, 100*2^0) * 1');
  });

  it('已经吐过事件再失败：不重试（否则输出被重放）', async () => {
    const h = harness(['emit-then-fail', 'ok']);

    await assert.rejects(h.run(), TypeError);
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.delays, []);
  });

  it('用户取消：即使谓词说可以重试也不重发', async () => {
    const h = harness(['abort', 'ok'], () => true);

    await assert.rejects(h.run(), /abort/i);
    assert.equal(h.calls(), 1);
  });

  it('谓词说不可重试：一次就放弃', async () => {
    const h = harness(['http500', 'ok'], () => false);

    await assert.rejects(h.run(), AgentHttpError);
    assert.equal(h.calls(), 1);
  });

  it('一直失败：最多 1 + 2 次，然后把最后一个错误抛出去', async () => {
    const h = harness(['http500', 'http500', 'http500', 'http500']);

    await assert.rejects(h.run(), AgentHttpError);
    assert.equal(h.calls(), 3);
    assert.deepEqual(h.delays, [100, 200], '指数退避：100 → 200');
  });

  it('Retry-After 优先于指数退避', async () => {
    const h = harness(['http429', 'ok']);

    assert.deepEqual(await h.run(), [OK_EVENT]);
    assert.deepEqual(h.delays, [3000], '服务端说等 3 秒就等 3 秒');
  });
});

describe('withRetry · onRetry 回执', () => {
  it('每次重试都回调一次，带第几次与等待时长', async () => {
    const seen: Array<{ retryIndex: number; maxRetries: number; delayMs: number }> = [];

    const connect = (() => {
      let call = 0;
      return (): Observable<AgentEvent> => {
        call += 1;
        return call < 3 ? throwError(() => new AgentHttpError(500, null)) : of(OK_EVENT);
      };
    })();

    const wrapped = withRetry(connect, {
      shouldRetry: () => true,
      random: () => 1,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      schedule: () => of(0),
      onRetry: info => seen.push(info),
    });

    await firstValueFrom(wrapped(INPUT).pipe(toArray()));

    assert.deepEqual(
      seen.map(({ retryIndex, maxRetries, delayMs }) => ({ retryIndex, maxRetries, delayMs })),
      [
        { retryIndex: 0, maxRetries: 2, delayMs: 100 },
        { retryIndex: 1, maxRetries: 2, delayMs: 200 },
      ],
    );
  });
});

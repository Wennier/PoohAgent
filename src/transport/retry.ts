/**
 * 自动重试（L1）：只重试「还没吐事件」的请求。
 *
 * 这一层只负责**怎么重试**，不负责**该不该重试**——判断依据是错误分类
 *（`agent/error-classify.ts`），而 transport 不该认识业务码，所以谓词由调用方注入。
 *
 * 三条硬约束：
 * 1. **收到过任何事件就不再重发**。重发会让服务端重跑一遍，输出被重复交付；
 *    协议里没有序号，客户端无法去重（见 `ui-transform` 的 `TEXT_MESSAGE_START` 注释）。
 * 2. **用户取消绝不重试**，哪怕谓词说可以——重发等于无视用户刚做的操作。
 * 3. **有 `Retry-After` 就听它的**。无视服务端让你等多久，是重试风暴的常见来源。
 */

import { defer, throwError, timer, type Observable } from 'rxjs';
import { catchError, mergeMap, tap } from 'rxjs';

import { AgentHttpError } from './agent-gateway';
import type { AgentEvent, ConnectInput } from './types';

export interface RetryOptions {
  /** 首次之后的**重试**次数；默认 2（最多 3 次尝试）。 */
  maxRetries?: number;
  /** 退避基数：第 n 次重试等 `min(maxDelayMs, baseDelayMs * 2^n) * jitter`。 */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 注入随机源，测试里可固定。 */
  random?: () => number;
  /** 注入"等待"：默认 `timer`，测试里换成 `of(ms)` 立即完成。 */
  schedule?: (delayMs: number) => Observable<unknown>;
  /**
   * 每次决定重试时回调，给 UI 显示「正在重试 1/2」。
   *
   * 放在这里而不是让 UI 猜：只有这一层知道"现在是第几次、还要等多久"。
   */
  onRetry?: (info: { retryIndex: number; maxRetries: number; delayMs: number; error: unknown }) => void;
  /**
   * 该不该重试。第二个参数是**本次尝试**是否已经收到过事件。
   *
   * 必须由调用方提供：传输层不知道哪些错误值得重试。
   */
  shouldRetry: (error: unknown, receivedEvent: boolean) => boolean;
}

/** 按 name 判，不用 `instanceof DOMException`：Node 与浏览器抛出的类型不一致。 */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** 退避：服务端给了 `Retry-After` 就用它，否则指数退避 + jitter。 */
function nextDelayMs(
  error: unknown,
  retryIndex: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  if (error instanceof AgentHttpError && error.retryAfterMs !== null) {
    return error.retryAfterMs;
  }

  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** retryIndex);
  return Math.round(ceiling * random());
}

/**
 * 给一个 connect 套上自动重试。
 *
 * @returns 与 `connect` 同签名的新函数；重试耗尽后把**最后一个**错误原样抛出
 */
export function withRetry(
  connect: (input: ConnectInput) => Observable<AgentEvent>,
  options: RetryOptions,
): (input: ConnectInput) => Observable<AgentEvent> {
  const {
    maxRetries = 2,
    baseDelayMs = 400,
    maxDelayMs = 8000,
    random = Math.random,
    schedule = timer,
    shouldRetry,
    onRetry,
  } = options;

  return input =>
    defer(() => {
      /** 第 `retryIndex` 次尝试（0 = 首次）。`receivedEvent` 是每次尝试独立的状态。 */
      const attempt = (retryIndex: number): Observable<AgentEvent> => {
        let receivedEvent = false;

        return connect(input).pipe(
          tap(() => {
            receivedEvent = true;
          }),
          catchError(error => {
            const giveUp = (): Observable<never> => throwError(() => error);

            if (isAbort(error) || input.signal.aborted) return giveUp();
            if (receivedEvent) return giveUp();
            if (retryIndex >= maxRetries) return giveUp();
            if (!shouldRetry(error, receivedEvent)) return giveUp();

            const delayMs = nextDelayMs(error, retryIndex, baseDelayMs, maxDelayMs, random);

            onRetry?.({ retryIndex, maxRetries, delayMs, error });

            return schedule(delayMs).pipe(mergeMap(() => attempt(retryIndex + 1)));
          }),
        );
      };

      return attempt(0);
    });
}

/**
 * 错误分类（异常通道）：把抛出来的失败变成「一句话 + 两个重试判据」。
 *
 * - `query`  请求没建立（连接失败 / 非 2xx）
 * - `stream` 流已经开始、中途断了
 * - `abort`  用户自己取消 —— **不是错误**
 *
 * `run` 类（RUN_ERROR）走事件通道、不抛异常，归 classifyRunError。
 *
 * 两个重试判据不能合并：`autoRetryable` 是传输层的（只重试还没吐事件的请求），
 * `manualRetryable` 是 UI 的（按钮出不出现）。混用会让「未登录」也长出重试按钮。
 */

import { AgentHttpError } from '../transport/agent-gateway';

export type ErrorKind = 'query' | 'stream' | 'run' | 'abort';

export interface ClassifiedError {
  kind: ErrorKind;
  /** 业务码 / HTTP 状态码；拿不到就不填 */
  code?: string;
  /** 给用户看的一句话 */
  text: string;
  /** 传输层可以自动重发吗 */
  autoRetryable: boolean;
  /** UI 该不该给「重试」按钮 */
  manualRetryable: boolean;
}

/** 可自动重试的状态：408/409/429 没执行过；5xx 靠幂等键兜底。 */
const RETRYABLE_STATUS = new Set([408, 409, 429]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

/** 不用 `instanceof DOMException`：Node 与浏览器抛出来的类型不完全一致，按 name 更稳。 */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * 分类一个抛出来的错误。
 *
 * @param options.receivedEvent 本次尝试是否已经收到过事件——它决定「流有没有开始」，
 *        也就决定了是 `query` 还是 `stream`。生产者是 controller 里订阅 `next` 的那个布尔值。
 */
export function classifyThrown(error: unknown, options: { receivedEvent: boolean }): ClassifiedError {
  if (isAbortError(error)) {
    return { kind: 'abort', text: '已取消', autoRetryable: false, manualRetryable: false };
  }

  if (error instanceof AgentHttpError) {
    return {
      kind: 'query',
      code: String(error.status),
      text: `请求失败（${error.status}）`,
      // 已经吐过事件就不再自动重发：重发等于重放输出
      autoRetryable: !options.receivedEvent && isRetryableStatus(error.status),
      manualRetryable: true,
    };
  }

  // 没有状态码 = 连接级失败（浏览器这里是 `TypeError: Failed to fetch`）。
  // 兜底代价：若其实是我们自己的代码 bug，也会白试两次——两害相权取小。
  return options.receivedEvent
    ? { kind: 'stream', text: '回答中断了，可以重试这一轮', autoRetryable: false, manualRetryable: true }
    : { kind: 'query', text: '网络连接失败', autoRetryable: true, manualRetryable: true };
}

/**
 * 业务码 → 文案与处置。
 *
 * 只有限流给「重试」：未登录、无权限、积分不足重试一次，结果一模一样，
 * 给按钮等于让用户白等。这一列是产品判断，不是技术判断，所以要显式写出来。
 */
const RUN_ERROR_RULES: Record<string, { text: string; manualRetryable: boolean }> = {
  '439902': { text: '登录已过期，请重新登录', manualRetryable: false },
  '439903': { text: '没有权限访问该内容', manualRetryable: false },
  '439906': { text: '请求太频繁，请稍后再试', manualRetryable: true },
  '439907': { text: '积分不足，暂时无法生成', manualRetryable: false },
};

/**
 * 分类 RUN_ERROR。它走事件通道、不抛异常，所以单独一个入口。
 *
 * `autoRetryable` 恒为 false：整轮自动重跑要重花一次 token、重跑一遍工具、
 * 而且答案会变（6-1 方案 L2 明确不做）。"限流可重试"指的是**手动**重试。
 *
 * 未知码不猜文案，退回服务端 message，但仍给手动重试（原因不明时重试不亏）。
 */
export function classifyRunError(event: { message?: string; code?: string }): ClassifiedError {
  const rule = event.code ? RUN_ERROR_RULES[event.code] : undefined;

  return {
    kind: 'run',
    ...(event.code ? { code: event.code } : {}),
    text: rule?.text ?? event.message ?? '生成失败',
    autoRetryable: false,
    manualRetryable: rule?.manualRetryable ?? true,
  };
}

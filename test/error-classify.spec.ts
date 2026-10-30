/**
 * 错误分类（异常通道）。
 *
 * 一张表覆盖七种输入，比七个 `it` 更好读——分类器本质就是一张判定表。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyRunError, classifyThrown, type ClassifiedError } from '../src/agent/error-classify';
import { AgentHttpError } from '../src/transport/agent-gateway';

const http = (status: number): AgentHttpError => new AgentHttpError(status, null);

describe('classifyThrown · 四类判定与两个重试判据', () => {
  const cases: ReadonlyArray<{
    name: string;
    error: unknown;
    receivedEvent: boolean;
    expect: Partial<ClassifiedError>;
  }> = [
    // 用户取消不是错误：不给自动重试，也不给按钮
    {
      name: 'abort',
      error: new DOMException('aborted', 'AbortError'),
      receivedEvent: false,
      expect: { kind: 'abort', autoRetryable: false, manualRetryable: false },
    },
    // 429 且没吐事件 → 可以自动重发
    { name: '429 未吐事件', error: http(429), receivedEvent: false, expect: { kind: 'query', autoRetryable: true } },
    // 429 但已经吐过事件 → 自动重发会重放输出
    { name: '429 已吐事件', error: http(429), receivedEvent: true, expect: { kind: 'query', autoRetryable: false } },
    // 401 是永久失败：自动重试没意义，但手动重试仍可以给
    {
      name: '401',
      error: http(401),
      receivedEvent: false,
      expect: { kind: 'query', autoRetryable: false, manualRetryable: true },
    },
    { name: '500', error: http(500), receivedEvent: false, expect: { kind: 'query', autoRetryable: true } },
    // 连接级失败：没吐事件 = 请求没建立
    {
      name: '连接失败',
      error: new TypeError('Failed to fetch'),
      receivedEvent: false,
      expect: { kind: 'query', autoRetryable: true },
    },
    // 同样是连接级异常，但已经吐过事件 = 流中途断
    {
      name: '流中断',
      error: new TypeError('terminated'),
      receivedEvent: true,
      expect: { kind: 'stream', autoRetryable: false, manualRetryable: true },
    },
  ];

  for (const { name, error, receivedEvent, expect } of cases) {
    it(name, () => {
      const actual = classifyThrown(error, { receivedEvent });

      assert.equal(actual.kind, expect.kind);
      if (expect.autoRetryable !== undefined) assert.equal(actual.autoRetryable, expect.autoRetryable);
      if (expect.manualRetryable !== undefined) assert.equal(actual.manualRetryable, expect.manualRetryable);
      assert.ok(actual.text.length > 0, '文案不能为空');
    });
  }

  it('HTTP 状态码进 code，方便渲染层分级', () => {
    assert.equal(classifyThrown(http(429), { receivedEvent: false }).code, '429');
  });
});

describe('classifyRunError · 业务码决定「文案 + 是否给重试」', () => {
  const cases: ReadonlyArray<{ code: string; text: string; manualRetryable: boolean }> = [
    { code: '439902', text: '登录已过期，请重新登录', manualRetryable: false },
    { code: '439903', text: '没有权限访问该内容', manualRetryable: false },
    // 只有限流值得重试
    { code: '439906', text: '请求太频繁，请稍后再试', manualRetryable: true },
    { code: '439907', text: '积分不足，暂时无法生成', manualRetryable: false },
  ];

  for (const { code, text, manualRetryable } of cases) {
    it(`${code} → ${text}`, () => {
      const actual = classifyRunError({ code, message: '服务端原始文案' });

      assert.equal(actual.kind, 'run');
      assert.equal(actual.code, code);
      // 业务码有文案时以我们的文案为准，不信服务端那句话
      assert.equal(actual.text, text);
      assert.equal(actual.manualRetryable, manualRetryable);
      assert.equal(actual.autoRetryable, false, '整轮不自动重跑');
    });
  }

  it('未知码：不猜文案，退回服务端 message，但仍给手动重试', () => {
    const actual = classifyRunError({ code: '999999', message: '服务异常' });

    assert.equal(actual.text, '服务异常');
    assert.equal(actual.code, '999999');
    assert.equal(actual.manualRetryable, true);
  });

  it('既没有码也没有 message → 兜底文案', () => {
    assert.equal(classifyRunError({}).text, '生成失败');
  });
});


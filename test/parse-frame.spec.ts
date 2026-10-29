/**
 * parseFrame / parseAgentEvents 单测。
 *
 * 核心契约：
 * - 解析失败返回 null，**不抛错**
 * - 未知 type 必须原样透传（不能被过滤，否则 Day 3 接工具调用会"收不到事件"）
 * - 坏帧被跳过后，后续帧仍要正常产出（一帧坏不能毁掉整条流）
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAgentEvents, parseFrame } from '../src/transport/event-parser';

describe('parseFrame', () => {
  it('合法 JSON 解析成对象', () => {
    const event = parseFrame('{"type":"RUN_STARTED","threadId":"t1"}');

    assert.deepEqual(event, { type: 'RUN_STARTED', threadId: 't1' });
  });

  it('空串 / 纯空白返回 null', () => {
    assert.equal(parseFrame(''), null);
    assert.equal(parseFrame('   \n  '), null);
  });

  it('非法 JSON 返回 null 而不是抛错', () => {
    assert.equal(parseFrame('{"type":'), null);
    assert.equal(parseFrame('not json'), null);
  });

  it('JSON 合法但不是对象时返回 null', () => {
    assert.equal(parseFrame('"字符串"'), null);
    assert.equal(parseFrame('123'), null);
    assert.equal(parseFrame('null'), null);
    assert.equal(parseFrame('[1,2,3]'), null);
  });

  it('缺少 type 或 type 不是字符串时返回 null', () => {
    assert.equal(parseFrame('{"threadId":"t1"}'), null);
    assert.equal(parseFrame('{"type":123}'), null);
  });

  it('未知 type 必须原样透传', () => {
    const event = parseFrame('{"type":"SOMETHING_NEW","x":1}');
    assert.deepEqual(event, { type: 'SOMETHING_NEW', x: 1 });
  });
});

describe('parseAgentEvents', () => {
  async function* fromArray(items: string[]): AsyncGenerator<string, void, void> {
    for (const item of items) yield item;
  }

  async function collect<T>(gen: AsyncGenerator<T, void, void>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of gen) out.push(item);
    return out;
  }

  it('坏帧被跳过，好帧继续产出', async () => {
    const events = await collect(parseAgentEvents(fromArray([
      '{"type":"RUN_STARTED","threadId":"t1"}',
      '这不是 JSON',
      '{"type":"RUN_FINISHED","threadId":"t1"}',
    ])));

    assert.deepEqual(events, [
      { type: 'RUN_STARTED', threadId: 't1' },
      { type: 'RUN_FINISHED', threadId: 't1' },
    ]);
  });

  it('空序列不产出事件，也不抛错', async () => {
    await assert.doesNotReject(async () => {
      const events = await collect(parseAgentEvents(fromArray([])));
      assert.deepEqual(events, []);
    });
  });

  it('正常结束后不得抛错（守住遗留的占位 throw）', async () => {
    await assert.doesNotReject(async () => {
      await collect(parseAgentEvents(fromArray(['{"type":"RUN_STARTED"}'])));
    });
  });
});

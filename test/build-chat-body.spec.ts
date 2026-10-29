/**
 * buildChatBody 单测（纯函数）。
 *
 * 覆盖协议文档里最容易写错的四个点：
 * 1. thread_id 新会话是空字符串，不能变 undefined
 * 2. contexts 只填一个元素
 * 3. contexts[0].params 是 JSON **字符串**
 * 4. messages 原样透传（全量历史）
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildChatBody } from '../src/transport/agent-gateway';
import type { ConnectInput } from '../src/transport/types';

function makeInput(patch: Partial<ConnectInput> = {}): ConnectInput {
  return {
    threadId: '',
    messages: [{ role: 'user', content: '你好' }],
    channel: 'doc',
    signal: new AbortController().signal,
    ...patch,
  };
}

describe('buildChatBody', () => {
  it('新会话的 thread_id 是空字符串（不是 undefined、不是省略字段）', () => {
    const body = buildChatBody(makeInput());

    assert.equal(body.thread_id, '');
    assert.ok('thread_id' in body);
  });

  it('已有会话的 thread_id 原样透传', () => {
    const body = buildChatBody(makeInput({ threadId: 'thread_123' }));

    assert.equal(body.thread_id, 'thread_123');
  });

  it('contexts 只有一个元素，且 channel 正确', () => {
    const body = buildChatBody(makeInput({ channel: 'sheet' }));

    assert.equal(body.contexts.length, 1);
    assert.equal(body.contexts[0].channel, 'sheet');
  });

  it('contexts[0].params 是 JSON 字符串，不是对象', () => {
    const body = buildChatBody(makeInput({ params: { fileId: 'f1', hiddenContext: 'x' } }));

    assert.equal(typeof body.contexts[0].params, 'string');
    assert.deepEqual(JSON.parse(body.contexts[0].params!), {
      fileId: 'f1',
      hiddenContext: 'x',
    });
  });

  it('messages 全量透传，不做裁剪', () => {
    const messages = [
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '第一轮回复' },
      { role: 'user', content: '第二轮' },
    ];
    const body = buildChatBody(makeInput({ messages }));

    assert.equal(body.messages.length, 3);
    assert.deepEqual(body.messages, messages);
  });

  it('未传 params 时不崩溃', () => {
    const body = buildChatBody(makeInput());
    assert.doesNotThrow(() => JSON.stringify(body));
  });

  it('整体可被 JSON.stringify（真实请求要序列化它）', () => {
    const body = buildChatBody(makeInput({ params: { a: 1 } }));
    const wire = JSON.parse(JSON.stringify(body));

    assert.equal(wire.thread_id, '');
    assert.equal(wire.contexts[0].channel, 'doc');
    assert.equal(typeof wire.contexts[0].params, 'string');
  });
});

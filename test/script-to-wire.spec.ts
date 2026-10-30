/**
 * eventsToWireMessages：mock 流 → 历史 wire 消息。
 *
 * 形状必须和客户端 aggregateSnapshot 的折叠规则对齐，否则「刷新后同一条回答
 * 长成两条」这种低级 bug 一定会出现。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eventsToWireMessages } from '../demo/script-to-wire';

function text(delta: string, messageId = 'm1'): { type: string; [key: string]: unknown } {
  return { type: 'TEXT_MESSAGE_CONTENT', messageId, delta };
}

describe('eventsToWireMessages · 纯文本', () => {
  it('把 CONTENT 分片拼成一条 assistant 消息', () => {
    const messages = eventsToWireMessages([
      { type: 'RUN_STARTED' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
      text('你'),
      text('好'),
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      { type: 'RUN_FINISHED' },
    ]);

    assert.deepEqual(messages, [{ id: 'wire_1', role: 'assistant', content: '你好' }]);
  });

  it('空流不产生消息', () => {
    assert.deepEqual(eventsToWireMessages([{ type: 'RUN_STARTED' }, { type: 'RUN_FINISHED' }]), []);
  });

  it('流被截断（没有 RUN_FINISHED）也要落下已有文本', () => {
    const messages = eventsToWireMessages([
      { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
      text('半截'),
    ]);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, '半截');
  });

  it('RUN_ERROR 前的内容保留（错误不吞已生成文本）', () => {
    const messages = eventsToWireMessages([
      { type: 'TEXT_MESSAGE_CONTENT', delta: '说到一半' },
      { type: 'RUN_ERROR', message: '模型超时' },
    ]);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, '说到一半');
  });
});

describe('eventsToWireMessages · 工具调用', () => {
  it('文本 + 工具 = 一条 assistant（content + tool_calls），结果是独立 tool 消息', () => {
    const messages = eventsToWireMessages([
      { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
      text('我先查一下'),
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'webSearch' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"query":' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '"北京"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
      { type: 'TOOL_CALL_RESULT', toolCallId: 'c1', content: '{"temp":28}' },
      text('北京今天晴'),
      { type: 'RUN_FINISHED' },
    ]);

    assert.equal(messages.length, 3);
    assert.deepEqual(messages[0], {
      id: 'wire_1',
      role: 'assistant',
      content: '我先查一下',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'webSearch', arguments: '{"query":"北京"}' } },
      ],
    });
    assert.deepEqual(messages[1], {
      id: 'wire_2',
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"temp":28}',
    });
    assert.deepEqual(messages[2], { id: 'wire_3', role: 'assistant', content: '北京今天晴' });
  });

  it('同一条 assistant 里的多个 tool_calls 各自落到一条 tool 消息', () => {
    const messages = eventsToWireMessages([
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'webSearch' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{}' },
      { type: 'TOOL_CALL_START', toolCallId: 'c2', toolCallName: 'calculator' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c2', delta: '{"a":1}' },
      { type: 'TOOL_CALL_RESULT', toolCallId: 'c1', content: 'r1' },
      { type: 'TOOL_CALL_RESULT', toolCallId: 'c2', content: 'r2' },
      { type: 'RUN_FINISHED' },
    ]);

    assert.equal(messages[0].tool_calls?.length, 2);
    assert.deepEqual(
      messages.filter(message => message.role === 'tool').map(message => message.tool_call_id),
      ['c1', 'c2'],
    );
  });

  it('只有工具、没有文本时仍是一条 assistant（不塞空 content）', () => {
    const messages = eventsToWireMessages([
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'webSearch' },
      { type: 'TOOL_CALL_RESULT', toolCallId: 'c1', content: 'ok' },
      { type: 'RUN_FINISHED' },
    ]);

    assert.equal(messages[0].role, 'assistant');
    assert.equal('content' in messages[0], false);
    assert.equal(messages[0].tool_calls?.[0]?.id, 'c1');
  });
});

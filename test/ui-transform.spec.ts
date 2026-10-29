/**
 * UI 归约单测：直播增量路径 + 快照重建路径。
 *
 * 最重要的两条不变量：
 * - **两条路径产出结构一致**：同一段对话，直播拼出来的和快照重建出来的，文本内容必须相同
 * - **归约层不吞异常**：未知事件、重复 START、乱序 CONTENT 都不能让整条流断掉
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { MessageStore } from '../src/message/message-store';
import { createAssistantPlaceholder, getTextContent, type LiveContext } from '../src/message/type';
import { aggregateSnapshot, applyLiveEvent } from '../src/message/ui-transform';
import type { AgentEvent, WireMessage } from '../src/transport/types';

let store: MessageStore;

beforeEach(() => {
  store = new MessageStore();
  ctx = { currentAssistantId: null };
});

let ctx: LiveContext;

function send(event: unknown): void {
  applyLiveEvent(store, event as AgentEvent, ctx);
}

// ============================================================
// 直播路径
// ============================================================

describe('applyLiveEvent · TEXT_MESSAGE_START', () => {
  it('接管已有的 assistant 占位消息', () => {
    const placeholder = createAssistantPlaceholder();
    store.push(placeholder);

    send({ type: 'TEXT_MESSAGE_START', messageId: 'msg_real', role: 'assistant' });

    assert.equal(store.snapshot.length, 1);
    assert.equal(store.snapshot[0].id, 'msg_real');
  });

  it('没有占位消息时新建一条', () => {
    send({ type: 'TEXT_MESSAGE_START', messageId: 'msg_real' });

    assert.equal(store.snapshot.length, 1);
    assert.equal(store.snapshot[0].id, 'msg_real');
    assert.equal(store.snapshot[0].role, 'assistant');
  });

  it('重复的 START 不会产生两条消息', () => {
    send({ type: 'TEXT_MESSAGE_START', messageId: 'msg_real' });
    send({ type: 'TEXT_MESSAGE_START', messageId: 'msg_real' });

    assert.equal(store.snapshot.length, 1);
  });
});

describe('applyLiveEvent · TEXT_MESSAGE_CONTENT', () => {
  it('按 messageId 累积到对应消息', () => {
    send({ type: 'TEXT_MESSAGE_START', messageId: 'msg_1' });
    send({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: '你' });
    send({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: '好' });

    assert.equal(getTextContent(store.snapshot[0]), '你好');
    assert.equal(store.snapshot.length, 1);
  });

  it('CONTENT 早于 START 到达时不抛错、也不凭空造消息', () => {
    assert.doesNotThrow(() => {
      send({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_unknown', delta: 'x' });
    });

    assert.equal(store.snapshot.length, 0);
  });
});

describe('applyLiveEvent · 其他事件', () => {
  it('TEXT_MESSAGE_END / RUN_FINISHED 不改动消息', () => {
    send({ type: 'TEXT_MESSAGE_START', messageId: 'msg_1' });
    send({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: '内容' });
    const before = store.snapshot;

    send({ type: 'TEXT_MESSAGE_END', messageId: 'msg_1' });
    send({ type: 'RUN_FINISHED', threadId: 't1' });

    assert.equal(store.snapshot, before);
  });

  it('RUN_ERROR 追加 error part 到最后一条 assistant 消息', () => {
    send({ type: 'TEXT_MESSAGE_START', messageId: 'msg_1' });
    send({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: '半截' });

    send({ type: 'RUN_ERROR', message: '模型超时' });

    assert.equal(store.snapshot.length, 1);
    const { parts } = store.snapshot[0];
    assert.equal(parts.length, 2);
    assert.deepEqual(parts[1], { type: 'error', message: '模型超时' });
  });

  it('RUN_ERROR 在没有任何消息时也能落地', () => {
    assert.doesNotThrow(() => send({ type: 'RUN_ERROR', message: '直接失败' }));

    assert.equal(store.snapshot.length, 1);
    assert.equal(store.snapshot[0].role, 'assistant');
    assert.equal(store.snapshot[0].parts[0].type, 'error');
  });

  it('未知事件不抛错且不改动消息', () => {
    send({ type: 'TEXT_MESSAGE_START', messageId: 'msg_1' });
    const before = store.snapshot;

    assert.doesNotThrow(() => send({ type: 'SOME_FUTURE_EVENT', foo: 1 }));
    assert.equal(store.snapshot, before);
  });
});

// ============================================================
// 快照路径
// ============================================================

describe('aggregateSnapshot', () => {
  it('user / assistant 文本会被聚合成 UI 消息', () => {
    const wire: WireMessage[] = [
      { id: 'w1', role: 'user', content: '你好' },
      { id: 'w2', role: 'assistant', content: '你好，有什么可以帮你' },
    ];

    const messages = aggregateSnapshot(wire);

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(getTextContent(messages[0]), '你好');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(getTextContent(messages[1]), '你好，有什么可以帮你');
  });

  it('缺失 id 时生成稳定的本地 id', () => {
    const messages = aggregateSnapshot([{ role: 'user', content: 'a' }]);

    assert.ok(messages[0].id.length > 0, 'id 不能为空');
    assert.notEqual(messages[0].id, 'undefined');
  });

  it('content_parts 优先于 content', () => {
    const messages = aggregateSnapshot([{
      role: 'user',
      content: '旧字段',
      content_parts: [{ type: 'text', text: '多模态里的文本' }],
    }]);

    assert.equal(getTextContent(messages[0]), '多模态里的文本');
  });

  it('未处理的 role（reasoning / system）被跳过', () => {
    const messages = aggregateSnapshot([
      { role: 'user', content: 'a' },
      { role: 'reasoning', content: '思考过程' },
      { role: 'assistant', content: 'b' },
    ]);

    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant']);
  });

  it('空消息列表返回空数组', () => {
    assert.deepEqual(aggregateSnapshot([]), []);
  });
});

// ============================================================
// 两条路径的一致性（Day 2 最重要的断言）
// ============================================================

describe('直播与快照产出一致', () => {
  it('同一段对话，两条路径的文本完全相同', () => {
    // 直播路径
    send({ type: 'TEXT_MESSAGE_START', messageId: 'msg_a' });
    for (const delta of ['你', '好', '，', '世界']) {
      send({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_a', delta });
    }

    // 快照路径
    const snapshot = aggregateSnapshot([
      { id: 'w1', role: 'user', content: '打个招呼' },
      { id: 'msg_a', role: 'assistant', content: '你好，世界' },
    ]);

    assert.equal(
      getTextContent(snapshot[1]),
      getTextContent(store.snapshot[0]),
      '两条路径的 assistant 文本必须一致',
    );
  });
});

// ============================================================
// 快照折叠（Day 3）：工具调用把一次回答切成多条 wire 消息
// ============================================================

const TOOL_WIRE: WireMessage[] = [
  { id: 'w1', role: 'user', content: '北京天气' },
  {
    id: 'msg_a',
    role: 'assistant',
    content: '我先用 webSearch 查一下北京的天气。',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'webSearch', arguments: '{"query":"北京天气"}' } },
    ],
  },
  { id: 'msg_tool', role: 'tool', tool_call_id: 'call_1', content: '{"city":"北京","weather":"晴","tempC":28}' },
  { id: 'msg_b', role: 'assistant', content: '北京今天晴，气温 28°C。需要我再查别的城市吗？' },
];

describe('aggregateSnapshot · 工具调用折叠', () => {
  it('assistant(tool_calls) + tool + assistant 折叠成一条消息', () => {
    const messages = aggregateSnapshot(TOOL_WIRE);

    assert.equal(messages.length, 2, 'user + 一条 assistant');
    const assistant = messages[1];
    assert.equal(assistant.parts.length, 3);
    assert.deepEqual(assistant.parts.map(part => part.type), ['text', 'tool', 'text']);

    const toolPart = assistant.parts[1];
    assert.equal(toolPart?.type, 'tool');
    if (toolPart?.type === 'tool') {
      assert.equal(toolPart.id, 'call_1');
      assert.equal(toolPart.name, 'webSearch');
      assert.equal(toolPart.args, '{"query":"北京天气"}');
      assert.equal(toolPart.result, '{"city":"北京","weather":"晴","tempC":28}', '结果要回填');
      assert.equal(toolPart.status, 'done');
    }
  });

  it('两个连续 assistant（中间没有 tool）是两条消息', () => {
    const messages = aggregateSnapshot([
      { id: 'a1', role: 'assistant', content: '第一轮回答' },
      { id: 'a2', role: 'assistant', content: '第二轮回答' },
    ]);

    assert.equal(messages.length, 2);
  });

  it('assistant 只有 tool_calls 没有文本时，parts 以 tool 开头', () => {
    const messages = aggregateSnapshot([
      {
        id: 'a1',
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'webSearch', arguments: '{}' } }],
      },
    ]);

    assert.deepEqual(messages[0].parts.map(part => part.type), ['tool']);
  });

  it('孤立的 tool 消息降级为错误消息，不丢数据', () => {
    const messages = aggregateSnapshot([
      { id: 't1', role: 'tool', tool_call_id: 'orphan', content: '结果' },
    ]);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].parts[0]?.type, 'error');
  });

  it('直播与快照折叠产出完全相同的 parts（Day 2 不变量在工具场景下成立）', () => {
    // 直播：重放同一段对话的事件
    store = new MessageStore();
    ctx = { currentAssistantId: null };
    store.push(createAssistantPlaceholder());

    const events = [
      { type: 'RUN_STARTED', threadId: 't1' },
      { type: 'TEXT_MESSAGE_START', messageId: 'msg_a' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_a', delta: '我先用 webSearch 查一下北京的天气。' },
      { type: 'TOOL_CALL_START', toolCallId: 'call_1', toolCallName: 'webSearch' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'call_1', delta: '{"query":"北京天气"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'call_1' },
      { type: 'TEXT_MESSAGE_END', messageId: 'msg_a' },
      { type: 'TOOL_CALL_RESULT', messageId: 'msg_tool', toolCallId: 'call_1', content: '{"city":"北京","weather":"晴","tempC":28}' },
      { type: 'TEXT_MESSAGE_START', messageId: 'msg_b' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_b', delta: '北京今天晴，气温 28°C。需要我再查别的城市吗？' },
      { type: 'RUN_FINISHED' },
    ];
    for (const event of events) send(event);

    const liveAssistant = store.snapshot.find(message => message.role === 'assistant');
    const snapshotAssistant = aggregateSnapshot(TOOL_WIRE).find(message => message.role === 'assistant');

    assert.deepEqual(liveAssistant?.parts, snapshotAssistant?.parts);
  });
});

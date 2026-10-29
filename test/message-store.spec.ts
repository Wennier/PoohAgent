/**
 * MessageStore 单测。
 *
 * 三条不可让步的契约：
 * 1. **不可变**：任何更新都不能原地改旧数组/旧对象（React 靠引用比对）
 * 2. **容错**：目标消息不存在时忽略 + warn，不抛错（流式过程中必须容忍乱序）
 * 3. **原地追加**：文本增量要落到**最后一个** text part，而不是新建一堆碎片
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { MessageStore } from '../src/message/message-store';
import { createAssistantPlaceholder, getTextContent, type ToolPart } from '../src/message/type';

let store: MessageStore;

beforeEach(() => {
  store = new MessageStore();
});

describe('MessageStore 基础操作', () => {
  it('初始为空', () => {
    assert.deepEqual(store.snapshot, []);
  });

  it('push 追加到末尾', () => {
    store.push({ id: 'm1', role: 'user', parts: [{ type: 'text', content: '你好' }] });
    store.push({ id: 'm2', role: 'assistant', parts: [] });

    assert.equal(store.snapshot.length, 2);
    assert.equal(store.snapshot[1].id, 'm2');
  });

  it('replaceAll 整体替换', () => {
    store.push({ id: 'm1', role: 'user', parts: [] });
    store.replaceAll([{ id: 'x', role: 'assistant', parts: [] }]);

    assert.deepEqual(store.snapshot.map(m => m.id), ['x']);
  });

  it('每次变更都推送新数组引用（不可变）', () => {
    const before = store.snapshot;
    store.push({ id: 'm1', role: 'user', parts: [] });

    assert.notEqual(store.snapshot, before);
    assert.equal(before.length, 0, '旧快照不能被改动');
  });
});

describe('MessageStore.replaceId', () => {
  it('命中时替换 id 并返回 true', () => {
    const placeholder = createAssistantPlaceholder();
    store.push(placeholder);

    const ok = store.replaceId(placeholder.id, 'msg_real');

    assert.equal(ok, true);
    assert.equal(store.snapshot[0].id, 'msg_real');
    assert.equal(store.snapshot.length, 1, '不能变成两条');
  });

  it('未命中时返回 false 且不抛错', () => {
    assert.doesNotThrow(() => {
      assert.equal(store.replaceId('not_exist', 'msg_real'), false);
    });
  });

  it('目标 id 已存在时不产生重复消息', () => {
    store.push({ id: 'msg_real', role: 'assistant', parts: [] });
    const placeholder = createAssistantPlaceholder();
    store.push(placeholder);

    store.replaceId(placeholder.id, 'msg_real');

    assert.equal(store.snapshot.length, 1);
    assert.equal(store.snapshot[0].id, 'msg_real');
  });
});

describe('MessageStore.appendText', () => {
  it('追加到最后一个 text part', () => {
    store.push({ id: 'm1', role: 'assistant', parts: [{ type: 'text', content: '你' }] });

    store.appendText('m1', '好');
    store.appendText('m1', '世界');

    assert.equal(getTextContent(store.snapshot[0]), '你好世界');
    assert.equal(store.snapshot[0].parts.length, 1, '不能每帧新建一个 part');
  });

  it('没有 text part 时新建一个', () => {
    store.push({ id: 'm1', role: 'assistant', parts: [] });

    store.appendText('m1', '第一段');

    assert.deepEqual(store.snapshot[0].parts, [{ type: 'text', id: 'm1', content: '第一段' }]);
  });

  it('目标消息不存在时忽略且不抛错', () => {
    store.push({ id: 'm1', role: 'assistant', parts: [] });

    assert.doesNotThrow(() => store.appendText('missing', 'x'));
    assert.deepEqual(store.snapshot[0].parts, [], '不能凭空创建消息');
  });

  it('空 delta 不产生变更', () => {
    store.push({ id: 'm1', role: 'assistant', parts: [{ type: 'text', content: 'a' }] });
    const before = store.snapshot;

    store.appendText('m1', '');

    assert.equal(store.snapshot, before);
  });

  it('不原地修改旧消息对象', () => {
    store.push({ id: 'm1', role: 'assistant', parts: [{ type: 'text', content: 'a' }] });
    const oldMessage = store.snapshot[0];

    store.appendText('m1', 'b');

    assert.equal(getTextContent(oldMessage), 'a', '旧对象不能被改');
    assert.notEqual(store.snapshot[0], oldMessage);
  });
});

describe('MessageStore.appendPart', () => {
  it('命中时追加到末尾', () => {
    store.push({ id: 'm1', role: 'assistant', parts: [{ type: 'text', content: 'a' }] });

    store.appendPart('m1', { type: 'error', message: '失败了' });

    assert.equal(store.snapshot[0].parts.length, 2);
    assert.equal(store.snapshot[0].parts[1].type, 'error');
  });

  it('未命中时新建一条 assistant 消息承载它', () => {
    store.appendPart('err_1', { type: 'error', message: '请求失败' });

    assert.equal(store.snapshot.length, 1);
    assert.equal(store.snapshot[0].id, 'err_1');
    assert.equal(store.snapshot[0].role, 'assistant');
    assert.deepEqual(store.snapshot[0].parts, [{ type: 'error', message: '请求失败' }]);
  });
});

// ============================================================
// 工具调用（Day 3）
// ============================================================

/** 取出唯一的 tool part，并先断言它确实是 tool —— 避免用 any 绕过类型。 */
function onlyToolPart(messageIndex = 0): ToolPart {
  const part = store.snapshot[messageIndex]?.parts[0];
  if (part?.type !== 'tool') throw new Error('期望取到一个 tool part');

  return part;
}

/** 造一条空的 assistant 消息，模拟"占位已被接管"之后的状态。 */
function seedAssistantMessage(messageId = 'msg_1'): string {
  store.push({ id: messageId, role: 'assistant', parts: [] });
  return messageId;
}

describe('MessageStore · 工具调用', () => {
  it('startToolPart 追加一张处于 calling 的卡片', () => {
    const messageId = seedAssistantMessage();

    store.startToolPart(messageId, 'tc_1', 'webSearch');

    const { parts } = store.snapshot[0];
    assert.equal(parts.length, 1);
    assert.deepEqual(parts[0], {
      type: 'tool',
      id: 'tc_1',
      name: 'webSearch',
      args: '',
      result: null,
      status: 'calling',
    });
  });

  it('重复 startToolPart 同一 toolCallId 不产生第二张卡', () => {
    const messageId = seedAssistantMessage();

    store.startToolPart(messageId, 'tc_1', 'webSearch');
    store.startToolPart(messageId, 'tc_1', 'webSearch');

    assert.equal(store.snapshot[0].parts.length, 1);
  });

  it('appendToolArgs 累积分片，且 status 仍为 calling', () => {
    const messageId = seedAssistantMessage();
    store.startToolPart(messageId, 'tc_1', 'webSearch');

    for (const delta of ['{"quer', 'y":"北京', '天气"}']) {
      store.appendToolArgs(messageId, 'tc_1', delta);
    }

    const part = onlyToolPart();
    assert.equal(part.args, '{"query":"北京天气"}');
    assert.equal(part.status, 'calling');
    assert.deepEqual(JSON.parse(part.args), { query: '北京天气' }, '累积完成后才是合法 JSON');
  });

  it('markToolRunning 把 status 置为 running，result 仍为 null', () => {
    const messageId = seedAssistantMessage();
    store.startToolPart(messageId, 'tc_1', 'webSearch');
    store.appendToolArgs(messageId, 'tc_1', '{"query":"北京天气"}');

    store.markToolRunning(messageId, 'tc_1');

    const part = onlyToolPart();
    assert.equal(part.status, 'running');
    assert.equal(part.result, null, 'END 只表示参数发完，不代表有结果');
  });

  it('patchToolResult 回填 result 且置为 done，不新增 part', () => {
    const messageId = seedAssistantMessage();
    store.startToolPart(messageId, 'tc_1', 'webSearch');
    store.markToolRunning(messageId, 'tc_1');

    store.patchToolResult(messageId, 'tc_1', '{"city":"北京"}');

    const part = onlyToolPart();
    assert.equal(part.status, 'done');
    assert.equal(part.result, '{"city":"北京"}');
    assert.equal(store.snapshot[0].parts.length, 1, '回填不能变成两个 part');
  });

  it('failToolPart 把 status 置为 failed（用于本轮异常中断）', () => {
    const messageId = seedAssistantMessage();
    store.startToolPart(messageId, 'tc_1', 'webSearch');
    store.markToolRunning(messageId, 'tc_1');

    store.failToolPart(messageId, 'tc_1');

    const part = onlyToolPart();
    assert.equal(part.status, 'failed');
  });

  it('四个方法遇到不存在的消息或 toolCallId 时都不抛错、不改动 store', () => {
    const messageId = seedAssistantMessage();

    assert.doesNotThrow(() => {
      store.startToolPart('missing', 'tc_1', 'webSearch');
      store.appendToolArgs('missing', 'tc_1', 'x');
      store.markToolRunning('missing', 'tc_1');
      store.patchToolResult('missing', 'tc_1', 'x');
      store.failToolPart('missing', 'tc_1');

      store.appendToolArgs(messageId, 'tc_unknown', 'x');
      store.markToolRunning(messageId, 'tc_unknown');
      store.patchToolResult(messageId, 'tc_unknown', 'x');
      store.failToolPart(messageId, 'tc_unknown');
    });

    assert.equal(store.snapshot.length, 1);
    assert.deepEqual(store.snapshot[0].parts, [], '未知 toolCallId 不能凭空创建卡片');
  });
});

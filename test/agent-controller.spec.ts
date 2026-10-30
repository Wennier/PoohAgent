/**
 * AgentController 单测。
 *
 * 用注入的假 connect 替代真实网络：这是「状态机不依赖 React、不依赖网络」的直接收益。
 *
 * 重点验证四件事：
 * 1. 状态机门禁：生成中拒绝新提交
 * 2. 占位消息：提交后立刻有 user 消息 + assistant 空壳
 * 3. threadId 只从 RUN_STARTED 回填
 * 4. 中止不是错误：AbortError 与网络失败的处理不同
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Observable } from 'rxjs';
import { Subject } from 'rxjs';

import { AgentController, AgentStatus } from '../src/agent/agent-controller';
import type { ImageInput } from '../src/agent/agent-controller';
import type { ErrorPart } from '../src/message/type';
import { getTextContent } from '../src/message/type';
import { aggregateSnapshot } from '../src/message/ui-transform';
import { AgentHttpError } from '../src/transport/agent-gateway';
import type { AgentEvent } from '../src/transport/types';

/** 造一个可以手动推送事件的假连接。 */
function createFakeConnect(): {
  connect: () => Observable<AgentEvent>;
  emit: (event: AgentEvent) => void;
  finish: () => void;
  fail: (error: unknown) => void;
  callCount: () => number;
} {
  const subjects: Subject<AgentEvent>[] = [];

  return {
    connect: () => {
      const subject = new Subject<AgentEvent>();
      subjects.push(subject);
      return subject.asObservable();
    },
    emit: event => subjects.at(-1)?.next(event),
    finish: () => subjects.at(-1)?.complete(),
    fail: error => subjects.at(-1)?.error(error),
    callCount: () => subjects.length,
  };
}

function createController(): {
  controller: AgentController;
  fake: ReturnType<typeof createFakeConnect>;
  events: AgentEvent[];
} {
  const fake = createFakeConnect();
  const events: AgentEvent[] = [];
  const controller = new AgentController({
    connect: fake.connect as never,
    onEvent: event => events.push(event),
  });

  return { controller, fake, events };
}

describe('AgentController · 初始状态', () => {
  it('初始为 Ready，消息为空，threadId 为空', () => {
    const { controller } = createController();

    assert.equal(controller.status, AgentStatus.Ready);
    assert.deepEqual(controller.snapshot, []);
    assert.equal(controller.threadId$.value, '');
  });

  it('空文本不发起请求、不产生消息', () => {
    const { controller, fake } = createController();

    assert.equal(controller.submit('   ', []), false);
    assert.equal(fake.callCount(), 0);
    assert.deepEqual(controller.snapshot, []);
  });
});

describe('AgentController · submit', () => {
  it('提交后立刻出现 user 消息与 assistant 占位，并进入 Generating', () => {
    const { controller } = createController();

    assert.equal(controller.submit('你好', []), true);

    const messages = controller.snapshot;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(getTextContent(messages[0]), '你好');
    assert.equal(messages[1].role, 'assistant');
    assert.deepEqual(messages[1].parts, [], '占位消息先没有内容');
    assert.equal(controller.status, AgentStatus.Generating);
  });

  it('生成中再次提交被拒绝', () => {
    const { controller, fake } = createController();

    controller.submit('第一句', []);

    assert.equal(controller.submit('第二句', []), false);
    assert.equal(fake.callCount(), 1, '不能有两条在途流');
    assert.equal(controller.snapshot.length, 2);
  });

  it('RUN_STARTED 回填 threadId（不是自己生成的）', () => {
    const { controller, fake } = createController();
    controller.submit('你好', []);

    fake.emit({ type: 'RUN_STARTED', threadId: 'thread_from_server' });

    assert.equal(controller.threadId$.value, 'thread_from_server');
  });

  it('文本事件会归约进消息，且 onEvent 能观察到每条事件', () => {
    const { controller, fake, events } = createController();
    controller.submit('你好', []);

    fake.emit({ type: 'TEXT_MESSAGE_START', messageId: 'msg_1' });
    fake.emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: '你' });
    fake.emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: '好' });

    assert.equal(getTextContent(controller.snapshot[1]), '你好');
    assert.equal(events.length, 3);
  });

  it('流结束回到 Ready', () => {
    const { controller, fake } = createController();
    controller.submit('你好', []);

    fake.finish();

    assert.equal(controller.status, AgentStatus.Ready);
  });

  it('网络错误：追加错误 part 并回到 Ready', () => {
    const { controller, fake } = createController();
    controller.submit('你好', []);
    fake.emit({ type: 'TEXT_MESSAGE_START', messageId: 'msg_1' });

    fake.fail(new Error('网络断了'));

    assert.equal(controller.status, AgentStatus.Ready);
    const { parts } = controller.snapshot[1];
    assert.equal(parts.at(-1)?.type, 'error');
  });

  it('非 2xx 且一个事件都没收到：判定为 query，文案是人话并带状态码', () => {
    const { controller, fake } = createController();
    controller.submit('你好', []);

    fake.fail(new AgentHttpError(429, 3000));

    const last = controller.snapshot[1].parts.at(-1) as ErrorPart;
    assert.equal(last.type, 'error');
    assert.equal(last.code, '429');
    // 不是 "/chat failed: 429" —— 那是给开发者看的
    assert.equal(last.message, '请求失败（429）');
  });

  it('已经吐过事件后再断：判定为 stream，提示可以重试这一轮', () => {
    const { controller, fake } = createController();
    controller.submit('你好', []);
    fake.emit({ type: 'TEXT_MESSAGE_START', messageId: 'msg_1' });
    fake.emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: '半截' });

    fake.fail(new TypeError('terminated'));

    const last = controller.snapshot[1].parts.at(-1) as ErrorPart;
    assert.match(last.message, /中断/);
    assert.equal(last.code, undefined, '流中断没有状态码');
  });

  it('abort 不带状态码：取消不是可重试的失败', () => {
    const { controller, fake } = createController();
    controller.submit('你好', []);

    controller.abort();
    fake.fail(new DOMException('aborted', 'AbortError'));

    const last = controller.snapshot[1].parts.at(-1) as ErrorPart;
    assert.equal(last.message, '已取消');
    assert.equal(last.code, undefined);
  });
});

describe('AgentController · abort', () => {
  it('中止后回到 Ready，错误文案是「已取消」而不是失败', () => {
    const { controller, fake } = createController();
    controller.submit('你好', []);

    controller.abort();
    fake.fail(new DOMException('aborted', 'AbortError'));

    assert.equal(controller.status, AgentStatus.Ready);
    const last = controller.snapshot[1].parts.at(-1);
    assert.equal(last?.type, 'error');
    assert.match(String((last as { message?: string }).message), /取消/);
  });

  it('没有在途请求时调用 abort 不抛错', () => {
    const { controller } = createController();

    assert.doesNotThrow(() => controller.abort());
  });
});

describe('AgentController · buildWireHistory', () => {
  it('把消息列表转成全量协议历史', () => {
    const { controller, fake } = createController();
    controller.submit('第一轮', []);
    fake.emit({ type: 'TEXT_MESSAGE_START', messageId: 'msg_a' });
    fake.emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_a', delta: '回复' });
    fake.finish();

    const history = controller.buildWireHistory();

    assert.equal(history.length, 2);
    assert.equal(history[0].role, 'user');
    assert.equal(history[0].content, '第一轮');
    assert.equal(history[1].role, 'assistant');
    assert.equal(history[1].content, '回复');
  });

  it('纯文本消息不产生 content_parts（保持轻量）', () => {
    const { controller } = createController();
    controller.submit('你好', []);

    const [userMessage] = controller.buildWireHistory();

    assert.equal(userMessage.content_parts, undefined);
    assert.equal(userMessage.content, '你好');
  });
});

describe('AgentController · 附件（图片）', () => {
  const IMAGE: ImageInput = {
    url: 'https://example.com/chart.png',
    filename: 'chart.png',
    mimeType: 'image/png',
  };

  const IMAGE_PART = {
    type: 'image' as const,
    url: IMAGE.url,
    filename: IMAGE.filename,
    mimeType: IMAGE.mimeType,
  };

  it('文字 + 图片：user 消息的 parts 顺序是 text → image', () => {
    const { controller } = createController();

    assert.equal(controller.submit('看这张图', [IMAGE]), true);

    assert.deepEqual(controller.snapshot[0].parts, [
      { type: 'text', content: '看这张图' },
      IMAGE_PART,
    ]);
  });

  it('只有图片、没有文字也能发，且不产生空 text part', () => {
    const { controller } = createController();

    assert.equal(controller.submit('', [IMAGE]), true);

    assert.deepEqual(controller.snapshot[0].parts, [IMAGE_PART]);
  });

  it('图片消息进协议历史时转成 content_parts，文字必须一起带上', () => {
    const { controller } = createController();
    controller.submit('看这张图', [IMAGE]);

    const [userMessage] = controller.buildWireHistory();

    assert.deepEqual(userMessage.content_parts, [
      { type: 'text', text: '看这张图' },
      {
        type: 'image',
        filename: 'chart.png',
        source: { type: 'url', value: IMAGE.url, mime_type: 'image/png' },
      },
    ]);
  });

  it('图片消息从协议历史还原回来，与发送时同构（4-5 不变量）', () => {
    const { controller } = createController();
    controller.submit('看这张图', [IMAGE]);

    const [restored] = aggregateSnapshot(controller.buildWireHistory()).filter(
      message => message.role === 'user',
    );

    assert.deepEqual(restored.parts, controller.snapshot[0].parts, '发出去再读回来，parts 必须一模一样');
  });
});

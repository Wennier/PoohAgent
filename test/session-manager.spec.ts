/**
 * SessionManager 单测：会话表 + 活动指针 + 草稿提升。
 *
 * 这些用例守的是 Day 5 的四条产品行为：
 * - 草稿不进列表（P4）
 * - 切换不串状态（P3）：不同会话拿到不同 controller
 * - 删除当前会话切相邻、全删回空态（P5）
 * - 刷新能回到上次会话；指针失效时回退（P2）
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Subject } from 'rxjs';

import { AgentController } from '../src/agent/agent-controller';
import { createMemoryPointer } from '../src/session/pointer';
import { SessionManager } from '../src/session/session-manager';
import type { SessionMeta } from '../src/session/types';
import type { AgentEvent } from '../src/transport/types';

function createFakeController(): AgentController {
  return new AgentController({ connect: () => new Subject<AgentEvent>().asObservable() });
}

function createManager(initialPointer: string | null = null): {
  manager: SessionManager;
  pointer: ReturnType<typeof createMemoryPointer>;
  createdFor: string[];
} {
  let counter = 0;
  const pointer = createMemoryPointer(initialPointer);
  const createdFor: string[] = [];
  const manager = new SessionManager({
    createController: (sessionId) => {
      createdFor.push(sessionId);
      return createFakeController();
    },
    pointer,
    titleOf: () => '自动标题',
    // 单调时间 + 固定 id，避免测试受随机值影响
    now: () => 1000 + counter++,
    makeDraftId: () => `draft_${counter++}`,
  });

  return { manager, pointer, createdFor };
}

function readyMeta(id: string): SessionMeta {
  return { id, title: id, kind: 'ready', createdAt: 1, updatedAt: 1 };
}

describe('SessionManager · 草稿', () => {
  it('新建草稿：不进入列表、成为活动会话、写入指针', () => {
    const { manager, pointer } = createManager();

    const id = manager.createDraft();

    assert.deepEqual(manager.sessions$.value, [], '草稿不该出现在列表里');
    assert.equal(manager.activeId, id);
    assert.equal(pointer.read(), id);
    assert.equal(manager.activeMeta?.kind, 'draft');
  });

  it('多个草稿各自有独立 controller，互不覆盖', () => {
    const { manager } = createManager();

    const first = manager.createDraft();
    const second = manager.createDraft();

    assert.equal(manager.activeId, second, '后建的草稿成为活动会话');
    assert.notEqual(manager.controllerOf(first), manager.controllerOf(second));
  });

  it('激活未知会话被忽略，活动会话与指针都不变', () => {
    const { manager, pointer } = createManager();
    const id = manager.createDraft();

    manager.activate('draft_unknown');

    assert.equal(manager.activeId, id);
    assert.equal(pointer.read(), id);
  });
});

describe('SessionManager · 会话隔离与切换', () => {
  it('不同会话拿到不同 controller（切换不会串消息）', () => {
    const { manager } = createManager();
    manager.hydrate([readyMeta('t1'), readyMeta('t2')]);

    manager.activate('t1');
    const first = manager.controllerOf('t1');
    manager.activate('t2');

    assert.equal(manager.activeId, 't2');
    assert.notEqual(first, manager.controllerOf('t2'));
  });

  it('反复激活同一个会话不重复写指针', () => {
    const { manager, pointer } = createManager();
    manager.hydrate([readyMeta('t1')]);

    manager.activate('t1');
    const controller = manager.controllerOf('t1');
    manager.activate('t1');

    assert.equal(manager.controllerOf('t1'), controller, 'controller 应复用');
    assert.equal(pointer.read(), 't1');
  });

  it('创建 controller 时把 sessionId 传出去（多会话日志要能区分）', () => {
    const { manager, createdFor } = createManager();
    manager.hydrate([readyMeta('t1')]);
    manager.activate('t1');
    manager.controllerOf('t1');

    assert.deepEqual(createdFor, ['t1']);
  });

  it('hasController 只查询、不顺手创建实例', () => {
    const { manager } = createManager();
    manager.hydrate([readyMeta('t1')]);

    assert.equal(manager.hasController('t1'), false);
    manager.controllerOf('t1');
    assert.equal(manager.hasController('t1'), true);
  });
});

describe('SessionManager · 草稿提升', () => {
  it('提升后：进列表、切活动、草稿消失、controller 迁到 threadId', () => {
    const { manager, pointer } = createManager();
    const draftId = manager.createDraft();
    const controller = manager.controllerOf(draftId);

    manager.promote(draftId, 'thread_1', '北京天气');

    assert.deepEqual(
      manager.sessions$.value.map(meta => meta.id),
      ['thread_1'],
    );
    assert.equal(manager.activeId, 'thread_1');
    assert.equal(pointer.read(), 'thread_1');
    assert.equal(manager.controllerOf('thread_1'), controller, 'controller 不能被重建，否则消息会丢');
  });

  it('提升后旧草稿 id 失效，不能再切回去', () => {
    const { manager } = createManager();
    const draftId = manager.createDraft();
    manager.promote(draftId, 'thread_1');

    manager.activate(draftId);

    assert.equal(manager.activeId, 'thread_1');
  });
});

describe('SessionManager · 草稿自动提升', () => {
  it('controller 拿到 threadId 后自动落成正式会话（标题由 titleOf 生成）', () => {
    const { manager, pointer } = createManager();
    const draftId = manager.createDraft();
    const controller = manager.controllerOf(draftId);

    controller.setThreadId('thread_auto');

    assert.deepEqual(
      manager.sessions$.value.map(meta => meta.id),
      ['thread_auto'],
    );
    assert.equal(manager.sessions$.value[0].title, '自动标题');
    assert.equal(manager.activeId, 'thread_auto');
    assert.equal(pointer.read(), 'thread_auto');
  });

  it('切换会话后，旧草稿的 threadId 只提升它自己，不污染新草稿', () => {
    const { manager } = createManager();
    const first = manager.createDraft();
    const firstController = manager.controllerOf(first);
    const second = manager.createDraft();

    // 模拟：用户在第一个草稿里发出消息、RUN_STARTED 迟到，而 UI 已经切到第二个草稿
    firstController.setThreadId('thread_first');

    assert.equal(manager.activeId, second, '活动会话不能被旧 threadId 抢走');
    assert.deepEqual(
      manager.sessions$.value.map(meta => meta.id),
      ['thread_first'],
      '旧草稿自己落成正式会话',
    );
    assert.equal(manager.metaOf(second)?.kind, 'draft', '新草稿仍是草稿');
  });

  it('已存在的正式会话设置 threadId 不会重复提升', () => {
    const { manager } = createManager();
    manager.hydrate([readyMeta('t1')]);
    manager.activate('t1');
    const controller = manager.controllerOf('t1');

    controller.setThreadId('t1');

    assert.equal(manager.sessions$.value.length, 1);
    assert.equal(manager.sessions$.value[0].id, 't1');
  });
});

describe('SessionManager · 删除', () => {
  it('删除当前会话：切到下一条', () => {
    const { manager, pointer } = createManager();
    manager.hydrate([readyMeta('a'), readyMeta('b'), readyMeta('c')]);
    manager.activate('b');

    manager.remove('b');

    assert.equal(manager.activeId, 'c');
    assert.equal(pointer.read(), 'c');
    assert.deepEqual(
      manager.sessions$.value.map(meta => meta.id),
      ['a', 'c'],
    );
  });

  it('删除列表最后一条：回退到上一条', () => {
    const { manager } = createManager();
    manager.hydrate([readyMeta('a'), readyMeta('b')]);
    manager.activate('b');

    manager.remove('b');

    assert.equal(manager.activeId, 'a');
  });

  it('删除最后一个会话：回到空态并清空指针', () => {
    const { manager, pointer } = createManager();
    manager.hydrate([readyMeta('only')]);
    manager.activate('only');

    manager.remove('only');

    assert.equal(manager.activeId, null);
    assert.equal(pointer.read(), null);
    assert.deepEqual(manager.sessions$.value, []);
  });

  it('删除非当前会话不影响活动会话', () => {
    const { manager } = createManager();
    manager.hydrate([readyMeta('a'), readyMeta('b')]);
    manager.activate('a');

    manager.remove('b');

    assert.equal(manager.activeId, 'a');
  });
});

describe('SessionManager · 恢复上次会话', () => {
  it('指针命中：直接回到该会话', () => {
    const { manager } = createManager('b');
    manager.hydrate([readyMeta('a'), readyMeta('b')]);

    manager.restore();

    assert.equal(manager.activeId, 'b');
  });

  it('指针失效：回退到列表第一项', () => {
    const { manager } = createManager('gone');
    manager.hydrate([readyMeta('a'), readyMeta('b')]);

    manager.restore();

    assert.equal(manager.activeId, 'a');
  });

  it('指针失效且列表为空：回到空态并清空指针', () => {
    const { manager, pointer } = createManager('gone');

    manager.restore();

    assert.equal(manager.activeId, null);
    assert.equal(pointer.read(), null);
  });
});

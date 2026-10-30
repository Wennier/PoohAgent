/**
 * SessionList 渲染测试（react-dom/server，不依赖 jsdom）。
 *
 * 列表是纯展示组件，测的是「用户能看到什么」：标题、活动态、生成中、空列表。
 * 删除确认弹层需要点击才能出现，属于交互，留给页面验收。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentStatus } from '../src/agent/agent-controller';
import type { SessionMeta } from '../src/session/types';
import { SessionList } from '../demo/session-list';

const NOW = Date.now();

const SESSIONS: SessionMeta[] = [
  { id: 't1', title: '北京天气', kind: 'ready', createdAt: NOW - 120_000, updatedAt: NOW - 120_000 },
  { id: 't2', title: '周报怎么写', kind: 'ready', createdAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000 },
];

function render(patch: Partial<React.ComponentProps<typeof SessionList>> = {}): string {
  return renderToStaticMarkup(
    React.createElement(SessionList, {
      sessions: SESSIONS,
      activeId: 't1',
      statuses: {},
      onSelect: () => undefined,
      onCreate: () => undefined,
      onRemove: () => undefined,
      ...patch,
    }),
  );
}

describe('SessionList · 左侧会话列表', () => {
  it('渲染每条会话的标题', () => {
    const html = render();

    assert.match(html, /北京天气/);
    assert.match(html, /周报怎么写/);
  });

  it('活动会话带 aria-current，非活动会话不带', () => {
    const html = render();
    // 按条目切分，避免用跨整段 HTML 的正则（attribute 与标题之间隔着很多样式）
    const items = html.split('<div role="button"').slice(1);

    assert.equal(items.length, 2);
    assert.match(items[0], /aria-current="true"/);
    assert.match(items[0], /北京天气/);
    assert.doesNotMatch(items[1], /aria-current="true"/);
  });

  it('生成中的会话显示「生成中…」而不是时间', () => {
    const html = render({ statuses: { t1: AgentStatus.Generating } });

    assert.match(html, /生成中…/);
  });

  it('空列表显示占位文案', () => {
    const html = render({ sessions: [], activeId: null });

    assert.match(html, /还没有会话/);
  });
});

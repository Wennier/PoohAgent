/**
 * 工具调用卡片（Day 3 只读版）。
 *
 * 产品规则（见 docs/assets/tool-card-ux.png）：
 * - `calling` / `running`：展开，标题是进行时文案（用户要知道"它在干活"）
 * - `done`：折叠成一行（不需要看细节）
 * - `failed`：展开 + 红色（用户需要知道为什么失败）
 *
 * 两个刻意的实现选择：
 * - `args` 原样显示，**不 JSON.parse**：流式途中它就是不完整 JSON，解析会抛
 * - 展开状态用「用户覆盖值 ?? 状态默认值」，而不是 useEffect 跟随：避免多一次渲染
 */

import React, { useState } from 'react';

import type { ToolPart } from '../message/type';

export interface ToolCardProps {
  part: ToolPart;
}

/** 标题文案：正在进行时带上省略号，让用户知道还没结束。 */
function resolveTitle(part: ToolPart): string {
  switch (part.status) {
    case 'calling':
      return `正在使用 ${part.name}…`;
    case 'running':
      return `正在执行 ${part.name}…`;
    case 'failed':
      return `${part.name} 执行失败`;
    case 'done':
    default:
      return part.name;
  }
}

function resolveIcon(part: ToolPart): { text: string; color: string } {
  switch (part.status) {
    case 'done':
      return { text: '✓', color: '#2C7A4B' };
    case 'failed':
      return { text: '!', color: '#C0392B' };
    default:
      return { text: '⋯', color: '#1A56B3' };
  }
}

export const ToolCard: React.FC<ToolCardProps> = ({ part }) => {
  // 用户点过就以用户为准；没点过就跟随状态（done 默认收起，其余默认展开）
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? part.status !== 'done';

  const icon = resolveIcon(part);
  const isFailed = part.status === 'failed';

  return (
    <div style={isFailed ? styles.cardFailed : styles.card}>
      <button type="button" style={styles.header} onClick={() => setUserExpanded(!expanded)}>
        <span style={{ ...styles.icon, color: icon.color }}>{icon.text}</span>
        <span style={styles.title}>{resolveTitle(part)}</span>
        <span style={styles.chevron}>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div style={styles.body}>
          <div style={styles.row}>
            <span style={styles.label}>参数</span>
            <code style={styles.code}>{part.args || '(等待参数)'}</code>
          </div>

          {part.result !== null && (
            <div style={styles.row}>
              <span style={styles.label}>结果</span>
              <code style={styles.code}>{part.result}</code>
            </div>
          )}

          {isFailed && (
            <div style={styles.row}>
              <span style={styles.label}>状态</span>
              <span style={styles.errorText}>工具执行失败或本轮异常中断</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: '1px solid #DCE3EC',
    borderRadius: 8,
    background: '#fff',
    margin: '6px 0',
    overflow: 'hidden',
  },
  cardFailed: {
    border: '1px solid #F0C2C0',
    borderRadius: 8,
    background: '#fff',
    margin: '6px 0',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 12px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
  },
  icon: { fontSize: 13, fontWeight: 700, width: 16, textAlign: 'center' },
  title: { flex: 1, fontSize: 13, color: '#1F2328' },
  chevron: { fontSize: 11, color: '#9AA0A6' },
  body: { borderTop: '1px solid #EFF2F6', padding: '8px 12px 10px 36px' },
  row: { display: 'flex', gap: 8, padding: '2px 0', alignItems: 'baseline' },
  label: { fontSize: 12, color: '#8A8F98', flexShrink: 0, width: 28 },
  code: {
    fontSize: 12,
    fontFamily: 'ui-monospace, Menlo, monospace',
    color: '#3C4043',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  errorText: { fontSize: 12, color: '#C0392B' },
};

/**
 * 左侧会话列表。
 *
 * 只负责"展示 + 抛事件"：新建、切换、删除都交回 App，组件本身不碰 SessionManager。
 * 这样列表的样式与交互可以独立演进，不会和会话状态机搅在一起。
 *
 * 三个产品约定（Day 5）：
 * - 草稿不进列表：传进来的 sessions 只含已落成的会话；
 * - 删除必须二次确认（会话删了不可恢复），用页内弹层而不是 window.confirm；
 * - 正在生成的会话在列表里显示「生成中…」，切换走也不打断它。
 */

import React, { useState } from 'react';

import { AgentStatus } from 'src/agent/agent-controller';
import type { SessionMeta } from 'src/session/types';

interface SessionListProps {
  sessions: SessionMeta[];
  activeId: string | null;
  /** 会话 id → 状态；没有 controller 的会话查不到，按 Ready 处理。 */
  statuses: Record<string, AgentStatus>;
  /** 启动/刷新时正在拉列表：空列表要显示「加载中」而不是「还没有会话」。 */
  loading?: boolean;
  /** 删除失败的提示（服务端没删掉时不能只删本地）。 */
  errorText?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRemove: (id: string) => void;
}

export const SessionList: React.FC<SessionListProps> = ({
  sessions,
  activeId,
  statuses,
  loading = false,
  errorText = '',
  onSelect,
  onCreate,
  onRemove,
}) => {
  /** 只为显示 hover 时的删除按钮；放在列表层，避免每个条目各自一份状态。 */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  /** 待确认删除的会话；非空时弹层出现。 */
  const [pendingRemove, setPendingRemove] = useState<SessionMeta | null>(null);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>会话</span>
        <button type="button" style={styles.createButton} onClick={onCreate}>
          + 新建对话
        </button>
      </div>

      {errorText !== '' && (
        <div style={styles.errorText} role="alert">
          删除失败：{errorText}
        </div>
      )}

      <div style={styles.list}>
        {sessions.length === 0 ? (
          <div style={styles.empty}>{loading ? '加载中…' : '还没有会话'}</div>
        ) : (
          sessions.map(meta => {
            const isActive = meta.id === activeId;
            const isGenerating = statuses[meta.id] === AgentStatus.Generating;

            return (
              <div
                key={meta.id}
                role="button"
                tabIndex={0}
                aria-current={isActive ? 'true' : undefined}
                style={{
                  ...styles.item,
                  ...(isActive ? styles.itemActive : {}),
                  ...(hoveredId === meta.id ? styles.itemHover : {}),
                }}
                onMouseEnter={() => setHoveredId(meta.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={() => onSelect(meta.id)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(meta.id);
                  }
                }}
              >
                {isActive && <span style={styles.activeBar} />}

                <div style={styles.itemTitle} title={meta.title}>
                  {meta.title}
                </div>

                <div style={styles.itemMeta}>
                  {isGenerating ? (
                    <span style={styles.generating}>
                      <span style={styles.generatingDot} />
                      生成中…
                    </span>
                  ) : (
                    formatRelativeTime(meta.updatedAt)
                  )}
                </div>

                {hoveredId === meta.id && (
                  <button
                    type="button"
                    style={styles.removeButton}
                    aria-label={`删除 ${meta.title}`}
                    title="删除会话"
                    onClick={event => {
                      // 不能触发外层的"切换会话"
                      event.stopPropagation();
                      setPendingRemove(meta);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {pendingRemove !== null && (
        <div style={styles.overlay} role="dialog" aria-modal="true" aria-label="删除会话确认">
          <div style={styles.dialog}>
            <div style={styles.dialogTitle}>删除会话？</div>
            <div style={styles.dialogBody}>
              「{pendingRemove.title}」的消息会被删除，无法恢复。
              {statuses[pendingRemove.id] === AgentStatus.Generating && ' 该会话正在生成，删除会一并中止。'}
            </div>
            <div style={styles.dialogActions}>
              <button type="button" style={styles.cancelButton} onClick={() => setPendingRemove(null)}>
                取消
              </button>
              <button
                type="button"
                style={styles.dangerButton}
                onClick={() => {
                  onRemove(pendingRemove.id);
                  setPendingRemove(null);
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 相对时间：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 HH:mm / MM-DD。
 *
 * 不用 toLocaleString：列表里时间只是辅助信息，越短越好扫。
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;

  const date = new Date(timestamp);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

  if (date.toDateString() === new Date(now).toDateString()) return clock;

  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`;

  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${clock}`;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    borderBottom: '1px solid #e9ebee',
  },
  headerTitle: { fontSize: 12, color: '#6b7280', letterSpacing: 0.5 },
  createButton: {
    border: '1px solid #d0d4d9',
    background: '#fff',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 12,
    cursor: 'pointer',
    color: '#1f2328',
  },
  list: { flex: 1, overflowY: 'auto', padding: 6 },
  errorText: {
    margin: '6px 8px 0',
    padding: '4px 8px',
    background: '#fff1f0',
    color: '#d93026',
    fontSize: 11,
    borderRadius: 4,
    wordBreak: 'break-all',
  },
  empty: { padding: 16, color: '#9aa0a6', fontSize: 12, textAlign: 'center' },
  item: {
    position: 'relative',
    padding: '8px 10px 8px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    marginBottom: 2,
  },
  itemHover: { background: '#eef1f4' },
  itemActive: { background: '#e6effd' },
  activeBar: {
    position: 'absolute',
    left: 4,
    top: 8,
    bottom: 8,
    width: 2,
    borderRadius: 1,
    background: '#1a73e8',
  },
  itemTitle: {
    fontSize: 13,
    color: '#1f2328',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    paddingRight: 18,
  },
  itemMeta: { marginTop: 2, fontSize: 11, color: '#9aa0a6' },
  generating: { display: 'inline-flex', alignItems: 'center', gap: 4, color: '#1a73e8' },
  generatingDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#1a73e8',
    display: 'inline-block',
  },
  removeButton: {
    position: 'absolute',
    top: 8,
    right: 6,
    border: 'none',
    background: 'transparent',
    color: '#9aa0a6',
    fontSize: 14,
    lineHeight: 1,
    cursor: 'pointer',
    padding: 0,
  },
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.35)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  dialog: {
    width: 320,
    background: '#fff',
    borderRadius: 8,
    padding: 16,
    boxShadow: '0 12px 32px rgba(15, 23, 42, 0.18)',
  },
  dialogTitle: { fontSize: 14, fontWeight: 600, marginBottom: 8 },
  dialogBody: { fontSize: 12, color: '#4b5563', lineHeight: 1.6 },
  dialogActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
  cancelButton: {
    border: '1px solid #d0d4d9',
    background: '#fff',
    borderRadius: 4,
    padding: '5px 12px',
    fontSize: 12,
    cursor: 'pointer',
  },
  dangerButton: {
    border: '1px solid #d93026',
    background: '#d93026',
    color: '#fff',
    borderRadius: 4,
    padding: '5px 12px',
    fontSize: 12,
    cursor: 'pointer',
  },
};

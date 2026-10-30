/**
 * part → 组件 的分发器。
 *
 * 存在的唯一理由：**让 main.tsx 不再认识 part 类型**。
 * 加第四种 part（比如 artifacts）时只改这里，不动入口。
 */

import React, { type ReactNode } from 'react';

import { classifyRunError } from '../agent/error-classify';
import type { ErrorPart, Part } from '../message/type';

import { ImageBlock } from './image-block';
import { MarkdownText } from './markdown-text';
import { ToolCard } from './tool-card';

/** 渲染 part 时可以从外部注入的动作。不注就不出现对应按钮（只读视图）。 */
export interface PartActions {
  /** 重跑这一轮（6-2 的入口） */
  onRetry?: () => void;
}

/**
 * 渲染一个 part。
 *
 * @param part 消息里的一段内容
 * @param actions 外部注入的动作；缺省时降级成只读渲染
 * @returns 对应组件；未知类型返回 null（不能崩，否则一条新 part 会白屏）
 */
export function renderPart(part: Part, actions: PartActions = {}): ReactNode {
  switch (part.type) {
    case 'text':
      // Markdown 渲染放在这里，不要回到入口组件：
      // 加一种 part 只改分发器，加一种文本格式只改 MarkdownText
      return <MarkdownText content={part.content} />;

    case 'error':
      return <ErrorBlock part={part} onRetry={actions.onRetry} />;

    case 'tool':
      return <ToolCard part={part} />;

    case 'image':
      // 只可能出现在 user 消息里（image part 只由附件提交产生）
      return <ImageBlock part={part} />;

    default:
      return null;
  }
}

/**
 * 错误块：文案 + （可选）重试按钮。
 *
 * 两个判定都要有出处，不能靠"有没有 code"猜：
 * - `part.retryable` 有值 → 分类器已经判过（抛出来的错误由 controller 写）
 * - 没值 → 是 RUN_ERROR 路径，按业务码推（439902/03/07 不该给按钮）
 * - 取消：明确不可重试且没有码 → 灰色提示，不当成报错
 */
const ErrorBlock: React.FC<{ part: ErrorPart; onRetry?: () => void }> = ({ part, onRetry }) => {
  const retryable =
    part.retryable ?? classifyRunError({ message: part.message, code: part.code }).manualRetryable;
  const canceled = part.retryable === false && part.code === undefined;

  return (
    <div style={canceled ? styles.canceled : styles.error}>
      <span>{part.message}</span>
      {retryable && onRetry ? (
        <button type="button" style={styles.retry} onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  error: { color: '#d93026', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 },
  canceled: { color: '#8b9099', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 },
  retry: {
    padding: '2px 10px',
    border: '1px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
  },
};

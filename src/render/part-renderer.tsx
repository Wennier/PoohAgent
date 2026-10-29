/**
 * part → 组件 的分发器。
 *
 * 存在的唯一理由：**让 main.tsx 不再认识 part 类型**。
 * 加第四种 part（比如 artifacts）时只改这里，不动入口。
 */

import React, { type ReactNode } from 'react';

import type { Part } from '../message/type';

import { ImageBlock } from './image-block';
import { MarkdownText } from './markdown-text';
import { ToolCard } from './tool-card';

/**
 * 渲染一个 part。
 *
 * @param part 消息里的一段内容
 * @returns 对应组件；未知类型返回 null（不能崩，否则一条新 part 会白屏）
 */
export function renderPart(part: Part): ReactNode {
  switch (part.type) {
    case 'text':
      // Markdown 渲染放在这里，不要回到入口组件：
      // 加一种 part 只改分发器，加一种文本格式只改 MarkdownText
      return <MarkdownText content={part.content} />;

    case 'error':
      return <div style={styles.error}>{part.message}</div>;

    case 'tool':
      return <ToolCard part={part} />;

    case 'image':
      // 只可能出现在 user 消息里（image part 只由附件提交产生）
      return <ImageBlock part={part} />;

    default:
      return null;
  }
}

const styles: Record<string, React.CSSProperties> = {
  error: { color: '#d93026', marginTop: 4 },
};

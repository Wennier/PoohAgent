/**
 * Markdown 文本渲染。
 *
 * 为什么单独一个文件：`part-renderer` 只负责"把 part 分发到组件"，
 * 具体怎么渲染 Markdown 属于渲染细节，混在一起会让分发器变成大杂烩。
 *
 * 三个照抄现网（workspace-kit）的决定：
 * 1. 插件链带 `singleTilde: false` —— 避免 `~` 被当成删除线
 * 2. `pre` 负责块级、`code` 只管行内，块级交给独立样式
 * 3. **流式不做补齐**：未闭合的围栏 / 加粗交给 react-markdown 自己兜，
 *    频率问题交给上层（消息列表层）节流，不在这里做防抖
 */

import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

export interface MarkdownTextProps {
  content: string;
}

/** GFM 选项：关掉单波浪线删除线，中文场景下 `~` 太容易误判。 */
const GFM_OPTIONS = { singleTilde: false } as const;

/** 代码块靠 rehype-highlight 加 `hljs language-*` 类；配色 CSS 由宿主引入。 */
function isBlockCode(className: string | undefined, children: React.ReactNode): boolean {
  if (className?.includes('language-') === true) return true;

  return String(children ?? '').includes('\n');
}

const components: Components = {
  p: ({ children }) => <p style={styles.paragraph}>{children}</p>,
  ul: ({ children }) => <ul style={styles.list}>{children}</ul>,
  ol: ({ children }) => <ol style={styles.list}>{children}</ol>,
  li: ({ children }) => <li style={styles.listItem}>{children}</li>,
  h1: ({ children }) => <h1 style={styles.h1}>{children}</h1>,
  h2: ({ children }) => <h2 style={styles.h2}>{children}</h2>,
  h3: ({ children }) => <h3 style={styles.h3}>{children}</h3>,
  pre: ({ children }) => <pre style={styles.pre}>{children}</pre>,
  code: ({ className, children }) => (
    isBlockCode(className, children)
      ? <code className={className} style={styles.blockCode}>{children}</code>
      : <code style={styles.inlineCode}>{children}</code>
  ),
  blockquote: ({ children }) => <blockquote style={styles.blockquote}>{children}</blockquote>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" style={styles.link}>{children}</a>
  ),
  table: ({ children }) => <table style={styles.table}>{children}</table>,
  th: ({ children }) => <th style={styles.th}>{children}</th>,
  td: ({ children }) => <td style={styles.td}>{children}</td>,
};

export const MarkdownText: React.FC<MarkdownTextProps> = ({ content }) => (
  <div style={styles.root}>
    <ReactMarkdown
      remarkPlugins={[[remarkGfm, GFM_OPTIONS]]}
      rehypePlugins={[rehypeHighlight]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  </div>
);

const styles: Record<string, React.CSSProperties> = {
  root: { fontSize: 13, lineHeight: 1.75, wordBreak: 'break-word' },
  paragraph: { margin: '0 0 8px', whiteSpace: 'pre-wrap' },
  list: { margin: '0 0 8px', paddingLeft: 20 },
  listItem: { margin: '2px 0' },
  h1: { fontSize: 17, margin: '12px 0 6px' },
  h2: { fontSize: 15.5, margin: '12px 0 6px' },
  h3: { fontSize: 14, margin: '10px 0 6px' },
  pre: {
    margin: '8px 0',
    padding: 10,
    background: '#F6F8FA',
    border: '1px solid #E7EAEF',
    borderRadius: 6,
    overflowX: 'auto',
  },
  blockCode: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, whiteSpace: 'pre' },
  inlineCode: {
    padding: '1px 5px',
    background: '#F1F3F5',
    borderRadius: 4,
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: 12,
  },
  blockquote: {
    margin: '8px 0',
    padding: '4px 10px',
    borderLeft: '3px solid #DCE3EC',
    color: '#5F6368',
  },
  link: { color: '#1A56B3', textDecoration: 'none' },
  table: { borderCollapse: 'collapse', margin: '8px 0', width: '100%' },
  th: { border: '1px solid #E7EAEF', padding: '4px 8px', background: '#FAFBFC', textAlign: 'left' },
  td: { border: '1px solid #E7EAEF', padding: '4px 8px' },
};

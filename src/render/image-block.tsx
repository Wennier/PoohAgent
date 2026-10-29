/**
 * 用户附件里的图片块。
 *
 * 为什么单独一个文件：part-renderer 只负责「按类型分发」，
 * 尺寸、加载失败这些属于图片自己的事；混在一起会让分发器越来越肥。
 *
 * 边界（产品上都必须有反馈，不能只留一个破图标）：
 * - URL 是手填的，写错很常见 → onError 切到灰底占位，而不是浏览器默认的破图
 * - alt 用文件名：图片挂了、屏幕阅读器里都还能知道这是哪张
 * - maxWidth 而不是 width：小图不能被拉大
 */

import React, { useState } from 'react';

import type { ImagePart } from '../message/type';

export const ImageBlock: React.FC<{ part: ImagePart }> = ({ part }) => {
  const [failed, setFailed] = useState(false);

  return (
    <figure style={styles.figure}>
      {failed ? (
        <div style={styles.broken}>图片加载失败</div>
      ) : (
        <img
          src={part.url}
          alt={part.filename}
          loading="lazy"
          style={styles.image}
          // 一旦失败就不再重试，避免坏 URL 反复触发 onError 造成重渲染抖动
          onError={() => setFailed(true)}
        />
      )}
      <figcaption style={styles.caption}>{part.filename}</figcaption>
    </figure>
  );
};

const styles: Record<string, React.CSSProperties> = {
  figure: { margin: '6px 0 0', display: 'inline-flex', flexDirection: 'column', gap: 4 },
  image: { maxWidth: 240, maxHeight: 240, objectFit: 'cover', borderRadius: 8, display: 'block' },
  broken: {
    width: 240,
    height: 120,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f2f3f5',
    color: '#8a8f99',
    fontSize: 12,
    borderRadius: 8,
  },
  caption: { fontSize: 12, color: '#8a8f99' },
};

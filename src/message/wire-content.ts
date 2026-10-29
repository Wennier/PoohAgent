/**
 * UI parts → 协议 content_parts（出站方向）。
 *
 * 独立成文件的原因：`ui-transform` 负责**入站**（协议 → UI），
 * 这里负责**出站**（UI → 协议）。方向不同的转换放在一起最容易改错。
 */

import type { WireContentPart } from '../transport/types';

import type { Part } from './type';

/**
 * 把一条消息的 parts 转成协议要的 `content_parts`。
 *
 * 关键约束：协议里 `content_parts` 非空时 **`content` 会被忽略**，
 * 所以文字必须一起塞进来——只放图片会让用户打的字凭空消失。
 *
 * 没有图片时返回 `undefined`，让调用方继续用轻量的 `content` 字段，
 * 避免给每条纯文本消息都塞一个数组。
 *
 * @param parts 消息内容
 * @returns 协议内容片段；无图片时为 undefined
 */
export function toWireContentParts(parts: Part[]): WireContentPart[] | undefined {
  const hasImage = parts.some(part => part.type === 'image');
  if (!hasImage) return undefined;

  const result: WireContentPart[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      // 空文本不产生空片段，否则协议侧会收到一个无意义的 text
      if (part.content !== '') result.push({ type: 'text', text: part.content });
      continue;
    }

    if (part.type === 'image') {
      result.push({
        type: 'image',
        filename: part.filename,
        source: {
          // 粘贴的图只有 data URL，没有公网地址：协议要标成 data，
          // 否则后端会把 "data:image/png;base64,…" 当成一个非法 URL。
          type: part.url.startsWith('data:') ? 'data' : 'url',
          value: part.url,
          mime_type: part.mimeType,
        },
      });
    }

    // tool / error / reasoning 不会出现在 user 消息里，这里忽略
  }

  return result;
}

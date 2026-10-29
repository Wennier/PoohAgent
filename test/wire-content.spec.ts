import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImagePart, Part } from '../src/message/type';
import { toWireContentParts } from '../src/message/wire-content';

const IMAGE: ImagePart = {
  type: 'image',
  url: 'mock-image-url-a1',
  filename: '架构图.png',
  mimeType: 'image/png',
};

function text(content: string): Part {
  return { type: 'text', content };
}

describe('toWireContentParts · UI parts → 协议 content_parts', () => {
  it('没有图片时返回 undefined（调用方继续用 content 字段）', () => {
    assert.equal(toWireContentParts([text('你好')]), undefined);
  });

  it('有图片时文字也必须进 content_parts，否则用户输入会丢', () => {
    const result = toWireContentParts([text('这张图什么意思'), IMAGE]);

    assert.equal(result?.length, 2);
    assert.deepEqual(result?.[0], { type: 'text', text: '这张图什么意思' });
    assert.deepEqual(result?.[1], {
      type: 'image',
      filename: '架构图.png',
      source: { type: 'url', value: 'mock-image-url-a1', mime_type: 'image/png' },
    });
  });

  it('只有图片、没有文字时不产生空 text 片段', () => {
    const result = toWireContentParts([IMAGE]);

    assert.equal(result?.length, 1);
    assert.equal(result?.[0]?.type, 'image');
  });

  it('保持 parts 的原始顺序（图片在前也是）', () => {
    const result = toWireContentParts([IMAGE, text('再说一句')]);

    assert.deepEqual(
      result?.map(item => item.type),
      ['image', 'text'],
    );
  });
});

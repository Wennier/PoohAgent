/**
 * ImageBlock 渲染测试（react-dom/server，不依赖 jsdom）。
 *
 * 图片本体没法在 node 里"看"，但结构可以钉死：
 * src / alt / 文件名、以及"用 maxWidth 而不是 width"这条产品约束。
 * 加载失败态由 onError 触发，属于浏览器行为，这里不覆盖（靠页面验收）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ImagePart } from '../src/message/type';
import { ImageBlock } from '../src/render/image-block';
import { renderPart } from '../src/render/part-renderer';

const PART: ImagePart = {
  type: 'image',
  url: 'https://example.com/chart.png',
  filename: 'chart.png',
  mimeType: 'image/png',
};

function render(): string {
  return renderToStaticMarkup(React.createElement(ImageBlock, { part: PART }));
}

describe('ImageBlock · 用户附件图片', () => {
  it('缩略图用 url 作 src、文件名作 alt', () => {
    const html = render();

    assert.match(html, /<img[^>]+src="https:\/\/example\.com\/chart\.png"/);
    assert.match(html, /alt="chart\.png"/);
  });

  it('文件名作为 caption 显示（图片挂了也知道是哪张）', () => {
    assert.match(render(), /<figcaption[^>]*>chart\.png<\/figcaption>/);
  });

  it('用 maxWidth 限制尺寸，而不是固定 width（小图不拉伸）', () => {
    const html = render();

    assert.match(html, /max-width:240px/);
    assert.doesNotMatch(html, /;width:240px/);
  });

  it('正常状态下不出现失败占位', () => {
    assert.doesNotMatch(render(), /图片加载失败/);
  });

  it('renderPart 把 image part 分发到 ImageBlock（switch 覆盖到位）', () => {
    const html = renderToStaticMarkup(React.createElement('div', null, renderPart(PART)));

    assert.match(html, /<img[^>]+src="https:\/\/example\.com\/chart\.png"/);
    assert.match(html, /<figcaption[^>]*>chart\.png<\/figcaption>/);
  });
});

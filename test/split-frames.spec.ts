/**
 * splitFrames 单测（纯函数，不碰网络）。
 *
 * 契约（来自 sse-parser.ts 的 JSDoc）：
 * - 返回的 frames **必须已经去掉 `data: ` 前缀**
 * - 缓冲区最后一段一律视为「可能不完整」→ 只进 rest，不进 frames
 * - 一帧内的多行 data 用 \n 连接
 * - 行尾 \n 与 \r\n 都要认
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { splitFrames } from '../src/transport/sse-parser';

const frame = (json: string): string => `data: ${json}\n\n`;

describe('splitFrames', () => {
  it('切出完整帧，并剥掉 data: 前缀', () => {
    const buffer = frame('{"type":"A"}') + frame('{"type":"B"}');
    const { frames, rest } = splitFrames(buffer);

    assert.deepEqual(frames, ['{"type":"A"}', '{"type":"B"}']);
    assert.equal(rest, '');
  });

  it('最后一段不完整时只进 rest，不能混进 frames', () => {
    const buffer = `${frame('{"type":"A"}')}data: {"type":"B"`;
    const { frames, rest } = splitFrames(buffer);

    assert.deepEqual(frames, ['{"type":"A"}']);
    assert.equal(rest, 'data: {"type":"B"');
  });

  it('空缓冲区返回空结果', () => {
    assert.deepEqual(splitFrames(''), { frames: [], rest: '' });
  });

  it('兼容 \\r\\n 行尾', () => {
    const buffer = frame('{"type":"A"}').replaceAll('\n', '\r\n');
    const { frames } = splitFrames(buffer);

    assert.deepEqual(frames, ['{"type":"A"}']);
  });

  it('一帧内多行 data 用 \\n 连接', () => {
    const buffer = 'data: {"a":1,\ndata: "b":2}\n\n';
    const { frames } = splitFrames(buffer);

    assert.deepEqual(frames, ['{"a":1,\n"b":2}']);
  });

  it('忽略非 data: 行（注释 / event: / id:）', () => {
    const buffer = ': 心跳\nevent: ping\ndata: {"type":"A"}\n\n';
    const { frames } = splitFrames(buffer);

    assert.deepEqual(frames, ['{"type":"A"}']);
  });

  it('数据里含 \\n 转义时不被误切（JSON 内的换行是转义字符）', () => {
    const buffer = frame('{"delta":"第一行\\n第二行"}');
    const { frames, rest } = splitFrames(buffer);

    assert.deepEqual(frames, ['{"delta":"第一行\\n第二行"}']);
    assert.equal(rest, '');
  });
});

/**
 * parseSseFrames 单测：同一段字节流，用五种切法喂进去，结果必须完全一致。
 *
 * 这是整个 Day 1 最关键的一组测试——它把「TCP 分片」「粘包」「UTF-8 跨 chunk」
 * 这三个线上最难复现的问题，变成可在本地稳定复现的用例。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSseFrames } from '../src/transport/sse-parser';

// ============================================================
// 测试工具
// ============================================================

/** 把一串预切好的 chunk 包装成 ReadableStream。 */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }

      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
}

async function collect(gen: AsyncGenerator<string, void, void>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const encoder = new TextEncoder();

/** 期望得到的 payload 列表（已去掉 data: 前缀）。 */
const EXPECTED = [
  '{"type":"RUN_STARTED","threadId":"t1"}',
  '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"你"}',
  '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"好"}',
  '{"type":"RUN_FINISHED","threadId":"t1"}',
];

/** 原始 SSE 文本：四帧，每帧以空行结尾。 */
const RAW = EXPECTED.map(payload => `data: ${payload}\n\n`).join('');

// ============================================================
// 五种切法
// ============================================================

describe('parseSseFrames 五种切法结果一致', () => {
  it('1) 一次性全部喂完', async () => {
    const frames = await collect(parseSseFrames(streamOf([encoder.encode(RAW)])));
    assert.deepEqual(frames, EXPECTED);
  });

  it('2) 每 1 个字节喂一次（最狠的分片）', async () => {
    const all = encoder.encode(RAW);
    const chunks = Array.from(all, byte => Uint8Array.of(byte));
    const frames = await collect(parseSseFrames(streamOf(chunks)));

    assert.deepEqual(frames, EXPECTED);
  });

  it('3) 切在 data: 这个词中间', async () => {
    const cut = RAW.indexOf('data: ') + 2;
    const chunks = [encoder.encode(RAW.slice(0, cut)), encoder.encode(RAW.slice(cut))];
    const frames = await collect(parseSseFrames(streamOf(chunks)));

    assert.deepEqual(frames, EXPECTED);
  });

  it('4) 一次喂两帧（粘包）', async () => {
    const first = `data: ${EXPECTED[0]}\n\ndata: ${EXPECTED[1]}\n\n`;
    const rest = `data: ${EXPECTED[2]}\n\ndata: ${EXPECTED[3]}\n\n`;
    const frames = await collect(parseSseFrames(streamOf([
      encoder.encode(first),
      encoder.encode(rest),
    ])));

    assert.deepEqual(frames, EXPECTED);
  });

  it('5) 混用 \\r\\n 行尾', async () => {
    const crlf = RAW.replaceAll('\n\n', '\r\n\r\n');
    const frames = await collect(parseSseFrames(streamOf([encoder.encode(crlf)])));

    assert.deepEqual(frames, EXPECTED);
  });
});

// ============================================================
// 编码与收尾
// ============================================================

describe('parseSseFrames 编码与收尾', () => {
  it('中文跨 chunk 截断不乱码（TextDecoder stream: true 的作用）', async () => {
    const text = 'data: {"delta":"你好世界"}\n\n';
    const all = encoder.encode(text);
    // 逐字节喂：必然把三字节的中文字符切开
    const chunks = Array.from(all, byte => Uint8Array.of(byte));
    const frames = await collect(parseSseFrames(streamOf(chunks)));

    assert.deepEqual(frames, ['{"delta":"你好世界"}']);
  });

  it('末帧缺少结尾空行时也要产出（收尾 flush）', async () => {
    const text = `data: ${EXPECTED[0]}\n\ndata: ${EXPECTED[1]}`;
    const frames = await collect(parseSseFrames(streamOf([encoder.encode(text)])));

    assert.deepEqual(frames, [EXPECTED[0], EXPECTED[1]]);
  });

  it('空流不产出任何帧，也不抛错', async () => {
    const frames = await collect(parseSseFrames(streamOf([])));
    assert.deepEqual(frames, []);
  });

  it('流正常结束后不得抛错（守住遗留的占位 throw）', async () => {
    await assert.doesNotReject(async () => {
      await collect(parseSseFrames(streamOf([encoder.encode(RAW)])));
    });
  });
});

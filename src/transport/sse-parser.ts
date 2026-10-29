/**
 * SSE 帧解析：字节流 → 一帧一帧的 data 文本。
 *
 * 这一层只解决"字节学"问题，不认识任何 AG-UI 语义：
 * - TCP 可能把一帧切成多段（一帧跨 chunk）
 * - 也可能一次给你好几帧（粘包）
 * - UTF-8 多字节字符可能被切断（中文乱码的唯一原因）
 * - 行尾可能是 \r\n 也可能是 \n
 *
 * 分成两个函数的好处：
 * - splitFrames 是纯函数，可以不碰网络直接单测（五种切法都靠它验）
 * - parseSseFrames 只负责读流 + 解码 + 把两者接起来
 */

/**
 * 一次切分的结果。
 *
 * 为什么要返回 rest：缓冲区里最后那段可能是不完整的帧，必须留到下次继续拼。
 */
export interface FrameSplitResult {
  /** 已经完整的帧（已去掉 `data: ` 前缀与尾部空行）。 */
  frames: string[];
  /** 尚未完整的残余，留给下一次调用。 */
  rest: string;
}

/**
 * 从缓冲区里切出所有完整的帧（纯函数）。
 *
 * 做什么：给定当前缓冲区，返回「能确定的完整帧」+「剩下的残片」。
 *
 * @param buffer 累积的文本缓冲区
 * @returns 完整帧数组与残余文本
 *
 * 帧的形态（每帧之间用一个空行分隔）：
 *
 *   data: {"type":"RUN_STARTED"}
 *   ⏎
 *   data: {"type":"TEXT_MESSAGE_CONTENT","delta":"你"}
 *   ⏎
 *
 * 边界（这几条错了会非常难查，务必逐条覆盖）：
 * - 分隔符可能是 `\n\n` 也可能是 `\r\n\r\n`，两种都要认
 * - 一帧里可能有多行 `data:`（多行 payload），按规范要用 `\n` 连接，不是直接拼
 * - 只认 `data:` 开头的行；注释行（以 `:` 开头）、`event:`、`id:` 今天可以忽略
 * - 残留必须原样返回，不能丢字节，否则下一帧会缺字符
 */
export function splitFrames(buffer: string): FrameSplitResult {
  const normalizedBuffer = buffer.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const rawFrames = normalizedBuffer.split('\n\n');
  const rest = rawFrames.pop() ?? '';
  const frames: string[] = [];

  for (const rawFrame of rawFrames) {
    const dataLines = rawFrame
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map((line) => {
        const data = line.slice('data:'.length);
        return data.startsWith(' ') ? data.slice(1) : data;
      });

    if (dataLines.length > 0) {
      frames.push(dataLines.join('\n'));
    }
  }

  return { frames, rest };
}

/**
 * 从响应流里逐帧产出 data 文本。
 *
 * 做什么：读 ReadableStream，把字节累积到缓冲区，凑够一帧就 yield 一帧。
 *
 * @param stream fetch 返回的 `res.body`（必须非 null）
 * @returns 异步生成器，逐帧产出
 *
 * 边界：
 * - `decoder.decode(value, { stream: true })` 里的 `stream: true` **必须加**，
 *   否则中文会被切成乱码（表现为"偶尔某个字变成 �"，取决于 TCP 在哪切开）
 * - 流结束时要把缓冲区里最后的残留也产出去（可能还有一帧没有尾随空行）
 * - 读到 done 后不要忘记 releaseLock（或让生成器自然结束）
 */
export async function* parseSseFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  // 步骤 1：const reader = stream.getReader()
  // 步骤 2：const decoder = new TextDecoder('utf-8')，let buffer = ''
  // 步骤 3：while (true)
  //           const { done, value } = await reader.read()
  //           if (done) break
  //           buffer += decoder.decode(value, { stream: true })
  //           const { frames, rest } = splitFrames(buffer)
  //           buffer = rest
  //           for (const frame of frames) yield frame
  // 步骤 4：流结束后收尾 —— 把 buffer 里剩余内容也交给 splitFrames，产出遗留帧
  // TODO(wendy): 实现上面四步

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      // ？TODO: 这里需要处理 buffer 里剩余的内容，为什么不要这行
      const tail = splitFrames(`${buffer}\n\n`);   // 人为补一个帧分隔符
      for (const frame of tail.frames) yield frame;
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = splitFrames(buffer);
    buffer = rest;
    for (const frame of frames) yield frame;
  }
}

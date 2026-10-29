/**
 * 事件解析：一帧 data 文本 → AgentEvent 对象。
 *
 * 这一层只解决"JSON 学"问题，不理解语义、不做业务判断。
 * 和 sse-parser 分开的意义：出问题时能一眼定位是"字节切错了"还是"JSON 解析错了"。
 */

import type { AgentEvent } from './types';

/**
 * 把一帧文本解析成事件对象（纯函数，可直接单测）。
 *
 * @param frame 已去掉 `data: ` 前缀的单帧文本（可能含多行，已用 \n 连接）
 * @returns 事件对象；解析失败返回 null
 *
 * 边界（决定你的流会不会被一帧坏数据毁掉）：
 * - **解析失败必须返回 null，不能抛错**。一帧坏了不该让整条流断掉。
 * - 解析出来的不是对象（比如是 `"abc"` 或 `123`）也返回 null。
 * - 缺 `type` 字段同样返回 null —— 没有 type 的"事件"对下游毫无意义。
 * - **未知 type 必须原样返回**，不要过滤。Day 3 接 TOOL_CALL_* 时你才会感谢自己没过滤。
 */
export function parseFrame(frame: string): AgentEvent | null {
  // 步骤 1：trim 后为空 → return null
  // 步骤 2：try { JSON.parse } catch { return null }
  // 步骤 3：不是对象 / 没有 string 类型的 type → return null
  // 步骤 4：return parsed as AgentEvent
  // TODO(wendy): 实现上面四步
  const frameContent = frame.trim();
  if (frameContent === '') return null;
  try {
    const parsed = JSON.parse(frameContent);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.type !== 'string') return null;
    return parsed as AgentEvent;
  } catch (error) {
    return null;
  }
}

/**
 * 把帧序列流式解析成事件流。
 *
 * @param frames 来自 parseSseFrames 的帧文本
 * @returns 异步生成器；解析失败的帧被跳过（不中断整条流）
 */
export async function* parseAgentEvents(
  frames: AsyncGenerator<string, void, void>,
): AsyncGenerator<AgentEvent, void, void> {
  // 步骤 1：for await (const frame of frames)
  // 步骤 2：const event = parseFrame(frame)
  // 步骤 3：event 为 null → console.warn('[transport] 跳过无法解析的帧') 并 continue
  // 步骤 4：否则 yield event
  // TODO(wendy): 实现上面四步
  for await (const frame of frames) {
    const event = parseFrame(frame);
    if (event === null) {
      console.warn('[transport] 跳过无法解析的帧');
      continue;
    }

    yield event;
  }
}

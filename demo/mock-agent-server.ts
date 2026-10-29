/**
 * Mock agentgateway server —— Day 1 骨架版。
 *
 * 这个文件里你要实现的只有 3 个函数，其余都是常量与样板：
 *
 *   ① splitToDeltas —— 把长文本切成 token 流（决定"看起来像不像在逐字输出"）
 *   ② buildScript   —— 请求 + 会话 ID → 完整事件数组（决定"协议长什么样"）
 *   ③ writeEvent    —— 一条事件 → 一个 SSE 帧写进响应流（决定"帧边界对不对"）
 *
 * 数据流：
 *
 *   curl / 浏览器
 *        │ POST /api/v6/agentgateway/chat
 *        ▼
 *   §4 HTTP 层（样板，已实现，不用读懂）
 *        │ 解析出 { thread_id, messages, contexts }
 *        ▼
 *   ② buildScript  ── 产出事件数组 [RUN_STARTED, TEXT_MESSAGE_START, CONTENT×N, …]
 *        │ 逐条
 *        ▼
 *   ③ writeEvent   ── 每条事件写成一帧 `data: {...}\n\n`
 *        │
 *        ▼
 *   客户端逐帧解析 → 触发 TEXT_MESSAGE_CONTENT 的回调
 *
 * 启动：
 *   node_modules/.bin/tsx packages/@ai/wendy-agent-chat/demo/mock-agent-server.ts
 *
 * 验证（-N 必须带，否则看不到逐行到达）：
 *   curl -N -X POST 'http://localhost:3002/api/v6/agentgateway/chat' \
 *     -H 'Content-Type: application/json' \
 *     -d '{"thread_id":"","messages":[{"role":"user","content":"你好"}],"contexts":[{"channel":"doc"}]}'
 *
 * 阅读顺序：§1 类型 → §2 脚本层 → §3 传输层 →（§4 跳过）
 */

import http from 'node:http';

// ============================================================
// §1 常量与类型（已给好，只需理解，不用修改）
// ============================================================

const PORT = 3002;

/** 与 vite proxy 的目标一致；真实后端也是这个路径。 */
const CHAT_PATH = '/api/v6/agentgateway/chat';

/** 两帧之间的间隔。太小浏览器会合并成一批，就看不出"流式"了。 */
const FRAME_DELAY_MS = 90;

/**
 * 请求里的一条消息（wire 格式）。
 *
 * 注意这里是 **snake_case**，因为用的是后端协议；而响应事件是 camelCase。
 * 这个不一致是最容易反复踩的点，写的时候留意。
 */
interface WireMessage {
  id?: string;
  role: string;
  content?: string;
  /** 多模态内容；Day 4 发图片/文档引用时才会用到。 */
  content_parts?: unknown[];
  tool_call_id?: string;
  tool_calls?: unknown[];
}

/** 一次 /chat 请求的 body。 */
interface ChatInput {
  /** 新会话传空串；网关只在 RUN_STARTED 里回填真实 ID。 */
  thread_id?: string;
  messages?: WireMessage[];
  /** 网关只取第一个元素。 */
  contexts?: { channel?: string; language?: string; params?: string }[];
}

/**
 * 所有 AG-UI 事件的公共字段。
 *
 * threadId 我们每一帧都带上，方便你在一堆日志里确认"这是同一条流"。
 */
interface BaseEvent {
  type: string;
  timestamp: number;
  threadId: string;
}

/** 具体事件 = 公共字段 + 该事件特有的字段（messageId / delta / …）。 */
type MockEvent = BaseEvent & Record<string, unknown>;

/**
 * 一帧的写出方式（传输层开关）。
 *
 * ⚠️ 本轮不实现，只是先定义好形状，让你知道"分片能力将来接在哪一层"。
 * 下一轮加它时只改 writeEvent 一个函数，脚本层与 HTTP 层都不用动。
 *
 * - split:   把一帧均分成 N 段写、段间等 20ms → 模拟 TCP 分片
 * - batch:   与上一帧背靠背写、不加延迟     → 模拟粘包（一个 chunk 收到多帧）
 * - delayMs: 本帧写完后等多久再写下帧       → 控制流速，方便点中止
 */
interface WriteOptions {
  split?: number;
  batch?: boolean;
  delayMs?: number;
}

/** 假回复。刻意包含中文、Markdown 列表、代码块，用来验证渲染与编码。 */
const MOCK_REPLY = [
  '你好，我是本地 mock agent。',
  '',
  '这段话验证三件事：**流式到达**、Markdown 渲染、中文字符跨 chunk 不乱码。',
  '',
  '- 事件按序到达，不应跳跃',
  '- 每帧间隔约 90ms',
  '- 结束后应收到 RUN_FINISHED',
  '',
  '```ts',
  'const ok = \'SSE 解析正常\';',
  'console.log(ok);',
  '```',
].join('\n');

/** Markdown 覆盖清单：用来肉眼验收渲染能力，覆盖 10 种常见语法。 */
const MOCK_MARKDOWN_REPLY = [
  '### 渲染覆盖清单',
  '',
  '**粗体**、*斜体*、~~删除线~~、`行内代码`、[一个链接](https://docs.qq.com)。',
  '',
  '1. 有序列表第一项',
  '2. 第二项',
  '   - 嵌套无序',
  '3. 第三项',
  '',
  '> 引用块：这段用来验证左边框与缩进。',
  '',
  '| 元素 | 是否支持 |',
  '| --- | --- |',
  '| 表格 | 是 |',
  '| 代码块 | 是 |',
  '',
  '```ts',
  'interface Part {',
  '  type: \'text\' | \'tool\';',
  '}',
  '```',
  '',
  '---',
  '',
  '最后一段普通文本，验证段落间距与分隔线。',
].join('\n');

// ============================================================
// §2 剧本层 —— 你要实现 ① ②
// ============================================================

/**
 * ① 把长文本切成不等长片段，模拟真实的 token 流。
 *
 * 做什么：返回一组字符串，拼起来必须**严格等于**入参 text。
 * 为什么需要：真实模型是一个 token 一个 token 返回的，
 *             如果这里直接返回整段，客户端就永远测不到"增量追加"的逻辑。
 *
 * @param text 待切分的完整文本
 * @returns 片段数组；`result.join('') === text` 必须恒成立
 *
 * 边界：
 * - 空字符串 → 返回空数组（不是 ['']）
 * - 允许把中文/emoji 从中间切开（真实场景会这样，正好用来测多字节）
 */
function splitToDeltas(text: string): string[] {
  // 步骤 1：准备 cursor = 0 与 deltas: string[] = []
  // 步骤 2：while cursor < text.length
  //            step = 1~5 之间的随机整数
  //            deltas.push(text.slice(cursor, cursor + step))
  //            cursor += step
  // 步骤 3：return deltas
  // TODO(wendy): 实现上面三步
  const deltas: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const step = Math.floor(Math.random() * 5) + 1;
    deltas.push(text.slice(cursor, cursor + step));
    cursor += step;
  }

  return deltas;
}

/**
 * ② 请求 + 会话 ID → 完整事件数组。
 *
 * 做什么：按协议顺序产出这一轮对话的全部事件。
 * 为什么这么设计：它是**纯函数**（不碰网络、不 sleep、不读时间戳以外的东西），
 *                所以可以直接单测「事件类型序列是否正确」，不需要起 server。
 *
 * @param input     已解析的请求体（messages 现在用不上，Day 6 做 HITL 才需要）
 * @param threadId  已经定好的会话 ID（新会话由 §4 的 resolveThreadId 生成）
 * @returns 有序事件数组，第一条必须是 RUN_STARTED，最后一条必须是 RUN_FINISHED
 *
 * 必须产出的事件顺序（normal 场景）：
 *   RUN_STARTED
 *   TEXT_MESSAGE_START  { messageId, role: 'assistant' }
 *   TEXT_MESSAGE_CONTENT{ messageId, delta } × N     ← 由 ① 的片段驱动
 *   TEXT_MESSAGE_END    { messageId }
 *   RUN_FINISHED
 *
 * 边界：
 * - 所有事件的 threadId 必须与入参一致（客户端靠它确认"还是同一条流"）
 * - TEXT_MESSAGE_CONTENT 的 messageId 必须与 START 的一致（客户端靠它定位追加到哪条消息）
 * - timestamp 用 Date.now()，可以让多条事件共享同一个毫秒值，不影响
 */
/** 剧本。当前只需要 normal 与 tool，其余场景等做到那一步再加。 */
type Scenario = 'normal' | 'tool' | 'markdown';

const KNOWN_SCENARIOS: readonly Scenario[] = ['normal', 'tool', 'markdown'];

/** 从 query 选剧本；不认识的取值回落 normal，避免手抖打错就 500。 */
function resolveScenario(url: URL): Scenario {
  const raw = url.searchParams.get('scenario');
  if (!raw) return 'normal';

  if ((KNOWN_SCENARIOS as readonly string[]).includes(raw)) return raw as Scenario;

  console.warn(`[mock] 未知 scenario="${raw}"，回落到 normal`);
  return 'normal';
}

function buildScript(scenario: Scenario, input: ChatInput, threadId: string): MockEvent[] {
  if (scenario === 'tool') return buildToolScript(input, threadId);

  return buildNormalScript(input, threadId, scenario === 'markdown' ? MOCK_MARKDOWN_REPLY : MOCK_REPLY);
}

// -- 剧本一：纯文本 --------------------------------------------------

function buildNormalScript(input: ChatInput, threadId: string, reply: string = MOCK_REPLY): MockEvent[] {
  const messageId = `msg_${Date.now()}_assistant`;
  const events: MockEvent[] = [
    { type: 'RUN_STARTED', timestamp: Date.now(), threadId },
    { type: 'TEXT_MESSAGE_START', timestamp: Date.now(), threadId, messageId, role: 'assistant' },
  ];

  for (const delta of splitToDeltas(reply)) {
    events.push({ type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), threadId, messageId, delta });
  }

  events.push({ type: 'TEXT_MESSAGE_END', timestamp: Date.now(), threadId, messageId });
  events.push({ type: 'RUN_FINISHED', timestamp: Date.now(), threadId });

  return events;
}

// -- 剧本二：带工具调用 ----------------------------------------------

/** 工具名与现网命名风格一致（camelCase）；Day 6 的 AskUserQuestion 必须一字不差。 */
const TOOL_NAME = 'webSearch';

/** 工具参数：含中文，且下发时会被切成 3 片，用来验证"分片累积后再解析"。 */
const TOOL_ARGS = JSON.stringify({ query: '北京天气' });

/** 工具结果：纯文本，模拟 ACP rawOutput 提取后的内容。 */
const TOOL_RESULT = JSON.stringify({ city: '北京', weather: '晴', tempC: 28 });

const TOOL_INTRO = '我先用 webSearch 查一下北京的天气。';
const TOOL_CONCLUSION = '北京今天晴，气温 28°C。需要我再查别的城市吗？';

/** 把字符串均分成 parts 片；故意允许切断中文，用来测多字节与残片拼接。 */
function splitInto(text: string, parts: number): string[] {
  const size = Math.ceil(text.length / parts);
  const out: string[] = [];

  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));

  return out;
}

/**
 * 工具调用剧本。事件顺序照 `workspace-kit/docs/api-protocol.md` §3.4：
 *
 *   TEXT(引导) → TOOL_CALL_START → ARGS×3 → TOOL_CALL_END
 *   → TEXT_MESSAGE_END(第一条) → TOOL_CALL_RESULT → TEXT(结论) → RUN_FINISHED
 *
 * 两个刻意的设计：
 * - ARGS 分 3 片下发，且可能切在中文中间
 * - **不发 parentMessageId**：现网协议 §3.4 里没有这个字段（已核对），
 *   所以"结果属于哪条消息"只能靠"当前正在写的消息"或快照侧的顺序推断
 */
function buildToolScript(input: ChatInput, threadId: string): MockEvent[] {
  const now = Date.now();
  const introMessageId = `msg_${now}_assistant_a`;
  const conclusionMessageId = `msg_${now}_assistant_b`;
  const toolCallId = `call_${now}`;
  const resultMessageId = `msg_${now}_tool`;

  const events: MockEvent[] = [
    { type: 'RUN_STARTED', timestamp: Date.now(), threadId },
    { type: 'TEXT_MESSAGE_START', timestamp: Date.now(), threadId, messageId: introMessageId, role: 'assistant' },
  ];

  for (const delta of splitToDeltas(TOOL_INTRO)) {
    events.push({ type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), threadId, messageId: introMessageId, delta });
  }

  events.push({ type: 'TOOL_CALL_START', timestamp: Date.now(), threadId, toolCallId, toolCallName: TOOL_NAME });

  for (const delta of splitInto(TOOL_ARGS, 3)) {
    events.push({ type: 'TOOL_CALL_ARGS', timestamp: Date.now(), threadId, toolCallId, delta });
  }

  events.push(
    { type: 'TOOL_CALL_END', timestamp: Date.now(), threadId, toolCallId },
    { type: 'TEXT_MESSAGE_END', timestamp: Date.now(), threadId, messageId: introMessageId },
    {
      type: 'TOOL_CALL_RESULT',
      timestamp: Date.now(),
      threadId,
      messageId: resultMessageId,
      toolCallId,
      content: TOOL_RESULT,
    },
    { type: 'TEXT_MESSAGE_START', timestamp: Date.now(), threadId, messageId: conclusionMessageId, role: 'assistant' },
  );

  for (const delta of splitToDeltas(TOOL_CONCLUSION)) {
    events.push({
      type: 'TEXT_MESSAGE_CONTENT',
      timestamp: Date.now(),
      threadId,
      messageId: conclusionMessageId,
      delta,
    });
  }

  events.push(
    { type: 'TEXT_MESSAGE_END', timestamp: Date.now(), threadId, messageId: conclusionMessageId },
    { type: 'RUN_FINISHED', timestamp: Date.now(), threadId },
  );

  return events;
}

// ============================================================
// §3 传输层 —— 你要实现 ③
// ============================================================

/**
 * ③ 把一条事件写成一帧 SSE。
 *
 * 做什么：`事件对象` → `data: {json}\n\n` 写进响应流。
 * 为什么单独抽出来：分片/粘包将来加在这一层，脚本层与 HTTP 层完全无感。
 *
 * @param res   Node 响应对象；调用前必须已 writeHead 且 flushHeaders
 * @param event 一条 AG-UI 事件，内部会 JSON.stringify
 * @param _opts  传输开关；本轮固定不传（见 §1 WriteOptions 注释）。
 *               下划线前缀表示「本轮未使用」，等加分片时再启用。
 *
 * 边界（这几条错了会非常难查）：
 * - 一帧必须以**空行**结尾（`\n\n`），否则客户端会把下一帧当成同帧的续行
 * - 不要 pretty-print JSON（多行 data 需要额外拼接，平白增加解析复杂度）
 * - 分片时必须在本函数内串行写完，不能并发 write，否则两帧内容会交错
 */
function writeEvent(res: http.ServerResponse, event: MockEvent, _opts?: WriteOptions): void {
  // 步骤 1：const frame = `data: ${JSON.stringify(event)}\n\n`
  // 步骤 2：res.write(frame)
  // 步骤 3：if (_opts?.split) { …分批写… }  ← 本轮跳过，保留思考位
  // 步骤 4：日志打印事件类型，方便和客户端逐条对照
  // TODO(wendy): 实现上面（本轮只要步骤 1、2、4）
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  res.write(frame);
  console.log(`[mock] 已写入事件：${event.type}`);
}

/** 等待 ms 毫秒。已给好，直接用。 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// §4 HTTP 层 —— ⚠️ 样板代码，不需要读懂（已实现）
// ============================================================

/** 手动读 body（不用框架 parser，避免它把流式意图吞掉）。 */
async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }

  return Buffer.concat(chunks).toString('utf8');
}

/** body 解析失败时按空请求处理，让 mock 不要因为手抖的 curl 直接 500。 */
function parseChatInput(raw: string): ChatInput {
  if (!raw.trim()) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as ChatInput;
  } catch {
    console.warn('[mock] body 不是合法 JSON，按空请求处理');
    return {};
  }
}

/**
 * 决定这一轮用哪个会话 ID。
 *
 * 新会话（请求 thread_id 为空串）**由服务端生成**并通过 RUN_STARTED 返回。
 * 客户端必须从事件里读 ID，而不是自己造 —— mock 借此暴露错误实现。
 */
function resolveThreadId(input: ChatInput): string {
  const incoming = input.thread_id?.trim();
  return incoming || `thread_${Date.now()}`;
}

function readUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://localhost:${PORT}`);
}

/** 一次 /chat 的完整处理：解析 → 造脚本 → 逐帧写 → 收尾。 */
async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = readUrl(req);
  const rawBody = await readBody(req);
  const input = parseChatInput(rawBody);
  const threadId = resolveThreadId(input);
  const scenario = resolveScenario(url);

  console.log(
    `[mock] ← POST thread_id=${JSON.stringify(input.thread_id ?? '')} ` +
      `channel=${input.contexts?.[0]?.channel ?? '(未传)'} messages=${
        input.messages?.length ?? 0
      } scenario=${scenario}`,
  );

  // 流式响应头。不能设 Content-Length，否则浏览器会等整个 body 到齐才展示。
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  res.flushHeaders?.();

  const events = buildScript(scenario, input, threadId);
  const startedAt = Date.now();

  // 客户端断开后必须立刻停止生产：`res.writableEnded` 只在「我方主动 end」后为 true，
  // 客户端中止时它仍是 false，只靠它会继续写、继续打日志，污染两边对照。
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  for (const event of events) {
    if (clientGone || res.writableEnded) return;
    writeEvent(res, event);
    await delay(FRAME_DELAY_MS);
  }

  res.end();
  console.log(`[mock] ✓ done (${events.length} events, ${Date.now() - startedAt}ms)`);
}

const server = http.createServer((req, res) => {
  const url = readUrl(req);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-XSRF-TOKEN');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  if (url.pathname !== CHAT_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Not Found: ${url.pathname}`);
    return;
  }

  void handleChat(req, res).catch((error: unknown) => {
    console.error('[mock] handler failed:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    if (!res.writableEnded) res.end('mock server error');
  });
});

server.listen(PORT, () => {
  console.log(`[mock] listening on http://localhost:${PORT}${CHAT_PATH}`);
  console.log('[mock] 骨架版：buildScript/writeEvent 还是空的，填完再看 curl 输出');
});

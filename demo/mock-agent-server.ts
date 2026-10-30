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

import { eventsToWireMessages } from './script-to-wire';

// ============================================================
// §1 常量与类型（已给好，只需理解，不用修改）
// ============================================================

const PORT = 3002;

/** 与 vite proxy 的目标一致；真实后端也是这个路径。 */
const CHAT_PATH = '/api/v6/agentgateway/chat';
/** 会话列表（Day 5 / E1）。 */
const RUNTIMES_PATH = '/api/v6/agentgateway/runtimes';
/** 历史消息（Day 5 / A4）。 */
const HISTORY_PATH = '/api/v6/agentgateway/history';

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
  /** 多模态内容；当前只用到 text / image。 */
  content_parts?: WireContentPart[];
  tool_call_id?: string;
  tool_calls?: unknown[];
}

/** 与 src/transport/types 的 WireContentPart 对齐（mock 独立运行，不 import 源码）。 */
interface WireContentPart {
  type: string;
  text?: string;
  filename?: string;
  source?: { type: 'url' | 'data'; value: string; mime_type?: string };
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

// ============================================================
// §1.5 内存会话表（Day 5：/runtimes 与 /history 的数据源）
// ============================================================

/**
 * 一轮是否还在跑。
 *
 * 客户端拿它决定「只渲染历史」还是「提示仍在生成」。
 * 当前 mock 是同步流，所以 in_progress 只会出现在流进行中的那一小段时间。
 */
type DisplayState = 'ready' | 'in_progress' | 'needs_input';

interface ThreadRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 扁平 wire 消息；工具调用会存成 assistant(tool_calls) + tool + assistant 三段。 */
  messages: WireMessage[];
  displayState: DisplayState;
}

/**
 * 会话表只活在内存里：重启即丢。
 *
 * 这是**过渡实现**——落盘（SQLite / 文件）是「本地持久化」那一项的事，
 * 但 `/history` 的响应形状现在定死，之后换实现客户端不用改。
 */
const threads = new Map<string, ThreadRecord>();

/**
 * 每次 run 的递增序号。
 *
 * 消息 id 必须**跨轮唯一**：否则同一会话第二轮又生成 wire_1，
 * 客户端按 id 做 React key 时会出现「两个 children 用同一个 key」。
 */
let runSequence = 0;

/** 列表标题长度上限（与 demo 侧保持一致）。 */
const MAX_TITLE_LENGTH = 20;

/** 取一条 wire 消息的可见文本（content_parts 的 text 优先）。 */
function messageText(message: WireMessage): string {
  const parts = message.content_parts ?? [];
  const fromParts = parts
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text ?? '')
    .join('');

  return fromParts || message.content || '';
}

/** 标题 = 首条用户消息前 20 字；取不到就「未命名」。 */
function titleOf(messages: WireMessage[]): string {
  const firstUser = messages.find(message => message.role === 'user');
  const text = firstUser ? messageText(firstUser).trim() : '';
  if (text === '') return '未命名';

  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH)}…` : text;
}

function ensureThread(threadId: string): ThreadRecord {
  const existing = threads.get(threadId);
  if (existing) return existing;

  const now = Date.now();
  const created: ThreadRecord = {
    id: threadId,
    title: '未命名',
    createdAt: now,
    updatedAt: now,
    messages: [],
    displayState: 'ready',
  };
  threads.set(threadId, created);

  return created;
}

/**
 * 收到 /chat 时先落 user 消息，并把会话标记为「生成中」。
 *
 * 这个顺序很重要：中途刷新时历史里应该是「有提问、没回答」，
 * 而不是整轮消失——那才是真实后端的行为。
 */
function appendUserMessage(threadId: string, message: WireMessage): void {
  const record = ensureThread(threadId);
  record.messages.push(message);
  record.displayState = 'in_progress';
  record.updatedAt = Date.now();
  if (record.title === '未命名') record.title = titleOf(record.messages);
}

/** 流结束后把本轮产出的事件还原成 wire 消息追加进历史。 */
function completeRun(threadId: string, events: MockEvent[]): void {
  const record = ensureThread(threadId);
  runSequence += 1;
  record.messages.push(...eventsToWireMessages(events, `${threadId}_${runSequence}`));
  record.displayState = 'ready';
  record.updatedAt = Date.now();
}

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
/** 内容剧本。 */
type ContentScenario = 'normal' | 'tool' | 'markdown';

const KNOWN_SCENARIOS: readonly ContentScenario[] = ['normal', 'tool', 'markdown'];

/**
 * 错误剧本（Day 6 复现用）。每种错误类型一条 URL：
 * - `error-run[:业务码]` 先吐半句再 RUN_ERROR（run 类，默认 439906）
 * - `http-<状态码>`      直接非 2xx（query 类；429 带 Retry-After）
 * - `cut[:帧数]`         吐 N 帧后掐断 socket（stream 类）
 * - `reset`              不回任何字节就断（连接错误）
 */
type ErrorScenario =
  | { kind: 'run'; code: string }
  | { kind: 'http'; status: number }
  | { kind: 'cut'; after: number }
  | { kind: 'reset' };

/** 业务码 → 文案。未知码不猜。 */
const RUN_ERROR_MESSAGES: Record<string, string> = {
  '439902': '未登录',
  '439903': '无权访问该文档',
  '439906': '请求太频繁，请稍后再试',
  '439907': '积分不足',
};

type ResolvedScenario = { content: ContentScenario } | { error: ErrorScenario };

/** 从 query 选剧本；不认识的取值回落 normal，避免手抖打错就 500。 */
function resolveScenario(url: URL): ResolvedScenario {
  const raw = url.searchParams.get('scenario');
  if (!raw) return { content: 'normal' };

  const [name, arg] = raw.split(':');

  if (name === 'error-run') return { error: { kind: 'run', code: arg || '439906' } };
  if (name === 'reset') return { error: { kind: 'reset' } };

  if (name === 'cut') {
    const after = Number(arg ?? 2);
    return { error: { kind: 'cut', after: Number.isInteger(after) && after > 0 ? after : 2 } };
  }

  if (name.startsWith('http-')) {
    const status = Number(name.slice(5));
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return { error: { kind: 'http', status } };
    }
  }

  if ((KNOWN_SCENARIOS as readonly string[]).includes(raw)) return { content: raw as ContentScenario };

  console.warn(`[mock] 未知 scenario="${raw}"，回落到 normal`);
  return { content: 'normal' };
}

/**
 * 从最后一条 **user** 消息里数图片，回一句「收到 N 张图片」。
 *
 * 不能直接取 messages 的末尾：客户端提交时末尾是 assistant 占位（parts 为空）。
 * 返回空串表示这轮没带图，调用方不要拼前缀。
 */
function describeIncomingImages(input: ChatInput): string {
  const lastUser = [...(input.messages ?? [])].reverse().find(message => message.role === 'user');
  const images = (lastUser?.content_parts ?? []).filter(part => part.type === 'image');

  if (images.length === 0) return '';

  const names = images.map((part, index) => part.filename ?? `image-${index + 1}`);
  return `收到 ${images.length} 张图片：${names.join('、')}。`;
}

function buildScript(scenario: ContentScenario, input: ChatInput, threadId: string): MockEvent[] {
  if (scenario === 'tool') return buildToolScript(input, threadId);

  const reply = scenario === 'markdown' ? MOCK_MARKDOWN_REPLY : MOCK_REPLY;
  const imageNote = describeIncomingImages(input);

  return buildNormalScript(input, threadId, imageNote === '' ? reply : `${imageNote}\n\n${reply}`);
}

/**
 * run / cut 的错误剧本。
 *
 * cut 刻意不补 RUN_FINISHED，由调用方吐够帧数后 destroy socket：
 * 正常 `end()` 是"流结束了"，只有掐断才是"流中断"，两者在客户端走完全不同的分支。
 */
function buildErrorScript(error: ErrorScenario, threadId: string): MockEvent[] {
  const messageId = `msg_${Date.now()}_assistant`;
  const events: MockEvent[] = [
    { type: 'RUN_STARTED', timestamp: Date.now(), threadId },
    { type: 'TEXT_MESSAGE_START', timestamp: Date.now(), threadId, messageId, role: 'assistant' },
  ];

  // 先吐一点正文：保证"屏幕上有半截回答"这个现象成立，否则复现不出"用户以为说完了"
  for (const delta of splitToDeltas('北京今天晴，气温 28°C。').slice(0, 3)) {
    events.push({ type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), threadId, messageId, delta });
  }
  events.push({ type: 'TEXT_MESSAGE_END', timestamp: Date.now(), threadId, messageId });

  if (error.kind === 'run') {
    const message = RUN_ERROR_MESSAGES[error.code] ?? `生成失败（${error.code}）`;
    events.push({ type: 'RUN_ERROR', timestamp: Date.now(), threadId, code: error.code, message });
  }

  return events;
}

/** 非 2xx。429 带 Retry-After，用来验证"尊重 Retry-After"。 */
function sendHttpError(res: http.ServerResponse, status: number): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (status === 429) headers['Retry-After'] = '3';
  res.writeHead(status, headers);
  res.end(JSON.stringify({ error: { code: `http_${status}` } }));
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
  const resolved = resolveScenario(url);

  // 取最后一条 user：客户端提交时末尾还有一条空的 assistant 占位，不能直接取末尾
  const incomingUser = [...(input.messages ?? [])].reverse().find(message => message.role === 'user');
  if (incomingUser) {
    appendUserMessage(threadId, { ...incomingUser, id: incomingUser.id ?? `user_${Date.now()}` });
  }

  console.log(
    `[mock] ← POST thread_id=${JSON.stringify(input.thread_id ?? '')} ` +
      `channel=${input.contexts?.[0]?.channel ?? '(未传)'} messages=${
        input.messages?.length ?? 0
      } scenario=${url.searchParams.get('scenario') ?? 'normal'}`,
  );

  // 连接级与 HTTP 级错误必须在写 SSE 头之前返回：
  // 一旦 writeHead(200) 发出去，浏览器就进入流模式，4xx/5xx 就没法再表达了。
  if ('error' in resolved) {
    if (resolved.error.kind === 'reset') {
      req.socket.destroy();
      console.log('[mock] ✂ reset：未回任何字节即断开');
      return;
    }

    if (resolved.error.kind === 'http') {
      sendHttpError(res, resolved.error.status);
      console.log(`[mock] ✗ http-${resolved.error.status}`);
      return;
    }
  }

  // 流式响应头。不能设 Content-Length，否则浏览器会等整个 body 到齐才展示。
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  res.flushHeaders?.();

  const events =
    'error' in resolved
      ? buildErrorScript(resolved.error, threadId)
      : buildScript(resolved.content, input, threadId);
  const cutAfter = 'error' in resolved && resolved.error.kind === 'cut' ? resolved.error.after : null;
  const startedAt = Date.now();

  // 客户端断开后必须立刻停止生产：`res.writableEnded` 只在「我方主动 end」后为 true，
  // 客户端中止时它仍是 false，只靠它会继续写、继续打日志，污染两边对照。
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  for (const [index, event] of events.entries()) {
    if (clientGone || res.writableEnded) break;

    // cut 剧本：吐够帧数就掐断 socket。用 destroy 而不是 end —— 前者是"流中断"，后者是"流正常结束"
    if (cutAfter !== null && index >= cutAfter) {
      res.destroy();
      console.log(`[mock] ✂ cut：已吐 ${index} 个事件后断开`);
      return;
    }

    writeEvent(res, event);
    await delay(FRAME_DELAY_MS);
  }

  // 客户端中途断开也把这一轮落进历史：mock 的脚本是预生成的，
  // 落完整结果比留一条「生成中」更接近真实后端（真实后端会继续跑完）。
  completeRun(threadId, events);

  if (!clientGone && !res.writableEnded) res.end();
  console.log(
    `[mock] ✓ done (${events.length} events, ${Date.now() - startedAt}ms${
      clientGone ? ', client gone' : ''
    })`,
  );
}

// ============================================================
// §5 会话列表 / 历史（Day 5）
// ============================================================

interface RuntimesBody {
  cursor?: string;
  limit?: number;
}

interface HistoryBody {
  thread_id?: string;
  cursor?: string;
  limit?: number;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseJsonBody<T>(raw: string): T {
  if (!raw.trim()) return {} as T;

  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn('[mock] body 不是合法 JSON，按空请求处理');
    return {} as T;
  }
}

function clampLimit(raw: number | undefined, fallback = 50): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;

  return Math.min(100, Math.max(1, Math.floor(raw)));
}

/**
 * 会话列表游标 = `${updated_at}_${thread_id}`。
 *
 * 用键集而不是 offset：新会话随时插到最前面，offset 会重复或跳过。
 */
function parseThreadCursor(raw: string | undefined): { updatedAt: number; id: string } | null {
  if (!raw) return null;

  const separator = raw.indexOf('_');
  if (separator === -1) return null;

  const updatedAt = Number(raw.slice(0, separator));
  if (!Number.isFinite(updatedAt)) return null;

  return { updatedAt, id: raw.slice(separator + 1) };
}

/** 历史游标 = 下一条的起始下标；非法时返回 null，由调用方回 400。 */
function parseMessageCursor(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return 0;

  const offset = Number(raw);
  return Number.isInteger(offset) && offset >= 0 ? offset : null;
}

async function handleRuntimes(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = parseJsonBody<RuntimesBody>(await readBody(req));
  const limit = clampLimit(body.limit);
  const cursor = parseThreadCursor(body.cursor);

  if (body.cursor && cursor === null) {
    sendJson(res, 400, { error: { code: 'invalid_cursor' } });
    return;
  }

  const sorted = [...threads.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1),
  );
  const rest = cursor
    ? sorted.filter(
        record =>
          record.updatedAt < cursor.updatedAt ||
          (record.updatedAt === cursor.updatedAt && record.id < cursor.id),
      )
    : sorted;
  const page = rest.slice(0, limit);
  const last = page.at(-1);

  sendJson(res, 200, {
    data: page.map(record => ({
      thread_id: record.id,
      title: record.title,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      message_count: record.messages.length,
      display_state: record.displayState,
    })),
    next_cursor: rest.length > limit && last ? `${last.updatedAt}_${last.id}` : '',
  });
}

async function handleHistory(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = parseJsonBody<HistoryBody>(await readBody(req));
  const threadId = body.thread_id?.trim();

  if (!threadId) {
    sendJson(res, 400, { error: { code: 'thread_id_required' } });
    return;
  }

  const record = threads.get(threadId);
  if (!record) {
    sendJson(res, 404, { error: { code: 'thread_not_found' } });
    return;
  }

  const offset = parseMessageCursor(body.cursor);
  if (offset === null) {
    sendJson(res, 400, { error: { code: 'invalid_cursor' } });
    return;
  }

  const limit = clampLimit(body.limit, 200);
  const page = record.messages.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  sendJson(res, 200, {
    messages: page,
    display_state: record.displayState,
    next_cursor: nextOffset < record.messages.length ? String(nextOffset) : '',
  });
}

const server = http.createServer((req, res) => {
  const url = readUrl(req);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-XSRF-TOKEN');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // DELETE /runtimes/:id —— 删会话（Day 5 / E1）
  if (req.method === 'DELETE') {
    const prefix = `${RUNTIMES_PATH}/`;

    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Not Found: ${url.pathname}`);
      return;
    }

    const threadId = decodeURIComponent(url.pathname.slice(prefix.length));
    // 幂等由调用方决定：这里如实返回"本来就没有"（404）
    if (threads.delete(threadId)) {
      res.writeHead(204);
      res.end();
    } else {
      sendJson(res, 404, { error: { code: 'thread_not_found' } });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const reportError = (error: unknown): void => {
    console.error('[mock] handler failed:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    if (!res.writableEnded) res.end('mock server error');
  };

  if (url.pathname === RUNTIMES_PATH) {
    void handleRuntimes(req, res).catch(reportError);
    return;
  }

  if (url.pathname === HISTORY_PATH) {
    void handleHistory(req, res).catch(reportError);
    return;
  }

  if (url.pathname !== CHAT_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Not Found: ${url.pathname}`);
    return;
  }

  void handleChat(req, res).catch(reportError);
});

server.listen(PORT, () => {
  console.log(`[mock] listening on http://localhost:${PORT}${CHAT_PATH}`);
  console.log(`[mock] 会话列表：POST ${RUNTIMES_PATH}`);
  console.log(`[mock] 历史消息：POST ${HISTORY_PATH}`);
});

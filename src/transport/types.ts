/**
 * 协议类型定义（transport 层的唯一事实源）。
 *
 * 这里刻意分成两套命名风格，**不是笔误**：
 * - 请求侧（WireMessage / ChatRequestBody）用 snake_case —— 后端协议就是这么定义的
 * - 响应侧（AgentEvent）用 camelCase —— AG-UI 事件就是这么定义的
 *
 * 整个项目最容易反复踩的坑就是这个「一边 snake、一边 camel」。
 */

// ============================================================
// 请求侧（发给 /chat 的 body）
// ============================================================

/**
 * 一条 wire 消息。
 *
 * 今天（Day 1）只会用到 role/content 两个字段；
 * content_parts 在 Day 4 发图片/文档引用时才会出现；
 * tool_calls / tool_call_id 在 Day 6 做 HITL 作答时才会出现。
 */
export interface WireMessage {
  id?: string;
  /** 'user' | 'assistant' | 'tool' | 'system' …… 今天只用 user。 */
  role: string;
  /** 纯文本内容；有 content_parts 时后端会忽略它。 */
  content?: string;
  /** 多模态内容，非空时优先于 content。 */
  content_parts?: WireContentPart[];
  /** role=tool 时填，指向对应的工具调用。 */
  tool_call_id?: string;
  /** role=assistant 时的历史工具调用记录。 */
  tool_calls?: WireToolCall[];
}

/** 多模态内容片段（今天不用，先占位以免 Day 4 改类型）。 */
export interface WireContentPart {
  type: 'text' | 'image' | string;
  text?: string;
  filename?: string;
  source?: { type: 'url' | 'data'; value: string; mime_type?: string };
}

/** 历史工具调用记录（今天不用）。 */
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** /chat 的请求体。 */
export interface ChatRequestBody {
  /**
   * 会话 ID。
   *
   * ⚠️ 新会话必须传**空字符串**，不能省略字段、不能传 null。
   * 真实 ID 由后端在 RUN_STARTED 事件里回填。
   */
  thread_id: string;
  /**
   * 全量历史消息。
   *
   * 网关自己取最后一条发给 Agent，所以不要只传最后一条——重生成（Day 6）
   * 需要靠完整历史回溯。
   */
  messages: WireMessage[];
  /**
   * 业务上下文数组。
   *
   * ⚠️ 网关只取第一个元素；传 [] 等于不传。
   */
  contexts: ChatContext[];
}

/** 业务上下文。 */
export interface ChatContext {
  /** 品类标识（PadType）：doc / sheet / form / folder / slide / note / pdf。 */
  channel?: string;
  /** 语言，如 zh。 */
  language?: string;
  /**
   * 品类参数。
   *
   * ⚠️ 是 **JSON 字符串**，不是对象。`JSON.stringify({...})` 一次。
   * 这是第二容易踩的坑：传对象后端会解析失败，但错误信息不直观。
   */
  params?: string;
}

// ============================================================
// 响应侧（AG-UI 事件）
// ============================================================

/** 所有事件的公共字段。 */
export interface BaseEvent {
  type: string;
  /** 毫秒时间戳；可能多条事件共享同一个值，不影响。 */
  timestamp?: number;
  /** 会话 ID；每一帧都带，便于确认"还是同一条流"。 */
  threadId?: string;
}

/**
 * AG-UI 事件。
 *
 * Day 1 只需要 6 个类型 + 未知事件兜底；
 * Day 2 加 reasoning / toolCall 时在这里追加联合成员即可，消费方不用改。
 *
 * ⚠️ 未知事件必须能通过（兜底成员），否则你 Day 3 接工具调用时
 *    会莫名"收不到事件"——实际是被类型过滤掉了。
 */
export type AgentEvent =
  | (BaseEvent & { type: 'RUN_STARTED'; threadId: string })
  | (BaseEvent & { type: 'TEXT_MESSAGE_START'; messageId: string; role?: string })
  | (BaseEvent & { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string })
  | (BaseEvent & { type: 'TEXT_MESSAGE_END'; messageId: string })
  | (BaseEvent & { type: 'RUN_FINISHED' })
  | (BaseEvent & { type: 'RUN_ERROR'; message?: string })
  | (BaseEvent & { type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string })
  | (BaseEvent & { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string })
  | (BaseEvent & { type: 'TOOL_CALL_END'; toolCallId: string })
  | (BaseEvent & { type: 'TOOL_CALL_RESULT'; messageId: string; toolCallId: string; content: string });

/**
 * 为什么联合里**没有**「未知事件」成员：
 *
 * 如果加一个 `BaseEvent & Record<string, unknown>` 兜底成员，它的 `type` 是宽泛的 `string`，
 * 会让 `switch (event.type)` 的类型收窄完全失效——每个分支里 `event.messageId` 都会退化成
 * `unknown`，得在每处调用点强转，反而更不安全。
 *
 * 运行时的兜底放在 `parseFrame`：未知 type 原样透传（不丢事件，Day 3 接 TOOL_CALL_* 时靠它），
 * 到了 `applyLiveEvent` 会落到 `default` 分支被忽略。**能透传** 和 **在类型里开放** 是两件事。
 */

// ============================================================
// 连接参数
// ============================================================

/** connectAgentStream 的入参。 */
export interface ConnectInput {
  /** 端点路径。默认相对路径 '/api/v6/agentgateway/chat'，由 vite proxy 转发。 */
  url?: string;
  /** 会话 ID；新会话传 ''。 */
  threadId: string;
  /** 全量历史（今天至少一条 user）。 */
  messages: WireMessage[];
  /** 品类标识。 */
  channel: string;
  /** 中止信号。 */
  signal: AbortSignal;
  /** 语言，可选。 */
  language?: string;
  /** 品类参数对象；内部会 stringify 进 contexts[0].params。 */
  params?: Record<string, unknown>;
}

// ============================================================
// 会话列表与历史（Day 5：E1 / A4）
// ============================================================

/** 一轮是否还在跑。恢复链路据此决定「只渲染历史」还是「提示仍在生成」。 */
export type DisplayState = 'ready' | 'in_progress' | 'needs_input';

/** `/runtimes` 返回的一条会话摘要。 */
export interface RuntimeSummary {
  thread_id: string;
  /** 首条用户消息截断而来，可能为空（空会话）。 */
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  display_state: DisplayState;
}

/** `POST /runtimes` 的响应。next_cursor 为空串表示没有下一页。 */
export interface RuntimesResponse {
  data: RuntimeSummary[];
  next_cursor: string;
}

/** `POST /history` 的响应：messages 是扁平 wire 消息，交给 aggregateSnapshot 归约。 */
export interface HistoryResponse {
  messages: WireMessage[];
  display_state: DisplayState;
  next_cursor: string;
}

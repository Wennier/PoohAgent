/**
 * 消息模型 —— UI 层真正消费的数据结构。
 *
 * 为什么要有这一层（而不是直接用后端返回的 Message）：
 *
 * 后端的消息是**扁平的、按 role 排列的**：user / assistant / tool / reasoning 各是一条，
 * 一次工具调用会被拆成 assistant(tool_calls) + tool(result) 两条。
 * 而 UI 要的是**按轮次聚合的**：一条 assistant 消息里，顺序排好「思考 → 文本 → 工具卡 → 又一段文本」。
 *
 * 所以协议消息 → UI 消息的转换不是"过滤字段"，是**重新组织**。这也是归约层存在的理由。
 *
 * Day 2 只定义 text / error 两种 part；reasoning / tool / artifacts 在 Day 3+ 追加（判别联合天然可扩展）。
 */

/** 消息角色。UI 只关心"谁说的"，不需要区分 tool / reasoning（它们是 assistant 的内容片段）。 */
export type UIMessageRole = 'user' | 'assistant';

/** 所有 part 的基础形状。新增 part 时收窄 `type` 即可。 */
export interface BasePart {
  type: string;
}

/**
 * 文本段落。
 *
 * `id` 是**协议层的 messageId**，用于直播时定位"追加到哪一段"。
 * 回溯（快照）时也用它做后续对齐。
 */
export interface TextPart extends BasePart {
  type: 'text';
  id?: string;
  /** 内容会随流式增量追加。 */
  content: string;
}

/**
 * 工具调用段落。
 *
 * 关键设计：`result` 是**字段**，不是独立的 part。
 * 这样"结果回填"只是改一个字段，而不是往 parts 里追加节点 ——
 * 直播路径（TOOL_CALL_RESULT 事件）与快照路径（独立的 tool 消息）因此能折叠成同一形状。
 *
 * `id` 用协议里的 toolCallId：同一个调用在 args / result 两类事件里靠它对应。
 */
/** 工具调用卡片的四态。 */
export type ToolCallStatus = 'calling' | 'running' | 'done' | 'failed';

export interface ToolPart extends BasePart {
  type: 'tool';
  /** 工具调用 id（= 协议 toolCallId）。 */
  id: string;
  /** 工具名，如 webSearch。 */
  name: string;
  /** 调用参数：分片累积的原始 JSON 字符串，未完成时可能是不完整 JSON，**不要在这里解析**。 */
  args: string;
  /** 执行结果；null 表示尚未返回。 */
  result: string | null;
  /**
   * 四态，直接决定卡片长什么样（见 docs/assets/tool-card-ux.png）：
   * - `calling`：参数还在流（标题"正在使用 …"，参数区边到边增长）
   * - `running`：参数已发完、等后端执行（"正在执行 …"）
   * - `done`：结果已回填（成功态，默认折叠成一行）
   * - `failed`：执行失败，或本轮异常中断（红色，默认展开）
   *
   * 为什么不能只靠 `result === null` 推断：`calling` 与 `running` 的 result 都是 null，
   * 但产品文案与视觉不同 —— 前者参数还在变化，后者参数已定型。
   */
  status: ToolCallStatus;
}

export interface ImagePart extends BasePart {
  type: 'image';
  url: string;
  filename: string;
  mimeType: string;
}

/**
 * 错误段落。
 *
 * 设计决策：错误不进独立状态，而是**作为消息的一部分**展示。
 * 好处是它天然有位置（挂在出错的那一轮回答末尾），刷新/回溯时也不会丢。
 */
export interface ErrorPart extends BasePart {
  type: 'error';
  message: string;
  /** 业务错误码，供渲染层决定样式或是否展示"重试"。 */
  code?: string;
  /**
   * UI 该不该给「重试」。
   *
   * 由**分类器**决定并写入（抛出来的错误由 controller 写）；
   * 留空表示"没人判定过"，渲染层按 `code` 用 `classifyRunError` 推（RUN_ERROR 走这条）。
   * 不用「有没有 code」来推：用户取消既没有码、也不该给重试。
   */
  retryable?: boolean;
}

/** 已知 part 的联合。Day 3 会追加 reasoning / tool。 */
export type Part = TextPart | ToolPart | ImagePart | ErrorPart;

/** 一条 UI 消息。user 与 assistant 同构，都用 parts。 */
export interface UIMessage {
  id: string;
  role: UIMessageRole;
  parts: Part[];
}

export interface LiveContext {
  currentAssistantId: string | null;
}

// ============================================================
// 工具函数
// ============================================================

/** assistant 占位消息的 id 前缀。直播时靠它判断"这条还没被真实 messageId 接管"。 */
export const ASSISTANT_PLACEHOLDER_PREFIX = 'assistant_';

/** 是否是尚未被接管的 assistant 占位消息。 */
export function isAssistantPlaceholder(id: string): boolean {
  return id.startsWith(ASSISTANT_PLACEHOLDER_PREFIX);
}

/** 生成一条 assistant 占位消息（内容为空，等 TEXT_MESSAGE_START 接管 id）。 */
export function createAssistantPlaceholder(): UIMessage {
  return {
    id: `${ASSISTANT_PLACEHOLDER_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    parts: [],
  };
}

/**
 * 用指定的 id 造一条空的 assistant 消息。
 *
 * 与 {@link createAssistantPlaceholder} 的区别：
 * - 占位消息的 id 是本地临时生成的，等后端接管
 * - 这条的 id 已经来自后端（`TEXT_MESSAGE_START.messageId`），不会再变
 */
export function createAssistantMessage(id: string): UIMessage {
  return { id, role: 'assistant', parts: [] };
}

/** 取一条消息里所有文本 part 拼接后的内容（Day 2 的验收与测试会用到）。 */
export function getTextContent(message: UIMessage): string {
  return message.parts
    .filter((part): part is TextPart => part.type === 'text')
    .map(part => part.content)
    .join('');
}

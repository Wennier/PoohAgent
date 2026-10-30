/**
 * 工具层：本地工具（浏览器能力）与 MCP 工具共用同一套定义。
 *
 * 对 controller 来说，「这个工具在前端跑」和「这个工具来自 MCP server」是同一件事：
 * 模型声明要调什么 → 我这边执行 → 把结果缝回同一轮。差异只在 `execute` 的实现。
 *
 * 字段名刻意对齐 MCP 的 `tools/list` 返回（name / description / inputSchema），
 * 这样从 MCP 拉回来的工具不用转换就能注册。
 */

/** 工具的声明部分。 */
export interface ToolDef {
  name: string;
  description: string;
  /**
   * JSON Schema。
   *
   * 我们**不做校验**：模型给的参数直接透传（MCP 服务端会自己校验）。
   * 留着它是为了 UI 展示（"这个工具要什么参数"）和以后接校验。
   */
  inputSchema: Record<string, unknown>;
}

/**
 * 工具执行结果。
 *
 * MCP 返回的是 `content: [{type:'text', text}]` 数组，而我们的网关只收字符串，
 * 所以在工具层就把数组压平成 `content`——边界两侧只有一处做转换。
 */
export interface ToolResult {
  ok: boolean;
  content: string;
  /** 失败原因；也用于把"未知工具/抛异常"变成给模型看的说明。 */
  error?: string;
}

/** 一个可执行的工具。 */
export interface Tool {
  def: ToolDef;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * JSON-RPC 2.0 的最小传输契约：发一条消息、等一条响应。
 *
 * 只做这一件事，是为了让 stdio / HTTP / 内存双工都能接进来——
 * 浏览器里没有子进程，所以我们能用的是 HTTP；测试里用内存双工。
 */
export interface McpTransport {
  request(payload: unknown): Promise<unknown>;
  close?(): void;
}

/**
 * MCP 工具的名字带命名空间前缀，避免和本地工具撞名，也让人一眼看出工具来源。
 *
 * 双下划线是 Claude Code 的既有约定，照抄是为了"看到名字就知道怎么查"。
 */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

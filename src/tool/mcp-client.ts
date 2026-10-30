/**
 * MCP client：JSON-RPC 2.0 的三个必要方法 —— `initialize` / `tools/list` / `tools/call`。
 *
 * 它只做协议，不碰传输：`McpTransport` 由外部注入。
 * 这不是"为测试留口子"的托词，而是**浏览器里没有子进程**——MCP 最常见的 stdio 传输用不了，
 * 我们能接的是 Streamable HTTP；换传输只需要换一个 Transport 实现。
 *
 * 两条容易写错的语义：
 * 1. `tools/call` 的**工具失败**也是一个 result（`isError: true`），不是 JSON-RPC error。
 *    JSON-RPC 的 `error` 只用于协议层问题（方法不存在、参数非法）。
 * 2. 通知（notification）没有 `id`，不需要等响应；`notifications/initialized` 就是通知。
 */

import type { McpTransport, Tool, ToolDef, ToolResult } from './types';
import { mcpToolName } from './types';

/** 我们声明的协议版本；服务端会回它支持的那个，可能不同。 */
const PROTOCOL_VERSION = '2025-06-18';

/** JSON-RPC 层的错误（协议问题，不是工具执行失败）。 */
export class McpError extends Error {
  readonly code: number;
  readonly method: string;

  constructor(code: number, message: string, method: string) {
    super(`MCP ${method} 失败（${code}）：${message}`);
    this.name = 'McpError';
    this.code = code;
    this.method = method;
  }
}

interface RpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * MCP 的 `content` 是数组（text / image / resource）。
 * 我们的网关只收字符串，所以在这一层压平：只保留 text，多条用换行连接。
 */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return '';

  return content
    .map(part => {
      const typed = part as { type?: unknown; text?: unknown };
      return typed?.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
    })
    .filter(text => text !== '')
    .join('\n');
}

export interface McpClientOptions {
  /** 服务名，用于工具命名空间 `mcp__<server>__<tool>` */
  serverName: string;
  transport: McpTransport;
  clientInfo?: { name: string; version: string };
}

export class McpClient {
  private nextId = 1;
  private readonly serverName: string;
  private readonly transport: McpTransport;
  private readonly clientInfo: { name: string; version: string };

  constructor(options: McpClientOptions) {
    this.serverName = options.serverName;
    this.transport = options.transport;
    this.clientInfo = options.clientInfo ?? { name: 'pooh-agent', version: '0.0.0' };
  }

  /** 发一条请求并等响应；`params` 为空时不出现该字段。 */
  private async rpc(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    const response = (await this.transport.request({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    })) as RpcResponse | undefined;

    if (response?.error) {
      throw new McpError(response.error.code ?? -1, response.error.message ?? '未知错误', method);
    }

    return response?.result;
  }

  /** 握手。必须第一个调用，否则服务端会拒绝后续请求。 */
  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    });

    // 通知：没有 id，不等响应
    await this.transport.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /** 拉工具清单（返回**未加**命名空间的原始声明）。 */
  async listTools(): Promise<ToolDef[]> {
    const result = (await this.rpc('tools/list')) as { tools?: unknown } | undefined;
    const tools = Array.isArray(result?.tools) ? result?.tools : [];

    return tools.map(raw => {
      const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
      return {
        name: String(tool.name ?? ''),
        description: String(tool.description ?? ''),
        inputSchema:
          typeof tool.inputSchema === 'object' && tool.inputSchema !== null
            ? (tool.inputSchema as Record<string, unknown>)
            : {},
      };
    });
  }

  /** 调一个工具。工具自身失败返回 `ok: false`，**不抛错**。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = (await this.rpc('tools/call', { name, arguments: args })) as
      | { content?: unknown; isError?: unknown }
      | undefined;

    const content = flattenContent(result?.content);
    const isError = result?.isError === true;

    return isError
      ? { ok: false, content, error: content || `工具 ${name} 执行失败` }
      : { ok: true, content };
  }

  /**
   * 把手上的工具包成可直接注册进 `ToolRegistry` 的形状。
   *
   * 名字加 `mcp__<server>__` 前缀：既避免与本地工具撞名，也让日志里一眼看出工具来源。
   */
  async asTools(): Promise<Tool[]> {
    const defs = await this.listTools();

    return defs.map(def => ({
      def: { ...def, name: mcpToolName(this.serverName, def.name) },
      execute: (args: Record<string, unknown>) => this.callTool(def.name, args),
    }));
  }

  close(): void {
    this.transport.close?.();
  }
}

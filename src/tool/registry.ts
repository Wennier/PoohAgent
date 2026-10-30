/**
 * 工具注册表：本地工具与 MCP 工具的统一入口。
 *
 * 它只回答四个问题：有哪些工具 / 有没有某个工具 / 怎么执行 / 执行失败了怎么表达。
 * 它**不**回答"该不该执行"（权限、人审在上层）、也**不**知道 SSR 事件协议。
 */

import type { Tool, ToolDef, ToolResult } from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /**
   * 注册一个工具。
   *
   * 重名**直接抛错**：运行期静默覆盖会让"调错工具"极难排查——
   * 尤其 MCP 服务端是外部来的，重名不能靠自觉。
   */
  register(tool: Tool): void {
    const { name } = tool.def;
    if (this.tools.has(name)) {
      throw new Error(`工具重名：${name}（MCP 工具请用 mcpToolName 加命名空间）`);
    }

    this.tools.set(name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()].map(tool => tool.def);
  }

  /**
   * 执行一个工具。
   *
   * 两条兜底都在这里，因为工具名与实现都不是"可信输入"：
   * - 名字来自模型，可能是幻觉 → 未知工具返回失败结果，**不抛错**
   * - 工具实现是我们或第三方写的，抛异常很正常（权限、格式）→ 同样收敛成结果
   *
   * 抛错的代价是打断整条流，用户只看到"生成失败"，丢失前面所有内容。
   */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, content: '', error: `未知工具：${name}` };
    }

    try {
      return await tool.execute(args);
    } catch (error) {
      return {
        ok: false,
        content: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

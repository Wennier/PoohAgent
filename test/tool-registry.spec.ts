/**
 * 工具注册表。
 *
 * 重点不是"能注册能执行"，而是两条兜底：幻觉工具名与工具抛异常，都不能打断整条流。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ToolRegistry } from '../src/tool/registry';
import type { Tool, ToolResult } from '../src/tool/types';
import { mcpToolName } from '../src/tool/types';

function makeTool(name: string, execute: Tool['execute']): Tool {
  return {
    def: { name, description: `${name} 的描述`, inputSchema: { type: 'object' } },
    execute,
  };
}

const okEcho: Tool['execute'] = async args => ({ ok: true, content: JSON.stringify(args) });

describe('ToolRegistry · 注册与列举', () => {
  it('注册后能查到，list 返回声明（不含 execute）', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('echo', okEcho));

    assert.equal(registry.has('echo'), true);
    assert.deepEqual(registry.list(), [
      { name: 'echo', description: 'echo 的描述', inputSchema: { type: 'object' } },
    ]);
  });

  it('重名直接抛错（MCP 服务端是外部的，重名不能靠自觉）', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('echo', okEcho));

    assert.throws(() => registry.register(makeTool('echo', okEcho)), /工具重名/);
  });

  it('本地工具与 MCP 工具靠命名空间共存', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('readClipboard', okEcho));
    registry.register(makeTool(mcpToolName('github', 'search'), okEcho));

    assert.deepEqual(
      registry.list().map(tool => tool.name),
      ['readClipboard', 'mcp__github__search'],
    );
  });
});

describe('ToolRegistry · 执行兜底', () => {
  it('正常执行：参数透传，结果原样返回', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('echo', okEcho));

    assert.deepEqual(await registry.execute('echo', { a: 1 }), { ok: true, content: '{"a":1}' });
  });

  it('未知工具（模型幻觉）：返回失败结果，不抛错', async () => {
    const registry = new ToolRegistry();

    const result = await registry.execute('不存在的工具', {});

    assert.equal(result.ok, false);
    assert.match(String(result.error), /未知工具/);
  });

  it('工具自己抛异常：收敛成失败结果，不打断整条流', async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeTool('boom', async () => {
        throw new Error('没有权限');
      }),
    );

    const result = await registry.execute('boom', {});

    assert.equal(result.ok, false);
    assert.equal(result.error, '没有权限');
  });

  it('工具返回失败也算正常返回（不是异常）', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('maybe', async (): Promise<ToolResult> => ({ ok: false, content: '', error: '被拒绝' })));

    assert.deepEqual(await registry.execute('maybe', {}), { ok: false, content: '', error: '被拒绝' });
  });
});

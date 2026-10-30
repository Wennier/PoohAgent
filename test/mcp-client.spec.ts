/**
 * MCP client 协议层。
 *
 * 用一个内存 transport 当"服务端"，所以这些用例是纯协议断言，不碰网络、不起进程。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { McpClient, McpError } from '../src/tool/mcp-client';
import type { McpTransport } from '../src/tool/types';

interface Sent {
  jsonrpc: string;
  id?: number;
  method: string;
  params?: unknown;
}

/** 按方法名返回预设响应的内存传输，并记录客户端发了什么。 */
function fakeTransport(handlers: Record<string, (params: unknown) => unknown>): {
  transport: McpTransport;
  sent: Sent[];
} {
  const sent: Sent[] = [];

  return {
    sent,
    transport: {
      request: async payload => {
        const message = payload as Sent;
        sent.push(message);

        // 通知没有 id：不回包
        if (message.id === undefined) return undefined;

        const handler = handlers[message.method];
        if (!handler) {
          return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
        }

        return { jsonrpc: '2.0', id: message.id, result: handler(message.params) };
      },
    },
  };
}

const INITIALIZE_RESULT = { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-mcp' } };
const LIST_RESULT = {
  tools: [
    { name: 'search', description: '搜代码', inputSchema: { type: 'object', properties: {} } },
    { name: 'createIssue', description: '建 issue' },
  ],
};

function makeClient(handlers: Record<string, (params: unknown) => unknown> = {}) {
  const { transport, sent } = fakeTransport({
    initialize: () => INITIALIZE_RESULT,
    'tools/list': () => LIST_RESULT,
    'tools/call': params => ({ content: [{ type: 'text', text: `${JSON.stringify(params)}` }] }),
    ...handlers,
  });

  return { client: new McpClient({ serverName: 'github', transport }), sent };
}

describe('McpClient · 握手与清单', () => {
  it('initialize 带协议版本与 clientInfo，随后发一条 initialized 通知', async () => {
    const { client, sent } = makeClient();

    await client.initialize();

    assert.deepEqual(sent.map(m => m.method), ['initialize', 'notifications/initialized']);
    assert.equal((sent[0].params as { protocolVersion: string }).protocolVersion, '2025-06-18');
    assert.equal((sent[0].params as { clientInfo: { name: string } }).clientInfo.name, 'pooh-agent');
    assert.equal(sent[1].id, undefined, '通知不能带 id');
  });

  it('tools/list 转成 ToolDef，inputSchema 缺失时兜底成 {}', async () => {
    const { client } = makeClient();
    const tools = await client.listTools();

    assert.deepEqual(tools.map(tool => tool.name), ['search', 'createIssue']);
    assert.deepEqual(tools[1].inputSchema, {});
  });

  it('ID 单调递增（同一连接上的请求不能复用 id）', async () => {
    const { client, sent } = makeClient();
    await client.initialize();
    await client.listTools();

    assert.deepEqual(sent.filter(m => m.id !== undefined).map(m => m.id), [1, 2]);
  });
});

describe('McpClient · 调用工具', () => {
  it('tools/call 的参数放在 arguments 里，content 数组压平成字符串', async () => {
    const { client, sent } = makeClient();

    const result = await client.callTool('search', { q: 'TODO' });

    assert.deepEqual((sent.at(-1)?.params as { arguments: unknown }).arguments, { q: 'TODO' });
    assert.equal(result.ok, true);
    assert.equal(result.content, '{"name":"search","arguments":{"q":"TODO"}}');
  });

  it('多条 text 用换行连接，非 text 片段丢弃', async () => {
    const { client } = makeClient({
      'tools/call': () => ({
        content: [
          { type: 'text', text: '第一行' },
          { type: 'image', data: 'xxx' },
          { type: 'text', text: '第二行' },
        ],
      }),
    });

    assert.equal((await client.callTool('search', {})).content, '第一行\n第二行');
  });

  it('工具失败是 result.isError，不是 JSON-RPC error', async () => {
    const { client } = makeClient({
      'tools/call': () => ({ isError: true, content: [{ type: 'text', text: '没有权限' }] }),
    });

    const result = await client.callTool('createIssue', {});

    assert.equal(result.ok, false);
    assert.equal(result.error, '没有权限');
  });

  it('协议层错误抛 McpError（服务端没实现该方法）', async () => {
    const { transport } = fakeTransport({ initialize: () => INITIALIZE_RESULT });
    const client = new McpClient({ serverName: 'github', transport });

    await assert.rejects(client.listTools(), McpError);
  });
});

describe('McpClient · 注册进 ToolRegistry', () => {
  it('工具名带 mcp__<server>__ 前缀，execute 绑定到原工具', async () => {
    const { client, sent } = makeClient();

    const tools = await client.asTools();

    assert.deepEqual(tools.map(tool => tool.def.name), ['mcp__github__search', 'mcp__github__createIssue']);
    const result = await tools[0].execute({ q: 'x' });
    assert.equal(result.ok, true);
    assert.equal((sent.at(-1)?.params as { name: string }).name, 'search', '线上仍用原始工具名');
  });
});

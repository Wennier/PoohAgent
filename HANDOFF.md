# 交接说明（新会话窗口请先读这份）

> 用途：当前会话上下文太长，换窗口继续。这份文件是**唯一的状态快照**，读完它 + `AGENTS.md` + `docs/00` 的 §〇，就能接着干。
> **最高优先级：仓库根目录的 [`AGENTS.md`](./AGENTS.md)（个人做事习惯）**——业务优先四步法、方案确认 ≠ 授权写代码；与本文冲突时以它为准。
> 最后更新：2026-10-30（Day 6 进行中：6-1 错误处理、6-1b 自动重试、6-2 重新生成**已完成**；6-3 做到 D14，剩 D15–D19）

---

## 一、开工前必读：协作约定

铁律在 `AGENTS.md` 与 `docs/00-模块拆解与实现路线.md` 的 §〇，最高优先级。摘要：

### A. 写入权限
1. **默认只给改法，不动文件**。改源码 / 改 package.json / 新增删除文件 / 装依赖 / 写文档，都必须先问"要我改吗"。
2. **"好 / 后者 / 按建议 / 继续" ≠ 授权写代码**，只有"写 / 改 / 实现 / 落盘 / 提交"才算。
3. **只做点名的那一处**；别处的问题只报告（文件、行号、原因、最小修法）。
4. 每轮结尾列**本轮改动文件清单**，没有就写"本轮改动：无"。
5. **不要反复追问运维类小事**（mock 重启过没、端口谁占着）——用户会明确说，没说过就自己查。

### B. 功能实现流程
1. **面试高频点**：业务问题 → 市场做法 → 面试考察维度 → 我们怎么做（四步不可跳）。
2. **非高频点**：业务问题 → 我们怎么做（业务问题永远必做）。
3. **一步一步**：每步只动一层，做完立刻验证（`pnpm test` + `pnpm typecheck` + 页面现象）。

### C. 交付上限（`AGENTS.md` §五）
- 一次交付 ≤ **2 个文件**、≤ **200 行**新增；测试文件不占文件数、但计入行数。
- **提交门禁 C2 已暂停**（2026-10-30），不再要求 commit 前口述三问。

**用户目标**：准备 agent 开发岗面试；用本仓从零重写对话系统。**代码默认用户自己写**，助手给设计、骨架、测试、评审。

---

## 二、项目快照

| 项 | 值 |
|---|---|
| 分支 / HEAD | `main` / `0cf3fb0` |
| 包路径 | 仓库根目录（独立仓库） |
| 包名 | `@tencent/docs-ai-wendy-agent-chat`（private） |
| 技术栈 | TypeScript + React 17（`ReactDOM.render`）+ rxjs 7 + vite（demo）+ node:test（tsx 执行） |
| 测试 | **204 / 204**，18 个 spec 文件 |
| 类型 | `pnpm typecheck` exit 0；`tsc -p demo/tsconfig.json` exit 0 |
| 依赖 | react-markdown / remark-gfm / rehype-highlight / highlight.js；rxjs（**未引入任何 MCP SDK**，client 是自己写的） |

测试分布（`test/*.spec.ts`）：

```
agent-controller 33    ui-transform 27    message-store 21    session-manager 19
error-classify 14      build-chat-body 10 parse-frame 9       parse-sse-frames 9
retry 8                session-gateway 8  mcp-client 8        tool-registry 7
script-to-wire 7       split-frames 7     image-block 5       wire-content 5
session-list 4         agent-gateway 3
```

### 常用命令（仓库根目录）

```bash
pnpm test        # node --import tsx --test "test/**/*.spec.ts"
pnpm typecheck   # tsc -p tsconfig.json --noEmit
pnpm dev         # demo，端口 5181
pnpm dev:mock    # mock agent，端口 3002（连 5181 的 vite proxy）
```

- 推送要 `git push --no-verify origin main`：企业全局 pre-push hook 的 LFS 兜底会误报认证失败。
- **mock 改了代码必须重启**（没有 watch）。
- 想单独验证 mock 又不想动用户的 3002：把 `demo/mock-agent-server.ts` + `demo/script-to-wire.ts` + `src/transport/types.ts` 按原相对路径拷到 `/tmp/xxx/`，`sed` 改端口到 3102，用 `node_modules/.bin/tsx` 起。**跑完必须 `lsof -iTCP:3102` 确认进程真的死了**（见 §十第 13 条）。

### mock 剧本（改地址栏或页面日志面板右上角的下拉）

| URL | 场景 |
|---|---|
| `http://localhost:5181/` | 纯文本（60 帧 × 90ms，切块长度随机） |
| `?scenario=tool` | 文本 + webSearch 工具卡 + 文本 |
| `?scenario=markdown` | 10 种 Markdown 语法 |
| `?scenario=flaky` | **第一次 500、之后正常**（验证自动重试与恢复；只消耗一次） |
| `?scenario=error-run` | 半句 → `RUN_ERROR{code:439906}`（run 类） |
| `?scenario=error-run:439902` | 同上，换业务码（439902/03/07） |
| `?scenario=http-429` / `http-500` / `http-401` | 非 2xx（429 带 `Retry-After: 3`） |
| `?scenario=cut:4` | 吐 4 个事件后掐断 socket（stream 类） |
| `?scenario=reset` | 一个字节都不回就断（连接错误） |

abort 不用剧本：正常场景点「停止」即可。

---

## 三、进度

| 批次 | 状态 | 交付 |
|---|---|---|
| Day 1 协议打通 | ✅ | SSE 帧解析、事件解析、网关请求、mock server |
| Day 2 归约与渲染 | ✅ | MessageStore、双通道归约、controller、流式渲染 |
| Day 3 工具调用 | ✅ | ToolPart 四态、工具卡、快照折叠、LiveContext |
| Day 4 输入与消息操作 | ✅ | 空态、复制、Markdown、附件（4-0~4-5）+ 粘贴图片 |
| Day 5 多会话与恢复 | ✅ | SessionManager、左侧列表、刷新恢复、历史加载、删除 |
| Day 6 **6-1 B5 错误与重试** | ✅ | D1–D12（见 §七） |
| Day 6 **6-2 B4 重新生成** | ✅ | `retryLastTurn(messageId?)` + 逐条重试按钮 |
| Day 6 **6-3 F1 本地工具 + MCP** | 🟡 **D13–D14 完成** | 剩 D15–D19 |
| Day 6 **6-4 F2 AskUserQuestion** | ⬜ 未开始 | 依赖 6-3 的挂起机制 |
| Day 6 **6-5 文档收口** | ⬜ 未开始 | 本文件已更新，README / 问题卡片还没 |
| 已排期 | ⬜ | reasoning → 消息内分区 → 本地持久化 → 上下文压缩（用户说后面统一排） |

### Day 6 验收清单（`docs/00` §四）

| 验收项 | 状态 |
|---|---|
| 卡片出现时输入区被接管 | ⬜ 6-4 |
| 作答后同一轮继续，不产生新轮次 | ⬜ 6-4 |
| 断网有提示，重试可恢复 | ✅ |
| 错误文案按业务码分级 | ✅ |
| `README.md` + 问题卡片集齐 | ⬜ 6-5 |

**完成定义「提问 → 用户作答 → 继续生成」尚未达成**，要 6-3 + 6-4。

---

## 四、模块职责（分层）

```
demo/  main.tsx（useSessions / useActiveStream / useSessionHistory / useBootstrap + 视图 + 剧本下拉）
       session-list.tsx（列表 / 删除确认弹层）
       script-to-wire.ts（事件 → wire 消息，纯函数）
       mock-agent-server.ts（剧本 + 内存会话表 + 错误注入 + /runtimes、/history、DELETE）
  │
src/session/    session-manager.ts · pointer.ts · types.ts
src/agent/      agent-controller.ts（状态机 / 提交 / 中止 / 重试 / 历史组装）
                error-classify.ts（四类判定 + 业务码分级 + 两个重试判据）
src/message/    type.ts · message-store.ts · ui-transform.ts（双通道归约）· wire-content.ts
src/transport/  sse-parser.ts · event-parser.ts · agent-gateway.ts（/chat + 幂等键）
                retry.ts（withRetry：自动重试包装器）· session-gateway.ts
src/tool/       types.ts（统一工具定义 + MCP 契约）· registry.ts（注册表 + 兜底）
                mcp-client.ts（JSON-RPC 2.0 client，传输注入）
src/render/     part-renderer.tsx（分发 + 错误块）· markdown-text.tsx · tool-card.tsx · image-block.tsx
```

约束：`store` 不知道事件；`transform` 不知道状态机；`controller` 不知道 React；`render` 不知道协议；`demo` 不知道 SSE 细节；`session` 不解析消息文本；`tool` 不知道 SSR 协议。

> 唯一的层级妥协：`part-renderer` 直接 import `agent/error-classify`（用 `classifyRunError` 推 RUN_ERROR 的重试按钮）。理由：它是纯函数、无状态，替代方案是把业务码表复制一份。

---

## 五、核心设计决策（已定，别推翻）

1. **一条 UI 消息 = 一次 run**：靠 `LiveContext.currentAssistantId`；`RUN_STARTED` 清、首个 `TEXT_MESSAGE_START` 赋值、`RUN_FINISHED` 清，`submit` 开头再清一次。
2. **工具结果是 part 的字段**，不是新 part：`status: calling/running/done/failed`，不能用 `result === null` 推断状态。
3. **快照折叠是启发式**：`assistant → tool → assistant` 视为同一轮；孤立 `tool` 降级为 `ErrorPart`；用"直播 parts 与快照 parts `deepEqual`"守住。
4. **多段文本靠 partId** 区分续写还是新段。
5. **状态只在一处写**：`status` 归 controller；`part.status` 归 store。
6. **一个会话一个 controller**：切换只换被订阅的实例；旧流写不回新会话。
7. **草稿不进列表**；`SessionManager` 订阅**各 controller 自己的 `threadId$`** 决定提升。
8. **删除先服务端再本地**：否则服务端删失败时列表已空，刷新会"复活"。
9. **历史恢复三竞态**：结果写回发起请求的 controller；已有消息则丢弃响应；同 threadId 只允许一个在途请求。
10. **错误分四类**：`query`（请求没建立）/ `stream`（中途断）/ `run`（`RUN_ERROR` 带业务码）/ `abort`（用户取消，**不是错误**）。
11. **两个重试判据必须分开**：`autoRetryable`（传输层：只重试还没吐事件的）与 `manualRetryable`（UI：按钮出不出现）。合成一个字段会让"未登录"也长出重试按钮。
12. **自动重试只发生在"还没收到任何事件"时**：协议没有序号，客户端无法去重；重发 = 重放输出。`receivedEvent` 由 controller 在 `next` 里记，逐次提交独立。
13. **幂等键粒度 = 一次提交**：在 `runTurn` 生成一次，跨自动重试复用；`retryLastTurn` 是用户主动再来一次，算新提交、换新键。
14. **手动重试 = 截断，不是追加**：`replaceAll(snapshot.slice(0, userIndex+1))` 再 `runTurn`。复用旧 assistant 的 id 不可行——`TEXT_MESSAGE_START` 只接管 `assistant_` 前缀（`ui-transform.ts:80`），而 `replaceId` 本来就会把 id 换成服务端的新 id，"复用保 React key"拿不到。
15. **重新生成更早的一轮要丢后面的全部**：后续轮次的上下文引用了旧回答，只换回答保留后续提问会造成历史不自洽。UI 上非最后一条要 `confirm`。
16. **工具注册表两条兜底**：未知工具名（模型幻觉）与工具抛异常都收敛成 `{ok:false}`，**绝不抛错**——抛错会打断整条流，用户丢掉前面所有内容。
17. **MCP 传输可注入**：浏览器没有子进程，stdio 用不了，能接的是 Streamable HTTP；换传输只换 `McpTransport` 实现。工具名 `mcp__<server>__<tool>`。
18. **`tools/call` 的工具失败是 `result.isError`，不是 JSON-RPC error**；后者只用于协议层问题。
19. **mock 会话表是内存版**：接持久化时只换实现，`/runtimes`、`/history` 形状不变。

---

## 六、协议要点（易错）

- **四种 id**：`threadId`（会话）/ UI 消息 id（= 本轮首个 `TEXT_MESSAGE_START` 的 messageId）/ `partId`（段）/ `toolCallId`（调用）。
- `TEXT_MESSAGE_END` 是**段**边界，不是轮边界，不清 ctx。
- `TOOL_CALL_RESULT.messageId` **不用**（结果不是独立消息）。
- `REASONING_MESSAGE_START` 在 `TEXT_MESSAGE_START` 之前，但不是所有模型都有（**尚未实现**）。
- 请求体 snake_case（`thread_id`、`request_id`、`content_parts`），事件 camelCase（`messageId`、`toolCallId`）。
- `content_parts` 非空时 `content` 被忽略 → 带图时文字必须一起进 `content_parts`（`toWireContentParts` 已保证）。
- `RUN_ERROR` 现在带 `code?`，透传到 `ErrorPart.code`；文案分级在渲染层做，不在归约层。
- 会话接口：`/runtimes` 键集游标（`updated_at_id`），`/history` 下标游标；`display_state: ready | in_progress | needs_input`（`needs_input` 仍预留）。
- 图片：粘贴得到 data URL（`source.type='data'`），历史里原样保存；持久化阶段改成 `/files/<hash>`。
- MCP：`initialize` → `notifications/initialized`（**通知无 id，不等响应**）→ `tools/list` → `tools/call`；`content` 数组在工具层压平成字符串。

---

## 七、Day 6：已完成与剩余

### 已完成（D1–D14）

| 交付 | 内容 |
|---|---|
| D1 | mock 四类错误剧本（`error-run` / `http-<code>` / `cut` / `reset`）+ 页面剧本下拉 |
| D2 | `RUN_ERROR.code` 透传到 error part |
| D3 | `AgentHttpError{status, retryAfterMs}` + `parseRetryAfterMs`（秒数/日期两种格式）；补上 `test/agent-gateway.spec.ts`（此前 0 覆盖） |
| D4/D5 | `classifyThrown`（query/stream/abort）+ `classifyRunError`（业务码表 439902/03/06/07，只有限流给按钮） |
| D6 | controller 接线 + `receivedEvent` 生产者 |
| D7 | `retryLastTurn()`：`submit` 拆成 `pushUser` + `runTurn` |
| D8 | `ErrorPart.retryable` + 错误块分级（取消=灰、可重试=红+按钮）+ 回调注入 |
| D9 | `withRetry`：逐 attempt 计 `receivedEvent`、退避 + jitter、尊重 `Retry-After`、`onRetry` 回执 |
| D10 | `request_id` 幂等键（`ConnectInput.requestId` → `ChatRequestBody.request_id`） |
| D11 | controller 接线：`requestId` 一次提交一个；`shouldRetry = classifyThrown(...).autoRetryable` |
| D12 | `flaky` 剧本 + mock 的 `request_id` 自检告警 + 页面「正在自动重试 1/2」横幅 |
| 6-2 | `retryLastTurn(messageId?)` + 逐条重试按钮 + 截断确认 |
| D13 | `ToolRegistry`（幻觉工具名/异常兜底、重名抛错、命名空间） |
| D14 | `McpClient`（JSON-RPC 2.0，transport 注入，`asTools()` 直接注册） |

### 剩余（D15–D19 + 6-4 + 6-5）

| # | 内容 | 说明 |
|---|---|---|
| D15 | `tool/mcp-http.ts`（Streamable HTTP transport）+ mock 的 `POST /mcp` 最小 server | 做完 MCP 在浏览器里就是真能跑通 |
| D16 | `tool/local-tools.ts`：1–2 个真·浏览器工具 | 例如读剪贴板 / 页面标题 |
| D17 | controller 挂起集成 | **卡在三个决策上，见下** |
| D18 | `POST /tool-result` 网关 + mock 唤醒 + 同一连接续流 | |
| D19 | 工具卡四态对接 + mock `?scenario=localTool` + 页面验收 | |
| 6-4 | AskUserQuestion（约 6 个交付） | 先确认 `answer_token` 在 `args` 里还是独立字段 |
| 6-5 | README、问题卡片补 Day 3/4/5（现在 0 张）、`docs/notes` 两条死链 | |

### D17 开工前必须定的三个决策

1. **`AgentStatus` 加 `Paused` 独立状态，还是 `Generating` + 独立 `pending$`？**（助手倾向 `Paused`）
2. **挂起超时多久？**（倾向 5 分钟：本地工具可能跑很久，人也可能不在）
3. **挂起时 `abort()` 是取消整轮，还是只关卡片？**（倾向取消整轮并丢弃 pending）

跨轮次的老问题：`RUN_STARTED` 会清 `ctx.currentAssistantId`，而挂起要求"同一轮继续"——这是 D17 的难点，别在 D17 之前先把状态机改乱。

---

## 八、待办与已排期

| 项 | 说明 |
|---|---|
| **D15–D19** | 见 §七 |
| **6-4 / 6-5** | 见 §七 |
| **上下文压缩** | `buildWireHistory()` 是唯一缝；要处理"截断把 `assistant(tool_calls)` 与 `tool(result)` 截散 → 后端 400"。用户说后面统一排 |
| **长记忆 / 短记忆** | 短记忆边界 = `threadId`；长期记忆决定**不做**，但要能讲（范围控制） |
| **reasoning** | `REASONING_*` 事件 + 折叠区；要抽 `ensureAssistantMessage` |
| **消息内分区** | 前置：reasoning |
| **本地持久化** | 图片走 `/files`，`/history` 形状不变 |
| `activity` role | 现网已定义、后端未用；启用可替代启发式 |

---

## 九、已知遗留（不急，别当新发现）

1. `docs/notes/README.md` 有一条索引指向不存在的卡片（`-03-leftover-placeholder-throw`）；另有两条历史死链待核。
2. `docs/notes/` 只有 Day 1–2 的 4 张卡，Day 3/4/5/6 **零张**。
3. 空态下点"发送"（没输入）会留一个看不见的空草稿。
4. `src/transport/types.ts` 的 `type: 'text' | 'image' | string` 放宽写法（`string` 吞字面量）。
5. mock 的历史里图片存 data URL，内存会涨。
6. 列表没有"加载更多"分页 UI；没有重命名；没有多 Tab 同步。
7. `display_state: in_progress` 只提示、不续流（续传未做）。
8. 续流真要做，**先给协议加序号**——现在同 messageId 重放会让 delta 重复 append（文本翻倍），`ui-transform.ts:89` 的守卫只防"造第二条消息"。

---

## 十、踩过的坑（别重犯）

1. **不要 `CI=true pnpm install`**：会先重装 node_modules 再因 frozen-lockfile 中止，导致没有依赖。
2. 没有 eslint / prettier；验证用 `typecheck` + `test`。
3. **`EventSource` 不可用**（要 POST + header），必须 fetch + 手写 SSE 解析。
4. `finish` 不能把"本轮结束"和"连接结束"混为一谈，三个终止路径共用且必须幂等。
5. 工具事件的联合类型**不要加 catch-all `unknown`**，否则 `switch` 收窄失效。
6. 滚动跟随必须用 `programmaticRef` 忽略自己造成的 scroll。
7. 切场景用 URL（`?scenario=`），不要写死地址。
8. **方案确认 ≠ 授权写代码**：已两次未经许可写代码，并全部回退。
9. 草稿提升**不能依赖 UI 上的 threadId 状态**；已改为 manager 订阅各自 `threadId$`。
10. mock 的 wire 消息 id 必须**跨轮唯一**，否则 React key 重复。
11. 推送要 `--no-verify`；`unable to get credential storage lock` 是沙箱挡住 git 回写凭证，无害。
12. **无头 Chrome 复现法**：`chrome --headless=new --remote-debugging-port=9223` + Node 22 内置 `WebSocket` 走 CDP；临时 vite（5182）代理到临时 mock（3102）。
13. **临时 mock 会残留**：`kill $!` 常常杀掉的是包装 shell，node 进程还活着占着端口。跑完必须 `lsof -nP -iTCP:3102 -sTCP:LISTEN` 确认，否则**下一次 E2E 会打到旧进程上得到假绿**（`flakyRemaining` 已被旧进程消耗，表现出来是"重试没发生却成功了"）。已发生过一次。
14. **`git add <file>` 是整文件入队**：多个交付改同一个文件时，提交无法按交付号切，只能按"依赖闭包"切（保证每个提交单独可编译）。别硬按 D 编号分。
15. **批量替换测试用例时容易吃掉相邻用例**：`old_string` 覆盖范围写大了会把上一个 `it` 整段删掉。改完 `grep` 一下用例名核对数量。
16. mock 的剧本状态（`flakyRemaining`）是**进程内**的，只消耗一次；重复验证要重启。
17. `ps` 在本环境的沙箱里不可用（`Operation not permitted`），查进程用 `lsof`。

---

## 十一、给接手窗口的第一句话

> 先读 `AGENTS.md`、本文件、`docs/00` §〇；HEAD `0cf3fb0`，204 测试全绿，工作区干净。Day 6 的 6-1/6-1b/6-2 已完成，6-3 做到 D14（工具注册表 + MCP client），**下一步是 D15（MCP HTTP transport + mock 的 `POST /mcp`）**。D17 之前必须先让用户定三个挂起态决策（见 §七末），**不要直接写代码**。

---

## 十二、文档索引

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | **个人做事习惯（最高优先级）**：业务优先、四步法、授权边界、交付上限（已纳入版本库） |
| `docs/00-模块拆解与实现路线.md` | 唯一基准：范围、模块拆解、批次、已排期项、协作约定 §〇 |
| `docs/01/02` Day1/2 手册 · `docs/03/04` 小结 · `docs/05` 面试素材 · `docs/06` Day4 手册 | 历史记录（部分状态行是当时快照） |
| `docs/notes/` | 问题卡片 + 索引 README |
| `docs/assets/` | 架构图与产品视图（svg + png） |

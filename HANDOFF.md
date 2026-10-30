# 交接说明（新会话窗口请先读这份）

> 用途：当前会话上下文太长，换窗口继续。这份文件是**唯一的状态快照**，读完它 + `AGENTS.md` + `docs/00` 的 §〇，就能接着干。
> **最高优先级：仓库根目录的 [`AGENTS.md`](./AGENTS.md)（个人做事习惯）**——业务优先四步法、方案确认 ≠ 授权写代码；与本文冲突时以它为准。
> 最后更新：2026-10-30（Day 5 已完成；Day 6 未开始，6-1 方案已定稿）

---

## 一、开工前必读：协作约定

铁律在 `AGENTS.md` 与 `docs/00-模块拆解与实现路线.md` 的 §〇，最高优先级。摘要：

### A. 写入权限
1. **默认只给改法，不动文件**。改源码 / 改 package.json / 新增删除文件 / 装依赖 / 写文档，都必须先问"要我改吗"。
2. **"好 / 后者 / 按建议 / 继续" ≠ 授权写代码**，只有"写 / 改 / 实现 / 落盘 / 提交"才算。
3. **只做点名的那一处**；别处的问题只报告（文件、行号、原因、最小修法）。
4. 每轮结尾列**本轮改动文件清单**，没有就写"本轮改动：无"。

### B. 功能实现流程
1. **面试高频点**：业务问题 → 市场做法 → 面试考察维度 → 我们怎么做（四步不可跳）。
2. **非高频点**：业务问题 → 我们怎么做（业务问题永远必做）。
3. **一步一步**：每步只动一层，做完立刻验证（`pnpm test` + `pnpm typecheck` + 页面现象）。

**用户目标**：准备 agent 开发岗面试；用本仓从零重写对话系统。**代码默认用户自己写**，助手给设计、骨架、测试、评审。

---

## 二、项目快照

| 项 | 值 |
|---|---|
| 分支 / HEAD | `main` / `13a7078`（远端一致） |
| 包路径 | 仓库根目录（独立仓库） |
| 包名 | `@tencent/docs-ai-wendy-agent-chat`（private） |
| 技术栈 | TypeScript + React 17（`ReactDOM.render`）+ rxjs 7 + vite（demo）+ node:test（tsx 执行） |
| 测试 | **143 / 143**：agent-controller 16、ui-transform 26、message-store 21、parse-frame 9、parse-sse 9、session-gateway 8、split-frames 7、build-chat-body 7、script-to-wire 7、image-block 5、wire-content 5、session-list 4、session-manager 19 |
| 类型 | `pnpm typecheck` exit 0；`tsc -p demo/tsconfig.json` exit 0 |
| 依赖 | react-markdown / remark-gfm / rehype-highlight / highlight.js；rxjs |

### 常用命令（仓库根目录）

```bash
pnpm test        # node --import tsx --test "test/**/*.spec.ts"
pnpm typecheck   # tsc -p tsconfig.json --noEmit
pnpm dev         # demo，端口 5181
pnpm dev:mock    # mock agent，端口 3002
```

- 推送要 `git push --no-verify origin main`：企业全局 pre-push hook 的 LFS 兜底会误报认证失败。
- **mock 改了代码必须重启**，否则 `/runtimes`、`/history`、`error` 剧本都不生效。

### mock 剧本（改地址栏切换）

| URL | 场景 |
|---|---|
| `http://localhost:5181/` | 纯文本（60 帧 × 90ms） |
| `?scenario=tool` | 文本 + webSearch 工具卡 + 文本 |
| `?scenario=markdown` | 10 种 Markdown 语法 |
| `?scenario=error` | 先说半句，再 `RUN_ERROR`（code=`run_timeout`） |

---

## 三、进度

| 批次 | 状态 | 交付 |
|---|---|---|
| Day 1 协议打通 | ✅ | SSE 帧解析、事件解析、网关请求、mock server |
| Day 2 归约与渲染 | ✅ | MessageStore、双通道归约、controller、流式渲染 |
| Day 3 工具调用 | ✅ | ToolPart 四态、工具卡、快照折叠、LiveContext |
| Day 4 输入与消息操作 | ✅ | 空态、复制、Markdown、附件（4-0~4-5）+ 粘贴图片 |
| Day 5 多会话与恢复 | ✅ | SessionManager、左侧列表、刷新恢复、历史加载、删除 |
| **Day 6** | ⬜ **未开始** | 6-1 方案已定（见第七节），代码未写 |
| 已排期 | ⬜ | reasoning → 消息内分区 → 本地持久化 |

Day 5 关键交付（commit `13a7078`）：

- `src/session/`：`SessionManager`（会话表 / 切换 / 删除 / 草稿自动提升 / 指针恢复）、`createLocalStoragePointer`；
- `src/transport/session-gateway.ts`：`fetchRuntimes` / `fetchHistory` / `deleteRuntime`；
- mock：内存会话表；`POST /runtimes`、`POST /history`、`DELETE /runtimes/:id`；`eventsToWireMessages` 把流还原成历史；
- demo：三栏布局、`SessionList`（生成中标记 / 删除确认弹层 / 加载态）、按会话存草稿、启动恢复、历史加载三态；
- 修复：点"新建"被弹回旧会话（草稿提升竞态）、消息 id 跨轮重复（React key）。

---

## 四、模块职责（分层）

```
demo/  main.tsx（useSessions / useActiveStream / useSessionHistory / useBootstrap + 视图）
       session-list.tsx（列表 / 删除确认弹层）
       script-to-wire.ts（事件 → wire 消息，纯函数）
       mock-agent-server.ts（剧本 + 内存会话表 + /runtimes、/history、DELETE）
  │
src/session/    session-manager.ts（会话表/切换/删除/提升/指针）· pointer.ts · types.ts
src/agent/      agent-controller.ts（状态机 / 提交 / 中止 / 历史组装）
src/message/    type.ts · message-store.ts · ui-transform.ts（双通道归约）· wire-content.ts（出站 parts → content_parts）
src/transport/  sse-parser.ts · event-parser.ts · agent-gateway.ts（/chat）· session-gateway.ts（会话接口）· types.ts
src/render/     part-renderer.tsx（分发）· markdown-text.tsx · tool-card.tsx · image-block.tsx
```

约束：`store` 不知道事件；`transform` 不知道状态机；`controller` 不知道 React；`render` 不知道协议；`demo` 不知道 SSE 细节；`session` 不解析消息文本（标题由 `titleOf` 注入）。

---

## 五、核心设计决策（已定，别推翻）

1. **一条 UI 消息 = 一次 run**：靠 `LiveContext.currentAssistantId`；`RUN_STARTED` 清、首个 `TEXT_MESSAGE_START` 赋值、`RUN_FINISHED` 清，`submit` 开头再清一次。
2. **工具结果是 part 的字段**，不是新 part：`status: calling/running/done/failed`，不能用 `result === null` 推断状态。
3. **快照折叠是启发式**：`assistant → tool → assistant` 视为同一轮；孤立 `tool` 降级为 `ErrorPart`；用"直播 parts 与快照 parts `deepEqual`"守住。
4. **多段文本靠 partId** 区分续写还是新段。
5. **状态只在一处写**：`status` 归 controller；`part.status` 归 store。
6. **一个会话一个 controller**：切换只换被订阅的实例；旧流写不回新会话。
7. **草稿不进列表**；`SessionManager` 订阅**各 controller 自己的 `threadId$`** 决定提升（不能用 UI 上"当前活动会话的 threadId"状态——会串）。
8. **删除先服务端再本地**：否则服务端删失败时列表已空，刷新会"复活"。
9. **历史恢复三竞态**：结果写回发起请求的 controller；已有消息则丢弃响应；同 threadId 只允许一个在途请求。
10. **mock 会话表是内存版**：接持久化时只换实现，`/runtimes`、`/history` 形状不变。

---

## 六、协议要点（易错）

- **四种 id**：`threadId`（会话）/ UI 消息 id（= 本轮首个 `TEXT_MESSAGE_START` 的 messageId）/ `partId`（段）/ `toolCallId`（调用）。
- `TEXT_MESSAGE_END` 是**段**边界，不是轮边界，不清 ctx。
- `TOOL_CALL_RESULT.messageId` **不用**（结果不是独立消息）。
- `REASONING_MESSAGE_START` 在 `TEXT_MESSAGE_START` 之前，但不是所有模型都有（**尚未实现**）。
- 请求体 snake_case（`thread_id`、`content_parts`），事件 camelCase（`messageId`、`toolCallId`）。
- `content_parts` 非空时 `content` 被忽略 → 带图时文字必须一起进 `content_parts`（`toWireContentParts` 已保证）。
- 会话接口：`/runtimes` 键集游标（`updated_at_id`），`/history` 下标游标；`display_state: ready | in_progress`（`needs_input` 预留）。
- 图片：粘贴得到 data URL（`source.type='data'`），历史里原样保存；持久化阶段改成 `/files/<hash>`（`source.type='url'`），前端不用改。

---

## 七、Day 6 现状：6-1 错误处理（方案已定，未写码）

### 业务问题（摘要）

长轮次失败概率高、工具可能有副作用、流式中断会留半截、按 token 计费；用户要的是"知道发生了什么 / 能不能恢复 / 恢复时别重复付出"。

### 市场做法

- **OpenAI Python SDK**：默认重试 2 次，只重试连接错误 / 408 / 409 / 429 / ≥500，且**只重试 body 可安全重发的请求**；流式消费**不自动重试**（会重放已交付输出）。
- **AWS**：指数退避必须加 jitter，否则同步重试形成尖峰。
- **Stripe**：POST 用幂等键，同 key 重复请求返回首次结果。

### 面试维度（方案自检表）

分类、重试安全/幂等、退避与拥塞、流式恢复、状态机竞态、工具副作用、用户可感知文案、可观测与成本、故障注入测试。

### 方案

| 层 | 规则 |
|---|---|
| 分类 | 四类：query（没建立）/ stream（中途断）/ run（RUN_ERROR，带业务码）/ abort；错误 part 带 `code` |
| 业务码 | 439902 未登录、439903 无权限、439906 限流（可重试）、439907 积分不足 |
| 手动重试 | 重跑这一轮：复用原 user parts、不新增 user、截断旧回答（与 6-2 共用） |
| L1 自动重试 | 仅 `receivedEvent === false`；500/408/409/429/连接错误；最多 2 次；`min(8s, 400ms·2^n)·random()`；尊重 `Retry-After`；请求带 `request_id` 幂等键 |
| L2 整轮 | **不自动重跑**（成本 / 副作用 / 答案会变）；流中断只提示，续传留到 cursor 阶段 |
| 测试 | 分类器单测、退避序列、abort 立即停、幂等键透传；页面用断网 / 429 / 中途 kill 验收 |

**拆分**：6-1a（分类 + 手动重试）、6-1b（自动重试 + 退避 + 幂等键）。
**待定**：两步合并做还是一步一步一步做；确认后用户说"写"才动文件。

---

## 八、待办与已排期

| 项 | 说明 | 位置 |
|---|---|---|
| **6-1a 错误分类 + 手动重试** | 见第七节 | Day 6，未开始 |
| **6-1b 自动重试** | 退避 + jitter + 幂等键 + UI 提示 | Day 6，未开始 |
| 6-2 重新生成 | 复用 6-1 的动作，挂到正常 assistant 消息上 | Day 6 |
| 6-3 F1 本地工具执行 | 工具注册表；挂起流 + `POST /tool-result` 唤醒 | Day 6 |
| 6-4 F2 AskUserQuestion | 卡片接管输入区；`answer_token` 回传续流；复用 6-3 的挂起机制（最难） | Day 6 |
| 6-5 文档收口 | README、notes 索引、HANDOFF 同步 | Day 6 |
| **reasoning** | `REASONING_*` 事件 + 折叠区；要抽 `ensureAssistantMessage`；快照按 wire 顺序并入 assistant | 已排期 |
| **消息内分区** | 「已完成 · 用时 N 秒」折叠条 + 结论单列；**前置：reasoning** | 已排期 |
| **本地持久化** | 会话/消息/图片落盘（SQLite 或文件），图片走 `/files`，`/history` 形状不变 | 已排期 |
| `activity` role | 现网定义了，后端未用；启用可替代启发式 | 观察 |

---

## 九、已知遗留（不急，别当新发现）

1. `docs/notes/README.md` 两条索引指向不存在的卡片（`-02-curl-http-000`、`-03-leftover-placeholder-throw`）；
2. 空态下点"发送"（没输入）会留一个看不见的空草稿；
3. `src/transport/types.ts` 的 `type: 'text' | 'image' | string` 放宽写法（`string` 吞字面量）；
4. mock 的历史里图片存 data URL，内存会涨（持久化阶段换 `/files`）；
5. 列表没有"加载更多"分页 UI；没有重命名；没有多 Tab 同步；
6. `display_state: in_progress` 只提示、不续流（续传未做）。

---

## 十、踩过的坑（别重犯）

1. **不要 `CI=true pnpm install`**：会先重装 node_modules 再因 frozen-lockfile 中止，导致没有依赖。
2. 迁出 monorepo 后**没有 eslint / prettier**；`pnpm lint` 不存在，验证用 `typecheck` + `test`。
3. **`EventSource` 不可用**（要 POST + header），必须 fetch + 手写 SSE 解析。
4. `finish` 不能把"本轮结束"和"连接结束"混为一谈，三个终止路径共用且必须幂等。
5. 工具事件的联合类型**不要加 catch-all `unknown`**，否则 `switch` 收窄失效。
6. 滚动跟随必须用 `programmaticRef` 忽略自己造成的 scroll。
7. 切场景用 URL（`?scenario=`），不要写死地址。
8. **方案确认 ≠ 授权写代码**：已两次未经许可写代码，并全部回退。
9. 草稿提升**不能依赖 UI 上的 threadId 状态**（切换会话时是旧值，会把新草稿提升成旧会话）；已改为 manager 订阅各自 `threadId$`。
10. mock 的 wire 消息 id 必须**跨轮唯一**，否则 React key 重复。
11. 推送要 `--no-verify`；`unable to get credential storage lock` 是沙箱挡住 git 回写凭证，无害。
12. **无头 Chrome 复现法**（可复用）：`chrome --headless=new --remote-debugging-port=9223` + Node 22 内置 `WebSocket` 走 CDP；临时 vite（5182）代理到临时 mock（3102），不碰用户的 3002。

---

## 十一、给接手窗口的第一句话

> 先读 `AGENTS.md`、本文件、`docs/00` §〇；Day 5 已完成（143 测试，HEAD `13a7078`），Day 6 未开始；6-1 方案已定（见第七节），先确认 6-1a/6-1b 是否合并——**不要直接写代码**。

---

## 十二、文档索引

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | **个人做事习惯（最高优先级）**：业务优先、四步法、授权边界 |
| `docs/00-模块拆解与实现路线.md` | 唯一基准：范围、模块拆解、批次、已排期项、协作约定 §〇 |
| `docs/01/02` Day1/2 手册 · `docs/03/04` 小结 · `docs/05` 面试素材 · `docs/06` Day4 手册 | 历史记录（部分状态行是当时快照） |
| `docs/notes/` | 问题卡片 + 索引 README |
| `docs/assets/` | 架构图与产品视图（svg + png） |

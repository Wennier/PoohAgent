# 交接说明（新会话窗口请先读这份）

> 用途：当前会话上下文太长，需要换窗口继续。这份文件是**唯一的状态快照**，读完它 + `docs/00-模块拆解与实现路线.md` 的 §〇，就能接着干。
> 最后更新：2026-10-29（Day 4 含附件 4-0~4-5 已完成，无阻断）

---

## 一、开工前必读：协作约定

**铁律在 `docs/00-模块拆解与实现路线.md` 的 §〇，最高优先级。** 摘要：

### A. 写入权限
1. **默认只给改法，不动文件**。改源码 / 改 package.json / 新增删除文件 / 装依赖 / 跑 `pnpm install` / 写文档，都必须先问"要我改吗"，得到明确同意才执行。
2. **只做点名的那一处**。就算"不改就编译不过"，也只报告（文件、行号、为什么挡路、最小修法），等指令。
3. 每轮结尾列出**本轮改动文件清单**。
4. 发现别处有问题，只报告，不顺手修。

### B. 功能实现流程（每个新功能都按这个顺序）
1. **自上而下**：先定"用户看到什么" → 再定数据契约 → 最后写实现。禁止先堆底层零件。
2. **先复现**：动手前先在页面/脚本上复现"现在的现象"。复现不出来就不动手。
3. **一步一步**：每步只动一层，做完立刻验证（页面 + `pnpm typecheck` + `pnpm test`），通过再进下一步。

> 自查标准：一轮改了 3 个以上文件且中途没有页面级验证 = 没做到"一步一步"。

**用户身份/目标**：准备 agent 开发岗面试；现网实现已在主干但作者不是本人；用在本仓新建一个包从零重写一遍，目的是**自己完全掌握**。所以：**代码要用户自己写，助手给设计、骨架、测试、评审**。

---

## 二、项目快照

| 项 | 值 |
|---|---|
| 分支 | `main`（独立仓库；monorepo 时代是 `feature/agent_chat_261026`） |
| 包路径 | **仓库根目录**（本仓库即该包，原 `packages/@ai/wendy-agent-chat` 已迁出） |
| 包名 | `@tencent/docs-ai-wendy-agent-chat`（private） |
| 技术栈 | TypeScript + React 17（`ReactDOM.render`）+ rxjs 7 + vite（demo）+ node:test（测试，tsx 执行） |
| 测试 | **105 / 105 通过**（split-frames 7、parse-sse 9、parse-frame 9、build-chat-body 7、message-store 21、ui-transform 26、agent-controller 16、wire-content 5、image-block 5） |
| 类型 | `tsc` exit 0（src + test + demo 三处均通过） |
| 文档 | `docs/00` 路线、`01/02` Day1-2 手册、`03/04` Day2-3 小结、`05` 面试素材、`06` Day4 手册、`notes/` 问题卡片、`assets/` 图 |

### 常用命令

```bash
# 在仓库根目录执行（本仓库即该包，没有 packages/ 这一层）
pnpm test        # node --import tsx --test "test/**/*.spec.ts"
pnpm typecheck   # tsc -p tsconfig.json --noEmit（目前有阻断，见 §七）
pnpm dev         # demo，端口 5181
pnpm dev:mock    # mock agent，端口 3002
```

**本仓库未接 eslint / prettier**（原 monorepo 的 `pnpm lint` 与 `../../node_modules/.bin/{prettier,eslint}` 已不可用）。验证以 `pnpm typecheck` + `pnpm test` + 页面现象为准；格式化跟现有文件风格走。

> 2026-10-29 从 monorepo 迁出为独立仓库：旧文档里的 `packages/@ai/wendy-agent-chat/` 前缀、`eslint` / `build-kit` 相关命令均不再适用。`docs/03`、`docs/04` 历史小结里的 `eslint 0 problem` 是迁出前的记录，保留不追改。

### mock 剧本（改地址栏即可切换）

| URL | 场景 |
|---|---|
| `http://localhost:5181/` | 纯文本（60 帧 × 90ms ≈ 5.5s） |
| `http://localhost:5181/?scenario=tool` | 文本 + webSearch 工具卡 + 文本 |
| `http://localhost:5181/?scenario=markdown` | 10 种 Markdown 语法覆盖 |

页面上还有一个按钮「载入历史快照（模拟）」，走 `controller.loadSnapshot()` → `aggregateSnapshot()`，用来看快照路径的效果。

---

## 三、模块职责（分层）

```
demo（main.tsx）  App / useAgent / MessageList / MessageBubble / Composer / EmptyTip / LogPanel / formatEvent
      │ submit/abort/loadSnapshot              │ renderPart(part)
      ▼                                        ▼
agent/agent-controller.ts                 render/
  status$ / threadId$ / messages$           part-renderer.tsx  → 按 part.type 分发
  submit / abort / loadSnapshot             markdown-text.tsx  → react-markdown + rehype-highlight
  liveCtx（本轮正在写的消息指针）             tool-card.tsx      → 工具卡四态
                                             image-block.tsx    → 用户附件缩略图（240 上限 + 文件名）
      │                                      │
      ▼                                      │
message/ui-transform.ts                      │
  applyLiveEvent(store, event, ctx)          │  ← 直播：事件 → store
  aggregateSnapshot(wire) → UIMessage[]      │  ← 快照：扁平消息 → UI 消息（纯函数）
message/message-store.ts                     │
  BehaviorSubject<UIMessage[]> + 不可变更新   │
  replaceAll/push/find/replaceId/appendText/appendPart
  startToolPart/appendToolArgs/markToolRunning/patchToolResult/failToolPart
message/type.ts        UIMessage / Part / TextPart / ToolPart / ImagePart / ErrorPart / LiveContext
message/wire-content.ts toWireContentParts（出站：parts → content_parts）
transport/             sse-parser（字节→帧）/ event-parser（帧→事件）/ agent-gateway（请求+fetch）/ types（契约）
```

**约束**：`store` 不知道事件；`transform` 不知道状态机；`controller` 不知道 React；`render` 不知道协议；`demo` 不知道 SSE 细节。

---

## 四、核心设计决策（已定，别推翻）

1. **一条 UI 消息 = 一次 run（A 方案）**
   一次回答可能被工具切成多段 `TEXT_MESSAGE`，但 UI 上是一条消息、多段 parts。
   实现：`LiveContext { currentAssistantId }` —— `RUN_STARTED` 清空、首个 `TEXT_MESSAGE_START` 赋值、`RUN_FINISHED` 清空，另在 `submit()` 开头再清一次（因为 `RUN_ERROR` 不清）。

2. **工具结果做成 part 的字段，不是新 part**
   `ToolPart = { type:'tool', id(name=toolCallId), name, args, result, status }`
   `status: 'calling' | 'running' | 'done' | 'failed'`，**不能用 `result === null` 推断状态**。
   原因：直播侧结果是一条事件，快照侧是一条独立 `tool` 消息；做成字段后两条路径天然同构。

3. **快照折叠靠启发式**
   `assistant → tool → assistant` 视为同一轮；孤立 `tool` 降级为 `ErrorPart`。协议没有 `run_id`，这是弱证据。
   守住它的是测试：**直播重放的 parts 与快照折叠的 parts `deepEqual`**。

4. **多段文本靠 partId 区分**
   `appendText(messageId, delta, partId?)`：`partId` 与最后一段不同 → 新建 text part，否则续写。

5. **状态只在一处写**：`status`（控制器）归 controller；`part.status` 归 store。

---

## 五、协议要点（易错）

- **四种 id**：`threadId`（会话）/ UI 消息 id（= 本轮第一个 `TEXT_MESSAGE_START` 的 messageId）/ `partId`（每段自己的 messageId）/ `toolCallId`（调用）。
- `TEXT_MESSAGE_END` 是**段**的边界，不是轮的边界，**不清 ctx**。
- `TOOL_CALL_RESULT.messageId` **不用**（结果不是独立消息）。
- `REASONING_MESSAGE_START` 出现在 `TEXT_MESSAGE_START` **之前**，但不是所有模型都有（可选前缀，不能假设第一条就是它）。
- 请求体字段 snake_case（`thread_id`、`content_parts`），响应 camelCase（`messageId`、`toolCallId`）。
- **`content_parts` 非空时 `content` 被忽略** → 带图片时文字也必须进 `content_parts`。

---

## 六、Day 4 步 4「附件最小版」：已完成

**目标效果**：Composer 上方 chip 区 → 发送后 user 气泡显示缩略图 + 文字 → mock 回复「收到 N 张图片」。

**范围**：图片来自**手填 URL** 或**剪贴板粘贴**（粘贴转 data URL，单张 ≤ 2MB）；不做上传 / 拖拽 / 放大 / assistant 侧图片。注意：刷新后图还在，要等 §八 的「本地持久化」。

### 进度

| 步 | 内容 | 状态 |
|---|---|---|
| 4-0 | 数据契约（`ImagePart` / `ImageInput` / `WireContentPart`） | ✅ |
| 4-1 | `toWireContentParts` + 单测（`src/message/wire-content.ts`） | ✅ |
| 4-2 | `submit(text, images)` 组装 parts + `buildWireHistory` 接 `toWireContentParts`（只挂 user） | ✅ |
| 4-3 | `part-renderer` 加 `case 'image'` + `ImageBlock`（240 上限、文件名、加载失败占位） | ✅ |
| 4-4 | Composer chip 区 + 剪贴板粘贴（`draftImages`、2MB 上限、失败提示） | ✅ |
| 4-5 | 快照路径 `content_parts` → `ImagePart` + mock 回显「收到 N 张图片」 | ✅ |

### 三条不变量（违反就会出事）

1. `content_parts` 非空时，文字必须一起进 `content_parts`（否则用户输入消失）
2. image part 只属于 user 消息
3. 快照路径也要能出 `ImagePart`（否则"发完能看到，刷新就没了"）

---

## 七、当前阻断项

**无。** 验证口径：`pnpm typecheck` exit 0 · `pnpm test` 105 / 105 · `tsc -p demo/tsconfig.json` exit 0。

已修掉的旧阻断（2026-10-29）：

1. `submit` 从 1 参变 2 参 → 10 处测试调用与 `demo/main.tsx` 全部补齐；
2. `src/agent/agent-controller.ts` 的 `images` 未使用 → 4-2 已用上。

遗留（**非阻断**）：`src/transport/types.ts:38` 的 `type: 'text' | 'image' | string` 里 `string` 会吞掉字面量，`switch` 收窄时注意；真要收窄就改成 `(string & {})`。

---

## 八、待办与已排期

| 项 | 说明 | 位置 |
|---|---|---|
| **reasoning 实现** | 协议有 `REASONING_MESSAGE_START/CONTENT/END`，UI 需"思考过程"折叠区。**用户已决定放到附件之后做**。要抽 `ensureAssistantMessage`（占位接管/复用/新建）给 reasoning 与 text 共用；快照侧按 **wire 顺序**并入 assistant（不是固定前置，因为思考可能多段交错） | 未开始 |
| **消息内分区（过程/结论分离）** | 「已完成 · 用时 N 秒」折叠条 + 结论单列。判据：完成后按最后一个 text/error 切；流式中不折叠且最后一项可见。**前置：reasoning 要先做** | 已排期，见 `docs/00` Day 5 之后 |
| 附件 4-2 ~ 4-5 | 见 §六 | ✅ 已完成 |
| **本地持久化（含图片回放）** | 把会话 / 消息 / 图片落盘，做成脱离 mock 也能回放的本地 Agent：刷新或重启后历史与图片都能还原。建议 IndexedDB 存 Blob + 元数据（备选：本地 Node 服务落 `data/` 并对外给文件 URL）。**前置：4-5（快照支持 `content_parts`）+ Day 5（会话恢复）** | 已排期，见 `docs/00` Day 5 之后 |
| `activity` role | 现网 `agent-kit` 定义了 `role:'activity'` + `ACTIVITY_SNAPSHOT/DELTA`，后端未用；将来若启用可替代启发式 | 观察，不做 |

---

## 九、踩过的坑（别重犯）

1. **不要 `CI=true pnpm install`**：它会先 `Recreating node_modules` 再因 `frozen-lockfile` 中止，导致整个工作区没有依赖。要更新 lockfile 时必须 `pnpm install --no-frozen-lockfile`。
2. **prettier 与 eslint 的 `arrow-parens` 冲突**：prettier 写回括号、eslint 要去掉，最终以 `eslint --fix` 为准（迁出后本仓库无 prettier / eslint，此坑仅作记录）。
3. **`EventSource` 不可用**（要 POST + 自定义 header），必须 fetch + 手写 SSE 解析；`curl http=000` 表示 TCP 都没连上，先查端口/进程。
4. **单测抓不到的生命周期 bug**：`finish` 曾把"本轮结束"和"连接结束"混为一谈，导致中止静默失效；假连接不产生"错误已到但连接仍开着"的中间态。
5. **工具事件的联合类型不要加 catch-all `unknown` 成员**，否则 `switch` 收窄失效、分支里全是 `unknown`。
6. **滚动跟随**：必须用 `programmaticRef` 忽略自己造成的 scroll，否则"自动贴底"和"用户上滑"互相打架 → 抖动。
7. **切场景用 URL**：`resolveAgentUrl()` 从 `location.search` 读 `?scenario=`，不要在 controller 里写死地址（写死会被 lint 规则拦且污染生产路径）。

---

## 十、文档索引

| 文件 | 内容 |
|---|---|
| `docs/00-模块拆解与实现路线.md` | **唯一基准**：范围、模块拆解、批次、已排期项、**协作约定 §〇** |
| `docs/01/02-Day1/2-操作手册.md` | 当日分步操作 |
| `docs/03-Day2-小结.md` | 双通道归约、三个够格的技术难点 |
| `docs/04-Day3-小结.md` | 工具调用、A 方案、id 分层、复盘（含"地基没打好"的定位） |
| `docs/05-面试素材.md` | 只放"怎么讲"：30 秒稿 + 追问 + 口径，指向 03/04 的真源 |
| `docs/06-Day4-操作手册.md` | 空态/复制/Markdown/附件四步 |
| `docs/notes/` | 问题卡片（现象/误判/根因/方案/追问）+ 索引 README |
| `docs/assets/` | 架构图与产品视图（svg + png） |

---

## 十一、给接手窗口的第一句话建议

> 读 `HANDOFF.md` 与 `docs/00-模块拆解与实现路线.md` §〇；Day 4（含附件 4-0~4-5）已完成、无阻断；下一步从 §八 的 reasoning / 本地持久化里选；先确认"要我改吗"，再动手。

# TEXT_MESSAGE_END 是"段"的边界，不是"轮"的边界

- 批次：Day 3
- 模块：A2 归约 / `LiveContext`

## 现象

工具场景的日志顺序是：

```
TEXT_MESSAGE_START(msg_a) → CONTENT×6 → TOOL_CALL_START → ARGS×3 → TOOL_CALL_END
→ TEXT_MESSAGE_END(msg_a)   ← 这里
→ TOOL_CALL_RESULT
→ TEXT_MESSAGE_START(msg_b) → CONTENT×8 → TEXT_MESSAGE_END(msg_b)
→ RUN_FINISHED
```

如果在 `TEXT_MESSAGE_END` 时把 `ctx.currentAssistantId` 清空：

- `TOOL_CALL_RESULT` 找不到当前消息 → 卡片结果回填失败，卡片永远停在"正在执行"
- 第二段的 `CONTENT` 全部丢弃 → 用户只看到半句回答

## 误判

<!-- TODO(wendy)：写你当时的想法。是不是觉得 END 就代表"这次回答完了"？ -->

## 根因

`TEXT_MESSAGE_END` 关的是**一段文本**（一次 `TEXT_MESSAGE`），而"一次回答"的边界是 `RUN_STARTED` ~ `RUN_FINISHED`。

两者的层级不同：一次 run 可以包含多个 `TEXT_MESSAGE`（工具调用会把回答切开）。所以：

| 事件 | 边界层级 | 对 ctx 的影响 |
| --- | --- | --- |
| `TEXT_MESSAGE_START / END` | 段 | 只影响"往哪个 text part 写" |
| `RUN_STARTED / RUN_FINISHED` | 轮 | 决定 ctx 的建立与清空 |

## 方案

- `RUN_STARTED` → `ctx = null`
- 首个 `TEXT_MESSAGE_START` → `ctx = messageId`
- `TEXT_MESSAGE_END` → **不动 ctx**
- `RUN_FINISHED` → `ctx = null`
- 另外 `submit()` 开头也清一次：因为 `RUN_ERROR` 不清 ctx（错误还要挂在当前回答上）

## 追问

- 如果后端把一次 run 拆成多个 `RUN_FINISHED`（比如分段推送），UI 消息边界该怎么改？
- 一次 run 内如果**真的**要产生两条独立回答，靠什么信号切分？（现在没有这个信号，所以强制合并）

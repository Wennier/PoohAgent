# 工具结果：做成 part 的字段，还是一个新的 part？

- 批次：Day 3
- 模块：A2 归约 / `message/ui-transform.ts`、`message/message-store.ts`

## 现象

同一段对话（问天气 → 调 webSearch → 回答），两条路径拿到的原始数据形态不同：

```
直播：TOOL_CALL_START/ARGS/END 是事件，TOOL_CALL_RESULT 也是一条事件
快照：assistant{ tool_calls:[...] } + tool{ tool_call_id, content } —— 结果是一条独立消息
```

第一版按"事件即节点"处理，于是直播侧会产出 `[text, tool, toolResult]` 三段，快照侧只能产出 `[tool, text]` —— **同一条对话，两条路径结构不等价**，Day 2 立的不变量当场破。

## 误判

<!-- TODO(wendy)：你当时的第一反应是什么？
     比如：是否以为"结果也是一条消息/一个块"，只要按顺序 append 就行？ -->

## 根因

把"结果"当成了**时间序列里的一环**，而产品的认知单位是"**一次工具调用**"：入参和出参属于同一个事务，卡片是一个整体。

从数据上看：只要结果是一个独立 part，"两条路径对齐"就必须额外写映射逻辑（而且快照侧没有 `parentMessageId` 可依赖）；把结果变成 tool part 的 `result` 字段，两条路径**天然同构**。

## 方案

`ToolPart = { type:'tool', id, name, args, result, status }`

- 直播：`TOOL_CALL_RESULT` → 回填 `result` 字段（不新增 part）
- 快照：`tool` 消息 → 按 `tool_call_id` 找到对应 part 回填

**代价**：丢失"结果到达的时序"（看不出结果是否早于后续文本）。
**收益**：两条路径产出一致，用一条 `deepEqual` 测试就守住了。

## 追问

- 什么情况下"把结果做成节点"反而是对的？（提示：需要按时间轴回放/逐事件追溯的调试视图）
- 字段化之后，如何表达"结果比后续文本先到"这类时序信息？（事件日志里保留，UI 不表达）
- 快照侧没有 `parentMessageId` 时，归属除了靠顺序还能靠什么？

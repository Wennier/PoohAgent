/**
 * 会话层的类型契约。
 *
 * 一个「会话」= 一份独立的消息列表 + 状态机 + threadId（由 AgentController 持有）。
 * 这里只定义"会话在列表里长什么样"和"上次停在哪"两件事，不涉及消息内容——
 * 消息归 controller，历史归服务端。
 */

export interface SessionMeta {
  /** 正式会话 = 服务端 threadId；草稿 = draft_<ts>。 */
  id: string;
  /** 列表里显示的名字。草稿期是「未命名」，首轮后可由服务端标题覆盖。 */
  title: string;
  /**
   * draft：还没发出第一条消息，**不进列表**（避免一堆空记录）。
   * ready：已经落成正式会话，列表可见。
   */
  kind: 'draft' | 'ready';
  createdAt: number;
  updatedAt: number;
}

/**
 * 「上次停在哪」的持久化。
 *
 * 只存一个 id，不存消息本体：消息归服务端，这里只负责刷新后能找回入口。
 * 单独抽成接口是为了测试能注入内存实现，也方便以后从 localStorage 换成别的。
 */
export interface SessionPointer {
  read(): string | null;
  write(id: string | null): void;
}

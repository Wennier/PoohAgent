/**
 * wendy-agent-chat 对外出口。
 *
 * 按批次逐层补出：Day 1 transport → Day 2 消息模型与归约 → 后续会话 / 渲染。
 *
 * 目录约定见 docs/00-模块拆解与实现路线.md。
 */

// ---- Day 1：传输层 ----
export { buildChatBody, connectAgentStream } from './transport/agent-gateway';
export { parseAgentEvents, parseFrame } from './transport/event-parser';
export { parseSseFrames, splitFrames } from './transport/sse-parser';
export type {
  AgentEvent,
  BaseEvent,
  ChatContext,
  ChatRequestBody,
  ConnectInput,
  WireContentPart,
  WireMessage,
  WireToolCall,
} from './transport/types';

// ---- Day 2：消息模型与归约 ----
export { MessageStore } from './message/message-store';
export type {
  BasePart,
  ErrorPart,
  Part,
  TextPart,
  UIMessage,
  UIMessageRole,
} from './message/type';
export {
  ASSISTANT_PLACEHOLDER_PREFIX,
  createAssistantPlaceholder,
  getTextContent,
  isAssistantPlaceholder,
} from './message/type';
export {
  aggregateSnapshot,
  applyLiveEvent,
  createErrorPart,
  createTextPart,
  extractWireText,
} from './message/ui-transform';

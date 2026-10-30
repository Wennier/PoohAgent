/**
 * demo 主入口 —— 可运行的 UI 空壳。
 *
 * 只提供「架子」，不含任何业务逻辑：
 * - 顶部：会话信息占位（threadId / 状态）
 * - 中部：消息区占位（Day 2 接入渲染）
 * - 下部：输入区（Day 1 第二段接 transport）
 * - 右侧：事件日志（Day 1 的验收窗口：SSE 事件按序打印在这里）
 *
 * 后续各批次只需要替换对应区块的实现，不必重排页面结构。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';

import 'highlight.js/styles/github.css';

import type { Subscription } from 'rxjs';

import { AgentController, AgentStatus, type ImageInput } from 'src/agent/agent-controller';
import { getTextContent, type UIMessage } from 'src/message/type';
import { renderPart } from 'src/render/part-renderer';
import { createLocalStoragePointer } from 'src/session/pointer';
import { SessionManager } from 'src/session/session-manager';
import type { SessionMeta } from 'src/session/types';
import { connectAgentStream } from 'src/transport/agent-gateway';
import { fetchHistory, fetchRuntimes, deleteRuntime } from 'src/transport/session-gateway';
import type { AgentEvent, RuntimeSummary, WireMessage } from 'src/transport/types';

import { SessionList } from './session-list';

// ============================================================
// 类型
// ============================================================

interface LogEntry {
  id: number;
  time: string;
  text: string;
  tone: 'info' | 'success' | 'error';
}

interface LogLine {
  text: string;
  tone: LogEntry['tone'];
}

/**
 * demo 用：把页面 URL 上的 ?scenario=xxx 拼到 /chat 请求上，方便在浏览器里切 mock 剧本。
 * 不带参数时返回默认路径。
 */
function resolveAgentUrl(): string {
  const scenario = new URLSearchParams(window.location.search).get('scenario');

  return scenario ? `/api/v6/agentgateway/chat?scenario=${encodeURIComponent(scenario)}` : '/api/v6/agentgateway/chat';
}

/** 会话列表与历史（Day 5）。走同一个 vite proxy，路径与真实网关一致。 */
const RUNTIMES_URL = '/api/v6/agentgateway/runtimes';
const HISTORY_URL = '/api/v6/agentgateway/history';

/**
 * 把一条事件转成一行可读日志。
 *
 * 刻意不直接 `JSON.stringify(event)`：一轮有 60+ 条 CONTENT，
 * 打全量 JSON 会把真正重要的 RUN_STARTED / RUN_FINISHED 淹没掉。
 */
function formatEvent(event: AgentEvent): LogLine {
  const raw = event as unknown as Record<string, unknown>;

  switch (event.type) {
    case 'RUN_STARTED':
      return { text: `RUN_STARTED threadId=${String(raw.threadId)}`, tone: 'success' };
    case 'TEXT_MESSAGE_START':
      return { text: `TEXT_MESSAGE_START messageId=${String(raw.messageId)}`, tone: 'info' };
    case 'TEXT_MESSAGE_CONTENT':
      return { text: `TEXT_MESSAGE_CONTENT ${JSON.stringify(raw.delta)}`, tone: 'info' };
    case 'TEXT_MESSAGE_END':
      return { text: 'TEXT_MESSAGE_END', tone: 'info' };
    case 'RUN_FINISHED':
      return { text: 'RUN_FINISHED', tone: 'success' };
    case 'TOOL_CALL_START':
      return { text: `TOOL_CALL_START ${String(raw.toolCallName)} (${String(raw.toolCallId)})`, tone: 'success' };
    case 'TOOL_CALL_ARGS':
      return { text: `TOOL_CALL_ARGS ${JSON.stringify(raw.delta)}`, tone: 'info' };
    case 'TOOL_CALL_END':
      return { text: `TOOL_CALL_END ${String(raw.toolCallId)}`, tone: 'info' };
    case 'TOOL_CALL_RESULT':
      return { text: `TOOL_CALL_RESULT ${String(raw.content)}`, tone: 'success' };
    case 'RUN_ERROR':
      return { text: `RUN_ERROR ${String(raw.message ?? '')}`, tone: 'error' };
    default: {
      // 联合类型已被穷尽 → 这里 event 是 never；但运行时仍可能收到未知事件（parseFrame 会透传）
      const unknownType = (event as { type?: string }).type ?? 'UNKNOWN';
      return { text: `? ${unknownType}`, tone: 'info' };
    }
  }
}

// ============================================================
// App
// ============================================================

/** 自动重试的回执信息（来自 transport/retry，UI 只读不推）。 */
interface RetryNoticeInfo {
  retryIndex: number;
  maxRetries: number;
  delayMs: number;
}

const App: React.FC = () => {
  const { logs, appendLog, clearLogs } = useLogs();
  const [retryNotice, setRetryNotice] = useState('');

  const handleRetryNotice = useCallback((info: RetryNoticeInfo) => {
    const delay = info.delayMs >= 1000 ? `${(info.delayMs / 1000).toFixed(1)} 秒` : `${info.delayMs} 毫秒`;
    setRetryNotice(`网络不稳，正在自动重试 ${info.retryIndex + 1}/${info.maxRetries}（约 ${delay}后）`);
  }, []);

  const { manager, sessions, activeId } = useSessions(appendLog, handleRetryNotice);

  // 依赖 activeId 而不是 activeId$：换会话就换 controller，订阅跟着换
  const controller = useMemo(
    () => (activeId === null ? null : manager.controllerOf(activeId)),
    [manager, activeId],
  );
  const { messages, status, threadId } = useActiveStream(controller);

  // 提示只活到"这一轮结束"或"新内容到达"为止
  useEffect(() => {
    if (status !== AgentStatus.Generating) setRetryNotice('');
  }, [status]);
  useEffect(() => {
    setRetryNotice('');
  }, [messages]);
  const statuses = useSessionStatuses(manager, sessions);

  /** 启动：拉会话列表 → 灌进 manager → 恢复上次停的位置（P2）。 */
  const { booting, error: bootError, retry: retryBootstrap } = useBootstrap(manager);
  const activeMeta = activeId === null ? null : manager.activeMeta;
  /** 激活一个还没加载过的历史会话时拉消息（5-4）。 */
  const history = useSessionHistory(manager, controller, activeMeta);

  /** 每个会话一份输入草稿：切走再切回来，没发出去的内容还在（E2）。 */
  const [drafts, setDrafts] = useState<Record<string, SessionDraft>>({});
  const activeDraft = activeId === null ? EMPTY_DRAFT : (drafts[activeId] ?? EMPTY_DRAFT);
  /** 删除失败提示（服务端没删掉时不能只删本地，否则刷新会"复活"）。 */
  const [deleteError, setDeleteError] = useState('');

  const isStreaming = status === AgentStatus.Generating;

  /** 空态下第一次输入/发送时，先落一个草稿会话（不进列表）。 */
  const ensureSession = useCallback((): string => activeId ?? manager.createDraft(), [activeId, manager]);

  // 草稿提升由 SessionManager 订阅各自的 threadId$ 完成（见 controllerOf）：
  // 不能在这里用「当前活动会话的 threadId 状态」判断——切换会话那一帧它是旧值，
  // 会把新草稿提升成旧会话的 threadId，表现就是"点新建又被弹回旧会话"。

  const handleDraftChange = useCallback(
    (text: string) => {
      const targetId = ensureSession();
      setDrafts(previous => ({
        ...previous,
        [targetId]: { ...(previous[targetId] ?? EMPTY_DRAFT), text },
      }));
    },
    [ensureSession],
  );

  const handleAddImage = useCallback(
    (image: ImageInput) => {
      const targetId = ensureSession();
      setDrafts(previous => ({
        ...previous,
        [targetId]: {
          ...(previous[targetId] ?? EMPTY_DRAFT),
          images: [...(previous[targetId]?.images ?? []), image],
        },
      }));
    },
    [ensureSession],
  );

  const handleRemoveImage = useCallback(
    (index: number) => {
      if (activeId === null) return;

      setDrafts(previous => {
        const draft = previous[activeId] ?? EMPTY_DRAFT;
        return { ...previous, [activeId]: { ...draft, images: draft.images.filter((_, i) => i !== index) } };
      });
    },
    [activeId],
  );

  const handleSend = useCallback(() => {
    const targetId = ensureSession();
    const draft = drafts[targetId] ?? EMPTY_DRAFT;

    // 只有真的发出去（状态门禁通过）才清空草稿与附件，
    // 否则「生成中被拒」会把用户刚粘的图弄丢。
    if (manager.controllerOf(targetId).submit(draft.text, draft.images)) {
      setDrafts(previous => ({ ...previous, [targetId]: EMPTY_DRAFT }));
    }
  }, [drafts, ensureSession, manager]);

  /**
   * 重新生成某一条回答：复用那条提问、丢掉它之后的全部对话。
   *
   * 不是最后一条时要先确认——用户点的是"重来这句话"，代价是后面几轮一起消失。
   */
  const handleRetryMessage = useCallback(
    (messageId: string) => {
      const targetId = manager.activeMeta?.id;
      if (!targetId) return;

      const controller = manager.controllerOf(targetId);
      const isLatest = controller.snapshot.at(-1)?.id === messageId;
      if (!isLatest && !window.confirm('重新生成这条回答会丢弃它之后的全部对话，继续？')) return;

      controller.retryLastTurn(messageId);
    },
    [manager],
  );

  /** 推荐问题直接发：不经过输入框，但走同一条提交链路。 */
  const handlePick = useCallback(
    (text: string) => {
      manager.controllerOf(ensureSession()).submit(text, []);
    },
    [ensureSession, manager],
  );

  const handleCreate = useCallback(() => {
    setDeleteError('');

    const meta = manager.activeMeta;
    // 已经停在一个空草稿上：不重复创建，避免留下看不见的孤儿草稿
    if (meta?.kind === 'draft' && manager.controllerOf(meta.id).snapshot.length === 0) return;

    manager.createDraft();
  }, [manager]);

  const handleSelect = useCallback(
    (id: string) => {
      setDeleteError('');
      manager.activate(id);
    },
    [manager],
  );

  /**
   * 删除会话：**先服务端、再本地**。
   *
   * 反过来的话，服务端删失败时列表已经空了，刷新又会"复活"——
   * 用户会以为删除是坏的。
   */
  const handleRemove = useCallback(
    async (id: string) => {
      setDeleteError('');

      try {
        await deleteRuntime({ url: RUNTIMES_URL, threadId: id });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);

        // 404 = 服务端本来就没有了，等同于删除成功
        if (!message.includes('HTTP 404')) {
          setDeleteError(message);
          return;
        }
      }

      setDrafts(previous => {
        if (!(id in previous)) return previous;

        const next = { ...previous };
        delete next[id];
        return next;
      });

      manager.remove(id);
    },
    [manager],
  );

  const handleAbort = useCallback(() => controller?.abort(), [controller]);
  const handleLoadSnapshot = useCallback(() => controller?.loadSnapshot(SNAPSHOT_FIXTURE), [controller]);

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.title}>wendy-agent-chat · demo</div>
        <div style={styles.meta}>
          <span>
            threadId:
            {threadId || '(未开始)'}
          </span>
          <span>
            status:
            {status}
          </span>
          <button type="button" style={styles.buttonTiny} onClick={handleLoadSnapshot}>
            载入历史快照（模拟）
          </button>
        </div>
      </header>

      <main style={styles.main}>
        <aside style={styles.sessionColumn}>
          <SessionList
            sessions={sessions}
            activeId={activeId}
            statuses={statuses}
            loading={booting}
            errorText={deleteError}
            onSelect={handleSelect}
            onCreate={handleCreate}
            onRemove={handleRemove}
          />
        </aside>

        <section style={styles.chatColumn}>
          {booting ? (
            <div style={styles.centerTip}>正在加载会话…</div>
          ) : bootError !== '' ? (
            <div style={styles.centerTip}>
              <span>会话列表加载失败：{bootError}</span>
              <button type="button" style={styles.buttonTiny} onClick={retryBootstrap}>
                重试
              </button>
            </div>
          ) : history.state === 'loading' ? (
            <div style={styles.centerTip}>正在加载历史…</div>
          ) : history.state === 'error' ? (
            <div style={styles.centerTip}>
              <span>历史加载失败：{history.error}</span>
              <button type="button" style={styles.buttonTiny} onClick={history.retry}>
                重试
              </button>
            </div>
          ) : messages.length === 0 ? (
            <EmptyTip disabled={isStreaming} onPick={handlePick} />
          ) : (
            <>
              {history.notice !== '' && <div style={styles.notice}>{history.notice}</div>}
              <MessageList messages={messages} onRetryMessage={handleRetryMessage} />
            </>
          )}
          {retryNotice !== '' && <div style={styles.notice}>{retryNotice}</div>}
          <Composer
            draft={activeDraft.text}
            images={activeDraft.images}
            streaming={isStreaming}
            disabled={history.state === 'loading'}
            onDraftChange={handleDraftChange}
            onAddImage={handleAddImage}
            onRemoveImage={handleRemoveImage}
            onSend={handleSend}
            onAbort={handleAbort}
          />
        </section>

        <aside style={styles.logColumn}>
          <LogPanel logs={logs} onClear={clearLogs} />
        </aside>
      </main>
    </div>
  );
};

// ============================================================
// 接入层：把 AgentController 挂进 React
// ============================================================

/** 每个会话一份输入草稿：切走再切回来，没发出去的内容还在（E2）。 */
interface SessionDraft {
  text: string;
  images: ImageInput[];
}

const EMPTY_DRAFT: SessionDraft = { text: '', images: [] };

/** 首条用户消息截 20 字做标题；没有就「未命名」。 */
function draftTitle(messages: UIMessage[]): string {
  const firstUser = messages.find(message => message.role === 'user');
  const text = firstUser ? getTextContent(firstUser).trim() : '';

  return text === '' ? '未命名' : text.slice(0, 20);
}

/** 日志前缀：多会话并发时事件会交错，用短 id 区分来源。 */
function shortSessionId(id: string): string {
  return id.length <= 6 ? id : id.slice(-4);
}

/**
 * 快照里的示例图：内联 SVG，不依赖网络。
 * 4-5 用它验证「`content_parts` → `ImagePart`」这条快照路径——不接的话这行只会显示文字。
 */
const SNAPSHOT_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#f5f7fa"/><text x="160" y="82" fill="#4b5563" font-size="20" font-family="sans-serif" text-anchor="middle">北京 · 晴 28°C</text><text x="160" y="114" fill="#9ca3af" font-size="14" font-family="sans-serif" text-anchor="middle">weather.svg</text></svg>',
)}`;

/**
 * 模拟 /history 的返回：工具调用把一次回答切成了三条扁平消息。
 * 第一条 user 带 content_parts（文字 + 图片），用来验收「快照也能还原图片」。
 */
const SNAPSHOT_FIXTURE: WireMessage[] = [
  {
    id: 'w1',
    role: 'user',
    content: '北京天气',
    content_parts: [
      { type: 'text', text: '北京天气（顺便看下这张图）' },
      { type: 'image', filename: 'weather.svg', source: { type: 'data', value: SNAPSHOT_IMAGE, mime_type: 'image/svg+xml' } },
    ],
  },
  {
    id: 'msg_a',
    role: 'assistant',
    content: '我先用 webSearch 查一下北京的天气。',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'webSearch', arguments: '{"query":"北京天气"}' } },
    ],
  },
  { id: 'msg_tool', role: 'tool', tool_call_id: 'call_1', content: '{"city":"北京","weather":"晴","tempC":28}' },
  { id: 'msg_b', role: 'assistant', content: '北京今天晴，气温 28°C。需要我再查别的城市吗？' },
];

interface SessionsApi {
  manager: SessionManager;
  sessions: SessionMeta[];
  activeId: string | null;
}

/**
 * 造 manager、订阅会话表与活动会话。
 *
 * 组件层仍然只做三件事：造实例、订阅、转发命令 —— 会话状态、消息、状态机
 * 都在各自的 AgentController 里，切换会话只是换一个被订阅的实例。
 */
function useSessions(
  appendLog: (text: string, tone?: LogEntry['tone']) => void,
  onRetryNotice?: (info: RetryNoticeInfo) => void,
): SessionsApi {
  const [manager] = useState(
    () =>
      new SessionManager({
        // 每个会话一个 controller；sessionId 让日志能区分来源（多会话并发时事件会交错）
        createController: sessionId =>
          new AgentController({
            // 剧本从页面 URL 读（?scenario=tool），这样不用改代码就能切 mock 场景
            connect: input => connectAgentStream({ ...input, url: resolveAgentUrl() }),
            onEvent: (event) => {
              const line = formatEvent(event);
              appendLog(`[${shortSessionId(sessionId)}] ${line.text}`, line.tone);
            },
            // 自动重试只在这一层知道「第几次、等多久」，UI 不该自己猜
            retryOptions: { onRetry: info => onRetryNotice?.(info) },
          }),
        pointer: createLocalStoragePointer(),
        // 标题规则属于产品层：会话层只负责"什么时候提升"，不解析消息
        titleOf: controller => draftTitle(controller.snapshot),
      }),
  );

  const [sessions, setSessions] = useState<SessionMeta[]>(() => manager.sessions$.value);
  const [activeId, setActiveId] = useState<string | null>(() => manager.activeId$.value);

  useEffect(() => {
    const subscriptions = [
      manager.sessions$.subscribe(setSessions),
      manager.activeId$.subscribe(setActiveId),
    ];

    return () => {
      subscriptions.forEach(subscription => subscription.unsubscribe());
      manager.dispose();
    };
  }, [manager]);

  return { manager, sessions, activeId };
}

/** 服务端的会话摘要 → 本地列表项。 */
function toSessionMeta(runtime: RuntimeSummary): SessionMeta {
  return {
    id: runtime.thread_id,
    title: runtime.title === '' ? '未命名' : runtime.title,
    kind: 'ready',
    createdAt: runtime.created_at,
    updatedAt: runtime.updated_at,
  };
}

interface BootstrapState {
  booting: boolean;
  error: string;
  retry: () => void;
}

/**
 * 启动引导：拉会话列表 → 灌进 manager → 恢复上次会话（P2）。
 *
 * 为什么不等"用户点开再拉"：列表本身也需要数据，空列表会让用户以为会话丢了。
 * 失败时不阻塞页面，只把错误交给界面显示 + 重试。
 */
function useBootstrap(manager: SessionManager): BootstrapState {
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setBooting(true);
    setError('');

    fetchRuntimes({ url: RUNTIMES_URL, signal: abort.signal })
      .then(response => {
        manager.hydrate(response.data.map(toSessionMeta));
        manager.restore();
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!abort.signal.aborted) setBooting(false);
      });

    return () => abort.abort();
  }, [manager, attempt]);

  return { booting, error, retry: () => setAttempt(value => value + 1) };
}

type HistoryLoadState = 'idle' | 'loading' | 'error';

interface SessionHistoryState {
  state: HistoryLoadState;
  error: string;
  /** 历史拉回来后的附加提示（如"上一轮没生成完"）。 */
  notice: string;
  retry: () => void;
}

/**
 * 激活历史会话时，把消息拉回来灌进对应的 controller（5-4 / B3）。
 *
 * 三条竞态约束（缺一条就会出现"切一下消息就串了/闪回去"）：
 * 1. 结果只写回**发起请求的那个 controller**，不写"当前 active"；
 * 2. 响应回来时若该会话已经有消息（用户抢先发了一条）→ **丢弃响应**，现场数据优先；
 * 3. 同一 threadId 只允许一个在途请求（去重 + 切回来不重复拉）。
 */
function useSessionHistory(
  manager: SessionManager,
  controller: AgentController | null,
  meta: SessionMeta | null,
): SessionHistoryState {
  const [state, setState] = useState<HistoryLoadState>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);

  /** 已经灌过历史的会话（避免每次切回来都拉）。 */
  const loadedRef = useRef<Set<string>>(new Set());
  /** 正在拉的会话（避免快速切换时重复请求）。 */
  const inFlightRef = useRef<Set<string>>(new Set());

  const threadId = meta?.kind === 'ready' ? meta.id : null;

  useEffect(() => {
    if (!controller || threadId === null) {
      setState('idle');
      setError('');
      setNotice('');
      return;
    }

    // 草稿不拉；已有消息（刚聊过/已灌过）也不拉
    if (controller.snapshot.length > 0 || loadedRef.current.has(threadId)) {
      setState('idle');
      // 清掉上一个会话留下的提示/错误，避免串到这条会话上
      setError('');
      setNotice('');
      return;
    }

    if (inFlightRef.current.has(threadId)) return;

    const abort = new AbortController();
    inFlightRef.current.add(threadId);
    setState('loading');
    setError('');
    setNotice('');

    fetchHistory({ url: HISTORY_URL, threadId, signal: abort.signal })
      .then(response => {
        // 用户可能已经在这个会话里先发了一条：现场数据优先，丢弃历史
        if (controller.snapshot.length > 0) {
          loadedRef.current.add(threadId);
          setState('idle');
          return;
        }

        controller.setThreadId(threadId);
        controller.loadSnapshot(response.messages);
        loadedRef.current.add(threadId);

        if (response.display_state !== 'ready') {
          setNotice('该会话上一次生成没有结束');
        }
        setState('idle');
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;

        const message = cause instanceof Error ? cause.message : String(cause);

        // 会话已不在服务端：从列表移除，管理器会自动切到相邻项
        if (message.includes('HTTP 404')) {
          setState('idle');
          manager.remove(threadId);
          return;
        }

        setError(message);
        setState('error');
      })
      .finally(() => {
        inFlightRef.current.delete(threadId);
      });

    return () => abort.abort();
  }, [controller, threadId, manager, attempt]);

  return { state, error, notice, retry: () => setAttempt(value => value + 1) };
}

interface ActiveStream {
  messages: UIMessage[];
  status: AgentStatus;
  threadId: string;
}

/**
 * 只订阅「当前活动会话」的三件流。
 *
 * 依赖 controller 实例而不是 activeId：草稿提升时 id 变了但实例没变，
 * 这样不会白退订/重订一次（否则切换瞬间会闪一下空列表）。
 */
function useActiveStream(controller: AgentController | null): ActiveStream {
  const [messages, setMessages] = useState<UIMessage[]>(controller?.snapshot ?? []);
  const [status, setStatus] = useState<AgentStatus>(controller?.status ?? AgentStatus.Ready);
  const [threadId, setThreadId] = useState(controller?.threadId$.value ?? '');

  useEffect(() => {
    if (!controller) {
      setMessages([]);
      setStatus(AgentStatus.Ready);
      setThreadId('');
      return;
    }

    // 先同步一次初值：BehaviorSubject 虽会立刻发，但切会话时能少一帧空白
    setMessages(controller.snapshot);
    setStatus(controller.status);
    setThreadId(controller.threadId$.value);

    const subscriptions = [
      controller.messages$.subscribe(setMessages),
      controller.status$.subscribe(setStatus),
      controller.threadId$.subscribe(setThreadId),
    ];

    return () => subscriptions.forEach(subscription => subscription.unsubscribe());
  }, [controller]);

  return { messages, status, threadId };
}

/**
 * 列表里的「生成中」状态。
 *
 * 只订阅**已经存在**的 controller：没打开过的会话没必要为了一个转圈图标去造实例。
 * 会话被删后对应条目留在 map 里也无害（不会再被读到）。
 */
function useSessionStatuses(
  manager: SessionManager,
  sessions: SessionMeta[],
): Record<string, AgentStatus> {
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});

  useEffect(() => {
    const subscriptions: Subscription[] = [];

    for (const meta of sessions) {
      if (!manager.hasController(meta.id)) continue;

      subscriptions.push(
        manager.controllerOf(meta.id).status$.subscribe(status => {
          setStatuses(previous =>
            previous[meta.id] === status ? previous : { ...previous, [meta.id]: status },
          );
        }),
      );
    }

    return () => subscriptions.forEach(subscription => subscription.unsubscribe());
  }, [manager, sessions]);

  return statuses;
}

// ============================================================
// 消息区（Day 2：纯文本渲染；Markdown 与工具卡在 Day 3/4 补）
// ============================================================

interface MessageListProps {
  messages: UIMessage[];
  /** 重新生成某一条 assistant 回答（6-2）；不传则不出现按钮 */
  onRetryMessage?: (messageId: string) => void;
}

/** 离底部多少像素以内算"贴底"。太小会被轻微抖动踢出，太大看起来像没贴住。 */
const STICK_THRESHOLD_PX = 40;

const MessageList: React.FC<MessageListProps> = ({ messages, onRetryMessage }) => {
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 是否贴底：用 ref 存真相，避免"state 更新 → effect 重跑 → 又贴底"的循环。 */
  const pinRef = useRef(true);
  /** 自己触发的 programmatic 滚动，不能当成"用户滚到底"。 */
  const programmaticRef = useRef(false);
  /** 只用于控制"回到底部"按钮的显隐。 */
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;

    programmaticRef.current = true;
    el.scrollTop = el.scrollHeight;
    // 下一帧再放开标记：scroll 事件是异步派发的，同步清除会漏掉这一次
    requestAnimationFrame(() => {
      programmaticRef.current = false;
    });
  }, []);

  // 注意依赖是 messages 本身而不是 messages.length：
  // 流式期间条数不变、内容在长，只依赖长度不会触发跟随。
  useEffect(() => {
    if (pinRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleScroll = useCallback(() => {
    // 关键：忽略自己造成的滚动，否则"自动贴底"和"用户上滑"会互相打架 → 抖动
    if (programmaticRef.current) return;

    const el = listRef.current;
    if (!el) return;

    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
    pinRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  /** 用户主动往上滚的瞬间就取消贴底，不等 scroll 事件（少一帧的"抢滚动"）。 */
  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) pinRef.current = false;
  }, []);

  const backToBottom = useCallback(() => {
    pinRef.current = true;
    setShowJump(false);
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    <div style={styles.messageAreaWrap}>
      <div ref={listRef} style={styles.messageArea} onScroll={handleScroll} onWheel={handleWheel}>
        {messages.map(message => (
          <MessageBubble
            key={message.id}
            message={message}
            onRetry={message.role === 'assistant' ? () => onRetryMessage?.(message.id) : undefined}
          />
        ))}
      </div>

      {showJump && messages.length > 0 && (
        <button type="button" style={styles.backToBottom} onClick={backToBottom}>
          ↓ 回到底部
        </button>
      )}
    </div>
  );
};

/** 推荐问题：先写死，Day 5 换成服务端 quick-entries。 */
const SUGGESTIONS = ['帮我总结一下这段内容的要点', '把这段文字改成更正式的表述', '北京今天天气怎么样？'];

interface EmptyTipProps {
  /** 生成中禁用：避免连点发出两条。 */
  disabled: boolean;
  onPick: (text: string) => void;
}

const EmptyTip: React.FC<EmptyTipProps> = ({ disabled, onPick }) => (
  <div style={styles.placeholder}>
    <p style={styles.placeholderTitle}>开始对话</p>
    <div style={styles.suggestionList}>
      {SUGGESTIONS.map(text => (
        <button
          key={text}
          type="button"
          style={disabled ? styles.suggestionDisabled : styles.suggestion}
          disabled={disabled}
          onClick={() => onPick(text)}
        >
          {text}
        </button>
      ))}
    </div>
  </div>
);

/**
 * 复制到剪贴板。
 *
 * `navigator.clipboard` 只在 https / localhost 可用；私有化部署常见 http，
 * 所以失败时降级到 textarea + execCommand（已废弃但兼容性最好）。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @tencent/tdoc-standalone/no-restricted-web-apis -- 已提供 http 降级，见下方 fallback
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();

    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);

    return ok;
  }
}

type CopyState = 'idle' | 'copied' | 'failed';

const COPY_LABEL: Record<CopyState, string> = {
  idle: '复制',
  copied: '已复制',
  failed: '复制失败',
};

const MessageBubble: React.FC<{ message: UIMessage; onRetry?: () => void }> = ({ message, onRetry }) => {
  const isUser = message.role === 'user';
  /** 可复制的纯文本：只取 text part，工具卡与错误不参与。 */
  const copyable = getTextContent(message);
  const [copyState, setCopyState] = useState<CopyState>('idle');

  // 提示文案 1.5 秒后自动回位；用 effect 管理定时器，卸载时自动清掉
  useEffect(() => {
    if (copyState === 'idle') return;

    const timer = setTimeout(() => setCopyState('idle'), 1500);

    return () => clearTimeout(timer);
  }, [copyState]);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(copyable);
    setCopyState(ok ? 'copied' : 'failed');
  }, [copyable]);

  return (
    <div style={isUser ? styles.rowUser : styles.rowAssistant}>
      <div style={isUser ? styles.bubbleUser : styles.bubbleAssistant}>
        {message.parts.length === 0 ? (
          <div style={styles.pendingText}>正在思考…</div>
        ) : (
          message.parts.map((part, index) => (
            <React.Fragment key={`${message.id}-${index}`}>{renderPart(part, { onRetry })}</React.Fragment>
          ))
        )}

        {!isUser && copyable !== '' && (
          <div style={styles.messageActions}>
            <button
              type="button"
              style={styles.actionButton}
              onClick={() => {
                void handleCopy();
              }}
            >
              {COPY_LABEL[copyState]}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================
// 输入区
// ============================================================

interface ComposerProps {
  draft: string;
  /** 已附加的图片（粘贴得到的 data URL）。 */
  images: ImageInput[];
  /** 是否正在生成。生成中禁止再次发送，只允许中止。 */
  streaming: boolean;
  /** 历史还在加载：不能发消息（否则会把空历史发给后端）。 */
  disabled?: boolean;
  onDraftChange: (next: string) => void;
  onAddImage: (image: ImageInput) => void;
  onRemoveImage: (index: number) => void;
  onSend: () => void;
  onAbort: () => void;
}

/**
 * 粘贴图片的大小上限。
 *
 * data URL 是 base64，内存占用约为原图的 1.37 倍；再来一张 2MB 截图，
 * 单次请求体就会到 MB 级。demo 阶段设个硬上限，超了明确提示，不静默失败。
 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** 把剪贴板里的 File 读成 data URL：粘贴拿不到公网地址，只能内联。 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 剪贴板里的图片没有文件名，按 mime 造一个可读的。 */
function pastedFilename(type: string): string {
  const subtype = type.split('/')[1] ?? 'png';
  const ext = subtype === 'jpeg' ? 'jpg' : subtype;
  return `pasted-${Date.now()}.${ext}`;
}

const Composer: React.FC<ComposerProps> = ({
  draft,
  images,
  streaming,
  disabled = false,
  onDraftChange,
  onAddImage,
  onRemoveImage,
  onSend,
  onAbort,
}) => {
  /** 粘贴失败提示（太大 / 读取失败）：用局部 state，不污染草稿。 */
  const [pasteError, setPasteError] = useState('');

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return;

      // 中文输入法组合态下按 Enter 是「上屏」而不是「发送」，必须放过。
      if (event.nativeEvent.isComposing) return;

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        onSend();
      }
    },
    [disabled, onSend],
  );

  /**
   * 粘贴图片。
   *
   * 关键边界：**只有剪贴板里真的有图片才拦截**——否则会吃掉正常的文字粘贴。
   * （`preventDefault` 一旦无条件调用，用户粘一段文字就什么都没发生，很难查。）
   */
  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.items)
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile())
        .filter((file): file is File => file !== null);

      if (files.length === 0) return;

      event.preventDefault();
      setPasteError('');

      void (async () => {
        // 串行读，保证多张图按粘贴顺序进 chip
        for (const file of files) {
          if (file.size > MAX_IMAGE_BYTES) {
            setPasteError(`图片太大（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 2MB`);
            continue;
          }

          try {
            const url = await readAsDataUrl(file);
            onAddImage({ url, filename: pastedFilename(file.type), mimeType: file.type });
          } catch {
            setPasteError('图片读取失败，换一张试试');
          }
        }
      })();
    },
    [onAddImage],
  );

  return (
    <div style={styles.composer}>
      {images.length > 0 && (
        <div style={styles.chips}>
          {images.map((image, index) => (
            <div key={`${image.filename}-${index}`} style={styles.chip}>
              <img src={image.url} alt={image.filename} style={styles.chipThumb} />
              <span style={styles.chipName} title={image.filename}>
                {image.filename}
              </span>
              <button
                type="button"
                style={styles.chipRemove}
                aria-label={`移除 ${image.filename}`}
                onClick={() => onRemoveImage(index)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        style={styles.textarea}
        value={draft}
        placeholder="输入内容，Enter 发送 / Shift+Enter 换行 · 可直接粘贴截图"
        disabled={disabled}
        onChange={event => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />

      {pasteError !== '' && <div style={styles.pasteError}>{pasteError}</div>}

      <div style={styles.composerBar}>
        <div style={styles.actions}>
          <button
            type="button"
            // style={streaming ? styles.buttonGhost : styles.buttonDisabled}
            // disabled={!streaming}
            onClick={onAbort}
          >
            中止
          </button>
          <button
            type="button"
            style={streaming || disabled ? styles.buttonDisabled : styles.button}
            disabled={streaming || disabled}
            onClick={onSend}
          >
            {streaming ? '生成中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 日志面板（Day 1 的验收窗口）
// ============================================================

interface LogPanelProps {
  logs: LogEntry[];
  onClear: () => void;
}

/**
 * 错误剧本切换器（Day 6 复现用）。
 *
 * 剧本是在"建立连接时"读取的，所以切换必须重新加载页面——热切不会影响已经在跑的流。
 * 选项与 mock 的 `?scenario=` 一一对应，见 demo/mock-agent-server.ts 的 resolveScenario。
 */
const SCENARIO_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '正常' },
  { value: 'tool', label: '工具调用' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'error-run:439906', label: '错误·限流 439906' },
  { value: 'error-run:439902', label: '错误·未登录 439902' },
  { value: 'error-run:439903', label: '错误·无权限 439903' },
  { value: 'error-run:439907', label: '错误·积分不足 439907' },
  { value: 'http-429', label: '错误·HTTP 429' },
  { value: 'http-500', label: '错误·HTTP 500' },
  { value: 'http-401', label: '错误·HTTP 401' },
  { value: 'flaky', label: '自动重试·首次 500' },
  { value: 'cut:4', label: '错误·流中断' },
  { value: 'reset', label: '错误·连接重置' },
];

const ScenarioPicker: React.FC = () => {
  const current = new URLSearchParams(window.location.search).get('scenario') ?? '';

  return (
    <select
      aria-label="错误剧本"
      value={current}
      style={styles.scenarioPicker}
      onChange={event => {
        const next = new URL(window.location.href);
        if (event.target.value) next.searchParams.set('scenario', event.target.value);
        else next.searchParams.delete('scenario');
        window.location.href = next.toString();
      }}
    >
      {SCENARIO_OPTIONS.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
};

const LogPanel: React.FC<LogPanelProps> = ({ logs, onClear }) => {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [logs]);

  return (
    <div style={styles.logPanel}>
      <div style={styles.logHeader}>
        <span>
          事件日志（
          {logs.length}
          ）
        </span>
        <ScenarioPicker />
        <button type="button" style={styles.buttonTiny} onClick={onClear}>
          清空
        </button>
      </div>
      <div style={styles.logList} ref={listRef}>
        {logs.length === 0 ? (
          <div style={styles.logEmpty}>尚无事件</div>
        ) : (
          logs.map(entry => (
            <div key={entry.id} style={{ ...styles.logRow, color: toneColor(entry.tone) }}>
              <span style={styles.logTime}>{entry.time}</span>
              <span style={styles.logText}>{entry.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

// ============================================================
// Hooks
// ============================================================

interface LogsApi {
  logs: LogEntry[];
  appendLog: (text: string, tone?: LogEntry['tone']) => void;
  clearLogs: () => void;
}

/** 极简日志状态；后续可换成 src/core/store.ts 的实现，便于和业务共用同一套订阅机制。 */
function useLogs(): LogsApi {
  const sequence = useRef(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const appendLog = useCallback((text: string, tone: LogEntry['tone'] = 'info') => {
    sequence.current += 1;
    const entry: LogEntry = {
      id: sequence.current,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      text,
      tone,
    };
    setLogs(prev => [...prev, entry]);
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  return { logs, appendLog, clearLogs };
}

// ============================================================
// 样式
// ============================================================

const toneColor = (tone: LogEntry['tone']): string => {
  if (tone === 'error') return '#d93026';
  if (tone === 'success') return '#1a7f37';
  return '#3c4043';
};

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: '#f5f6f7',
    color: '#1f2328',
    fontSize: 13,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    background: '#fff',
    borderBottom: '1px solid #e3e5e8',
  },
  title: { fontWeight: 600, fontSize: 14 },
  meta: { display: 'flex', gap: 16, color: '#6b7280', fontSize: 12 },
  main: { flex: 1, display: 'flex', minHeight: 0 },
  sessionColumn: {
    width: 220,
    flexShrink: 0,
    borderRight: '1px solid #e3e5e8',
    background: '#fbfbfc',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  chatColumn: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  centerTip: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
    color: '#6b7280',
    fontSize: 13,
    textAlign: 'center',
  },
  notice: {
    margin: '8px 12px 0',
    padding: '6px 10px',
    background: '#fff8e1',
    color: '#8a6d3b',
    fontSize: 12,
    borderRadius: 4,
  },
  logColumn: {
    width: 420,
    borderLeft: '1px solid #e3e5e8',
    background: '#fff',
    display: 'flex',
    minHeight: 0,
  },
  messageAreaWrap: { position: 'relative', flex: 1, display: 'flex', minHeight: 0 },
  messageArea: { flex: 1, overflowY: 'auto', padding: 16, minHeight: 0 },
  backToBottom: {
    position: 'absolute',
    right: 20,
    bottom: 16,
    padding: '6px 12px',
    border: '1px solid #d0d4d9',
    borderRadius: 16,
    background: '#fff',
    color: '#3c4043',
    fontSize: 12,
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  placeholder: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    border: '1px dashed #d0d4d9',
    borderRadius: 8,
    color: '#8b949e',
  },
  placeholderTitle: { margin: 0, fontWeight: 600, color: '#6b7280' },
  placeholderHint: { margin: 0, fontSize: 12 },
  rowUser: { display: 'flex', justifyContent: 'flex-end', marginBottom: 12 },
  rowAssistant: { display: 'flex', justifyContent: 'flex-start', marginBottom: 12 },
  bubbleUser: {
    maxWidth: '78%',
    padding: '8px 12px',
    background: '#e8f0fe',
    borderRadius: '10px 10px 2px 10px',
    color: '#1f2328',
  },
  bubbleAssistant: {
    maxWidth: '78%',
    padding: '8px 12px',
    background: '#fff',
    border: '1px solid #e3e5e8',
    borderRadius: '10px 10px 10px 2px',
    color: '#1f2328',
  },
  partText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.7 },
  partError: { color: '#d93026', marginTop: 4 },
  pendingText: { color: '#9aa0a6' },
  suggestionList: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4, width: '100%', maxWidth: 420 },
  suggestion: {
    padding: '9px 14px',
    border: '1px solid #DCE3EC',
    borderRadius: 8,
    background: '#fff',
    color: '#1F2328',
    fontSize: 13,
    textAlign: 'left',
    cursor: 'pointer',
  },
  suggestionDisabled: {
    padding: '9px 14px',
    border: '1px solid #EDF0F4',
    borderRadius: 8,
    background: '#FAFAFB',
    color: '#B0B6BE',
    fontSize: 13,
    textAlign: 'left',
    cursor: 'not-allowed',
  },
  composer: {
    borderTop: '1px solid #e3e5e8',
    background: '#fff',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  textarea: {
    width: '100%',
    minHeight: 68,
    resize: 'vertical',
    padding: 8,
    border: '1px solid #d0d4d9',
    borderRadius: 6,
    font: 'inherit',
    outline: 'none',
  },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  chip: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 6px',
    border: '1px solid #e3e5e8',
    borderRadius: 6,
    background: '#fafbfc',
    maxWidth: 260,
  },
  chipThumb: { width: 40, height: 40, objectFit: 'cover', borderRadius: 4, display: 'block' },
  chipName: {
    fontSize: 12,
    color: '#4b5563',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chipRemove: {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    color: '#8a8f99',
    fontSize: 14,
    lineHeight: 1,
    padding: 0,
  },
  pasteError: { fontSize: 12, color: '#d93026' },
  composerBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  field: { display: 'flex', alignItems: 'center', gap: 6 },
  fieldLabel: { color: '#6b7280', fontSize: 12 },
  input: {
    width: 220,
    padding: '4px 8px',
    border: '1px solid #d0d4d9',
    borderRadius: 4,
    font: 'inherit',
  },
  actions: { display: 'flex', gap: 8 },
  button: {
    padding: '6px 16px',
    border: '1px solid #1a73e8',
    background: '#1a73e8',
    color: '#fff',
    borderRadius: 6,
    cursor: 'pointer',
    font: 'inherit',
  },
  buttonGhost: {
    padding: '6px 16px',
    border: '1px solid #d0d4d9',
    background: '#fff',
    color: '#3c4043',
    borderRadius: 6,
    cursor: 'pointer',
    font: 'inherit',
  },
  buttonDisabled: {
    padding: '6px 16px',
    border: '1px solid #e3e5e8',
    background: '#f1f3f4',
    color: '#9aa0a6',
    borderRadius: 6,
    cursor: 'not-allowed',
    font: 'inherit',
  },
  scenarioPicker: {
    marginLeft: 'auto',
    marginRight: 8,
    fontSize: 12,
    maxWidth: 170,
    padding: '2px 4px',
    border: '1px solid #d0d4d9',
    borderRadius: 4,
    background: '#fff',
    color: '#3c4043',
  },
  buttonTiny: {
    padding: '2px 8px',
    border: '1px solid #d0d4d9',
    background: '#fff',
    color: '#3c4043',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
  logPanel: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  logHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderBottom: '1px solid #e3e5e8',
    color: '#6b7280',
    fontSize: 12,
  },
  logList: {
    flex: 1,
    overflowY: 'auto',
    padding: 8,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
  },
  logEmpty: { color: '#9aa0a6', padding: 8 },
  logRow: { display: 'flex', gap: 8, padding: '2px 4px', lineHeight: 1.6 },
  logTime: { color: '#9aa0a6', flexShrink: 0 },
  logText: { wordBreak: 'break-word' },
};

// ============================================================
// 挂载（React 17：使用 ReactDOM.render）
// ============================================================

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

ReactDOM.render(<App />, container);

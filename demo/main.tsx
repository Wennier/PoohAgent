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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';

import 'highlight.js/styles/github.css';

import { AgentController, AgentStatus, type ImageInput } from 'src/agent/agent-controller';
import { getTextContent, type UIMessage } from 'src/message/type';
import { renderPart } from 'src/render/part-renderer';
import { connectAgentStream } from 'src/transport/agent-gateway';
import type { AgentEvent, WireMessage } from 'src/transport/types';

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

const App: React.FC = () => {
  const { logs, appendLog, clearLogs } = useLogs();
  const [draft, setDraft] = useState('');
  /** 本轮要随消息发出去的图片：粘贴得到的 data URL。 */
  const [draftImages, setDraftImages] = useState<ImageInput[]>([]);
  const { messages, status, threadId, submit, abort, loadSnapshot } = useAgent(appendLog);

  const isStreaming = status === AgentStatus.Generating;

  const handleSend = useCallback(() => {
    // 只有真的发出去（状态门禁通过）才清空草稿与附件，
    // 否则「生成中被拒」会把用户刚粘的图弄丢。
    if (submit(draft, draftImages)) {
      setDraft('');
      setDraftImages([]);
    }
  }, [draft, draftImages, submit]);

  const handleDraftChange = useCallback((next: string) => setDraft(next), []);

  const handleAddImage = useCallback((image: ImageInput) => {
    setDraftImages(previous => [...previous, image]);
  }, []);

  const handleRemoveImage = useCallback((index: number) => {
    setDraftImages(previous => previous.filter((_, i) => i !== index));
  }, []);

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
          <button type="button" style={styles.buttonTiny} onClick={loadSnapshot}>
            载入历史快照（模拟）
          </button>
        </div>
      </header>

      <main style={styles.main}>
        <section style={styles.chatColumn}>
          {messages.length === 0 ? (
            <EmptyTip disabled={isStreaming} onPick={submit} />
          ) : (
            <MessageList messages={messages} />
          )}
          <Composer
            draft={draft}
            images={draftImages}
            streaming={isStreaming}
            onDraftChange={handleDraftChange}
            onAddImage={handleAddImage}
            onRemoveImage={handleRemoveImage}
            onSend={handleSend}
            onAbort={abort}
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

interface AgentApi {
  messages: UIMessage[];
  status: AgentStatus;
  threadId: string;
  /** 返回是否真的发起（空内容 / 生成中会拒绝）。 */
  submit: (text: string, images?: ImageInput[]) => boolean;
  abort: () => void;
  /** 载入一份历史快照（走 aggregateSnapshot），用来复现"历史会话"的渲染结果。 */
  loadSnapshot: () => void;
}

/**
 * 模拟 /history 的返回：工具调用把一次回答切成了三条扁平消息。
 * 用它来复现「快照路径」的折叠结果，与直播路径对比。
 */
const SNAPSHOT_FIXTURE: WireMessage[] = [
  { id: 'w1', role: 'user', content: '北京天气' },
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

/**
 * 组件层只做三件事：造实例、订阅、转发命令。
 *
 * 注意这里**没有任何业务逻辑**——状态机、历史组装、中止收尾都在 AgentController 里。
 * 这样 Day 5 要做"切换会话时保留在途请求"时，只需要换实例，不用动视图。
 */
function useAgent(appendLog: (text: string, tone?: LogEntry['tone']) => void): AgentApi {
  const [controller] = useState(
    () =>
      new AgentController({
        // 剧本从页面 URL 读（?scenario=tool），这样不用改代码就能切 mock 场景
        connect: input => connectAgentStream({ ...input, url: resolveAgentUrl() }),
        // 事件观察口：让右侧日志继续当"直播验收窗口"用。
        onEvent: (event) => {
          const line = formatEvent(event);
          appendLog(line.text, line.tone);
        },
      }),
  );

  const [messages, setMessages] = useState<UIMessage[]>(() => controller.snapshot);
  const [status, setStatus] = useState<AgentStatus>(() => controller.status);
  const [threadId, setThreadId] = useState('');

  useEffect(() => {
    const subscriptions = [
      controller.messages$.subscribe(setMessages),
      controller.status$.subscribe(setStatus),
      controller.threadId$.subscribe(setThreadId),
    ];

    return () => {
      subscriptions.forEach(subscription => subscription.unsubscribe());
      controller.dispose();
    };
  }, [controller]);

  const submit = useCallback((text: string, images?: ImageInput[]) => controller.submit(text, images), [controller]);
  const abort = useCallback(() => controller.abort(), [controller]);
  const loadSnapshot = useCallback(() => controller.loadSnapshot(SNAPSHOT_FIXTURE), [controller]);

  return { messages, status, threadId, submit, abort, loadSnapshot };
}

// ============================================================
// 消息区（Day 2：纯文本渲染；Markdown 与工具卡在 Day 3/4 补）
// ============================================================

interface MessageListProps {
  messages: UIMessage[];
}

/** 离底部多少像素以内算"贴底"。太小会被轻微抖动踢出，太大看起来像没贴住。 */
const STICK_THRESHOLD_PX = 40;

const MessageList: React.FC<MessageListProps> = ({ messages }) => {
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
          <MessageBubble key={message.id} message={message} />
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

const MessageBubble: React.FC<{ message: UIMessage }> = ({ message }) => {
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
            <React.Fragment key={`${message.id}-${index}`}>{renderPart(part)}</React.Fragment>
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
      // 中文输入法组合态下按 Enter 是「上屏」而不是「发送」，必须放过。
      if (event.nativeEvent.isComposing) return;

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        onSend();
      }
    },
    [onSend],
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
            style={streaming ? styles.buttonDisabled : styles.button}
            disabled={streaming}
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
  chatColumn: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
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

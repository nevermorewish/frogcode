/**
 * OpenClaw Sessions Browser
 *
 * Two-pane view: session list (left) + message detail (right).
 * Reads from ~/.frogcode/openclaw/agents/{botId}/sessions/*.jsonl via
 * platform sidecar → Rust Tauri commands.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { MessageSquare, RefreshCw, User, Bot, Clock, AlertCircle, Inbox, CheckCircle2, XCircle, Loader2, Play, Square, RotateCcw, FileText, ChevronDown, ChevronUp, FolderOpen } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

interface OpenClawStatus {
  ok: boolean;
  active: boolean;
  agentType: string;
  processAlive?: boolean;
  wsConnected?: boolean;
  gatewayPort?: number;
  started?: boolean;
  binPath?: string | null;
  stateDir?: string;
  error?: string | null;
  logPath?: string | null;
  logTail?: string[];
}

interface SessionSummary {
  id: string;
  botId: string;
  sessionKey: string;
  title: string;
  channelType: string | null;
  channelId: string | null;
  status: string;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: unknown;
  createdAt: string | null;
  timestamp: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString();
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

/**
 * Normalize message content to plain text.
 * Handles: string | Array<{type, text} | {type: 'tool_use', ...}>
 */
function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      parts.push(`🔧 ${b.name}`);
    } else if (b.type === 'tool_result') {
      // Skip verbose tool results in list; keep in detail view
      parts.push('📋 tool_result');
    } else if (b.type === 'image') {
      parts.push('🖼️ [image]');
    }
  }
  return parts.join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

// ---------------------------------------------------------------------------
// Session list item
// ---------------------------------------------------------------------------

interface SessionItemProps {
  session: SessionSummary;
  selected: boolean;
  onClick: () => void;
}

const SessionItem: React.FC<SessionItemProps> = ({ session, selected, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border p-3 text-left transition-colors',
        selected
          ? 'border-primary/40 bg-primary/5'
          : 'border-border hover:bg-accent/50',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground">
            {truncate(session.title, 50)}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            {session.channelType && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                {session.channelType}
              </span>
            )}
            <span className="flex items-center gap-1">
              <MessageSquare className="h-3 w-3" />
              {session.messageCount}
            </span>
          </div>
        </div>
        <div className="flex-shrink-0 text-[10px] text-muted-foreground">
          {formatRelative(session.lastMessageAt)}
        </div>
      </div>
      <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground/70">
        {session.sessionKey}
      </div>
    </button>
  );
};

// ---------------------------------------------------------------------------
// Message bubble
// ---------------------------------------------------------------------------

const MessageBubble: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const isUser = message.role === 'user';
  const text = renderContent(message.content);

  return (
    <div className={cn('flex gap-3', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div
        className={cn(
          'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-4 py-2.5',
          isUser ? 'bg-primary/10 text-foreground' : 'bg-muted/60 text-foreground',
        )}
      >
        <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
          {text || <span className="italic text-muted-foreground">(empty)</span>}
        </div>
        {message.createdAt && (
          <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
            <Clock className="h-2.5 w-2.5" />
            {formatTimestamp(message.createdAt)}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export const OpenClawSessionsView: React.FC = () => {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<{ summary: SessionSummary; messages: ChatMessage[] } | null>(null);
  const [status, setStatus] = useState<OpenClawStatus | null>(null);
  const [controlBusy, setControlBusy] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const [historySessions, setHistorySessions] = useState<Array<{ id: string; botId: string; title: string; messageCount: number; lastMessageAt: string | null; createdAt: string; filePath: string }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedHistoryPath, setSelectedHistoryPath] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.platform.getOpenclawStatus();
      setStatus(s);
    } catch (e: any) {
      // The Rust sidecar_port() returns "platform sidecar not running" when
      // the bridge hasn't been spawned. Surface that directly instead of
      // masking it with a generic "unknown" agent type, which misled users
      // into thinking they had to touch Feishu settings.
      const msg = String(e?.message || e);
      setStatus({
        ok: false,
        active: false,
        agentType: 'unavailable',
        error: msg,
      });
    }
  }, []);

  const handleStart = useCallback(async () => {
    setControlBusy('start');
    try {
      await api.platform.openclawStart();
      await loadStatus();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setControlBusy(null);
    }
  }, [loadStatus]);

  const handleStop = useCallback(async () => {
    setControlBusy('stop');
    try {
      await api.platform.openclawStop();
      await loadStatus();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setControlBusy(null);
    }
  }, [loadStatus]);

  const handleRestart = useCallback(async () => {
    setControlBusy('restart');
    try {
      await api.platform.openclawRestart();
      await loadStatus();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setControlBusy(null);
    }
  }, [loadStatus]);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.platform.listOpenclawSessions();
      if (result.ok) {
        setSessions(result.sessions as SessionSummary[]);
      } else {
        setError('Failed to load sessions');
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  const importHistory = useCallback(async () => {
    setHistoryLoading(true);
    setError(null);
    try {
      const result = await api.openclawHistory.scanSessions();
      setHistorySessions(result);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
    loadStatus();
    // Auto-refresh status every 3s
    const interval = setInterval(loadStatus, 3000);
    return () => clearInterval(interval);
  }, [loadSessions, loadStatus]);

  // Auto-scroll log to bottom when it updates
  useEffect(() => {
    if (logOpen && logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [status?.logTail, logOpen]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }

    // If this is a history session, load from disk
    if (selectedHistoryPath) {
      let cancelled = false;
      setDetailLoading(true);
      api.openclawHistory
        .loadSession(selectedHistoryPath)
        .then((result) => {
          if (cancelled) return;
          setDetail({
            summary: result.summary as unknown as SessionSummary,
            messages: result.messages as ChatMessage[],
          });
        })
        .catch((e) => {
          if (!cancelled) setError(String(e?.message || e));
        })
        .finally(() => {
          if (!cancelled) setDetailLoading(false);
        });
      return () => { cancelled = true; };
    }

    // Otherwise load from sidecar
    let cancelled = false;
    setDetailLoading(true);
    api.platform
      .getOpenclawSession(selectedId)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setDetail({ summary: result.summary as SessionSummary, messages: result.messages as ChatMessage[] });
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message || e));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">OpenClaw Sessions</h1>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            OpenClaw 网关的对话历史记录，用户通过飞书发送消息时自动创建会话
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Start / Stop / Restart controls (only when agent is openclaw) */}
          {status?.active && (
            <>
              {status.processAlive ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStop}
                  disabled={controlBusy !== null}
                >
                  {controlBusy === 'stop' ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Square className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Stop
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStart}
                  disabled={controlBusy !== null}
                >
                  {controlBusy === 'start' ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Start
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleRestart}
                disabled={controlBusy !== null}
              >
                {controlBusy === 'restart' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                )}
                Restart
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={importHistory}
            disabled={historyLoading}
          >
            {historyLoading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
            )}
            导入历史
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={loadSessions}
            disabled={loading}
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Status banner */}
      {status && (() => {
        // Derived state: gateway is actually mid-startup (process alive but
        // WS not connected yet), vs merely idle (nothing spawned at all).
        // Previously any "active && !running && !error" state showed
        // "Starting gateway..." which was misleading on a fresh open where
        // the singleton exists but the user hasn't clicked Start yet.
        const running = status.active && status.wsConnected && status.processAlive;
        const starting = status.active && status.processAlive && !status.wsConnected;
        const hasError = status.active && !!status.error;
        const idle = status.active && !status.processAlive && !status.error;

        return (
        <div className={cn(
          'flex items-center gap-3 border-b px-6 py-2.5 text-[12px]',
          !status.active
            ? 'border-yellow-500/20 bg-yellow-500/5 text-yellow-700 dark:text-yellow-400'
            : running
              ? 'border-green-500/20 bg-green-500/5 text-green-700 dark:text-green-400'
              : hasError
                ? 'border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-400'
                : idle
                  ? 'border-muted-foreground/20 bg-muted/30 text-muted-foreground'
                  : 'border-blue-500/20 bg-blue-500/5 text-blue-700 dark:text-blue-400',
        )}>
          {!status.active ? (
            <>
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {status.error ? (
                <span className="flex-1">
                  <strong>Platform bridge unavailable:</strong> {status.error}
                </span>
              ) : (
                <span>
                  Agent type is <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{status.agentType}</code>, not OpenClaw.
                  Switch to OpenClaw in Feishu settings to enable.
                </span>
              )}
            </>
          ) : running ? (
            <>
              <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              <span>Gateway running on port <strong>{status.gatewayPort}</strong></span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                WebSocket connected
              </span>
              {status.stateDir && (
                <code className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {status.stateDir}
                </code>
              )}
            </>
          ) : hasError ? (
            <>
              <XCircle className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1">{status.error}</span>
              {status.binPath && (
                <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {status.binPath}
                </code>
              )}
            </>
          ) : idle ? (
            <>
              <AlertCircle className="h-4 w-4 flex-shrink-0 opacity-60" />
              <span>Gateway not running — click <strong>Start</strong> to launch it on port <strong>{status.gatewayPort}</strong></span>
            </>
          ) : starting ? (
            <>
              <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />
              <span>Starting gateway (process alive, connecting WebSocket...)</span>
            </>
          ) : (
            <>
              <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />
              <span>Starting gateway...</span>
            </>
          )}
        </div>
        );
      })()}

      {/* Log tail (collapsible) */}
      {status?.active && status.logTail && status.logTail.length > 0 && (
        <div className="border-b border-border">
          <button
            type="button"
            onClick={() => setLogOpen(!logOpen)}
            className="flex w-full items-center gap-2 px-6 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/30 transition-colors"
          >
            <FileText className="h-3 w-3" />
            Gateway Log ({status.logTail.length} lines)
            {status.logPath && (
              <code className="ml-1 text-[10px] opacity-60">{status.logPath}</code>
            )}
            {logOpen ? <ChevronUp className="ml-auto h-3 w-3" /> : <ChevronDown className="ml-auto h-3 w-3" />}
          </button>
          {logOpen && (
            <div
              ref={logScrollRef}
              className="max-h-48 overflow-y-auto bg-[#0a0e17] px-4 py-2 font-mono text-[10px] leading-relaxed text-[#8899aa]"
            >
              {status.logTail.map((line, i) => (
                <div key={i} className={cn(
                  line.includes('[err]') || line.includes('[error]')
                    ? 'text-red-400'
                    : line.includes('[warn]')
                      ? 'text-yellow-400'
                      : line.includes('[out]')
                        ? 'text-green-400/80'
                        : '',
                )}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Usage guide (shown when no sessions yet) */}
      {!loading && sessions.length === 0 && historySessions.length === 0 && (
        <div className="mx-6 mt-3 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3">
          <p className="mb-1.5 text-xs font-medium text-blue-700 dark:text-blue-400">
            使用说明
          </p>
          <ul className="space-y-1 text-[11px] leading-relaxed text-blue-700/80 dark:text-blue-400/80">
            <li>1. 此页面展示通过 OpenClaw 网关处理的所有飞书对话历史</li>
            <li>2. 确保 OpenClaw 网关已启动（上方状态栏显示绿色"Gateway running"），可通过 Start/Stop 按钮控制</li>
            <li>3. 在「IM 通道」页面将飞书机器人的后端设置为 OpenClaw，用户在飞书中发消息后会话将自动出现在左侧列表</li>
            <li>4. 点击左侧会话可查看完整对话内容，点击「导入历史」可加载磁盘上的离线会话记录</li>
          </ul>
        </div>
      )}

      {/* Body: two-pane */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: session list */}
        <div className="flex w-80 flex-col border-r border-border">
          {error && (
            <div className="m-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 flex-shrink-0 text-destructive" />
              <div className="text-[11px] text-destructive">{error}</div>
            </div>
          )}

          {loading && sessions.length === 0 && (
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
              Loading...
            </div>
          )}

          {!loading && sessions.length === 0 && historySessions.length === 0 && !error && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <Inbox className="h-10 w-10 text-muted-foreground/40" />
              <div className="text-[12px] text-muted-foreground">
                No sessions found.
              </div>
              <div className="text-[11px] text-muted-foreground/70">
                Sessions will appear here once OpenClaw processes messages from Feishu.
                You can also click "导入历史" to load sessions from disk.
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-3">
            <div className="space-y-2">
              {sessions.map((s) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  selected={selectedId === s.id && !selectedHistoryPath}
                  onClick={() => { setSelectedId(s.id); setSelectedHistoryPath(null); }}
                />
              ))}
              {historySessions.length > 0 && (
                <>
                  <div className="flex items-center gap-2 py-1.5">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-[10px] font-medium text-muted-foreground">历史 ({historySessions.length})</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                  {historySessions.map((hs) => (
                    <button
                      key={`history-${hs.id}`}
                      type="button"
                      onClick={() => { setSelectedId(hs.id); setSelectedHistoryPath(hs.filePath); }}
                      className={cn(
                        'w-full rounded-lg border p-3 text-left transition-colors',
                        selectedId === hs.id && selectedHistoryPath
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-border hover:bg-accent/50',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">历史</span>
                            <span className="truncate text-[13px] font-medium text-foreground">
                              {truncate(hs.title, 40)}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{hs.botId}</span>
                            <span className="flex items-center gap-1">
                              <MessageSquare className="h-3 w-3" />
                              {hs.messageCount}
                            </span>
                          </div>
                        </div>
                        <div className="flex-shrink-0 text-[10px] text-muted-foreground">
                          {formatRelative(hs.lastMessageAt)}
                        </div>
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            {sessions.length + historySessions.length} session{(sessions.length + historySessions.length) !== 1 ? 's' : ''}
            {historySessions.length > 0 && ` (${historySessions.length} 历史)`}
          </div>
        </div>

        {/* Right: detail pane */}
        <div className="flex flex-1 flex-col">
          {!selectedId && (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center">
                <MessageSquare className="mx-auto h-12 w-12 text-muted-foreground/30" />
                <div className="mt-3 text-[13px] text-muted-foreground">
                  Select a session to view messages
                </div>
              </div>
            </div>
          )}

          {selectedId && detailLoading && !detail && (
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
              Loading messages...
            </div>
          )}

          {selectedId && detail && (
            <>
              <div className="border-b border-border px-6 py-3">
                <div className="text-[14px] font-medium text-foreground">
                  {detail.summary.title}
                </div>
                <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
                  {detail.summary.channelType && (
                    <span className="rounded bg-muted px-1.5 py-0.5">
                      {detail.summary.channelType}
                    </span>
                  )}
                  <span>{detail.messages.length} messages</span>
                  <span>Created {formatRelative(detail.summary.createdAt)}</span>
                </div>
                <div className="mt-1 font-mono text-[10px] text-muted-foreground/60">
                  {detail.summary.sessionKey}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-6">
                <div className="mx-auto max-w-3xl space-y-5">
                  {detail.messages.length === 0 ? (
                    <div className="text-center text-[12px] text-muted-foreground">
                      No messages in this session.
                    </div>
                  ) : (
                    detail.messages.map((m, i) => (
                      <MessageBubble key={`${m.id}-${i}`} message={m} />
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

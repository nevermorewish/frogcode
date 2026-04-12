/**
 * LogsView — Multi-tab log viewer for platform sidecar + future log sources.
 *
 * Reads from:
 *   - Platform sidecar log: ~/.anycode/platform-sidecar.log (via platform_read_log)
 *   - Tauri app log: AppData/any-code/logs/ (via read_app_log)
 *
 * Features: auto-refresh, scroll-to-bottom, open in file explorer, search filter.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  RefreshCw,
  FolderOpen,
  Trash2,
  Search,
  ArrowDown,
  Pause,
  Play,
  ScrollText,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LogSource {
  id: string;
  label: string;
  fetchLines: () => Promise<{ path: string; exists: boolean; totalLines: number; lines: string[] }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Classify a log line for syntax colouring. */
function lineClass(line: string): string {
  // Errors (red) — sidecar, openclaw, rust, SDK
  if (/\berror\b/i.test(line)) return 'text-red-400';
  if (/\[err\]/i.test(line)) return 'text-red-400';

  // Warnings (yellow)
  if (/\bwarn\b/i.test(line)) return 'text-yellow-400';
  if (/DeprecationWarning/i.test(line)) return 'text-yellow-400/70';

  // Event flow (cyan/bright) — feishu message lifecycle
  if (/RECV |DISPATCH|DONE /i.test(line)) return 'text-cyan-300 font-medium';
  if (/\[event\]/i.test(line)) return 'text-cyan-400';

  // Drop/filter (orange)
  if (/DROP:/i.test(line)) return 'text-orange-400';

  // Rust lifecycle (blue)
  if (/\[rust /i.test(line)) return 'text-blue-400';

  // SDK noise (dim)
  if (/\[sdk /i.test(line)) return 'text-[#667788]';

  // OpenClaw WS client (purple)
  if (/\[openclaw-ws /i.test(line)) return 'text-purple-400';

  // OpenClaw process stdout/stderr (dim green / dim red)
  if (/\[openclaw-proc.*\[out\]/i.test(line) || /\[out\]/i.test(line)) return 'text-green-400/60';
  if (/\[openclaw-proc.*\[err\]/i.test(line)) return 'text-red-400/70';

  // Info (green)
  if (/\binfo\b/i.test(line)) return 'text-green-400/80';

  // Feishu connected / ready (bright green)
  if (/connected|READY|ready/i.test(line)) return 'text-green-400';

  return 'text-[#8899aa]';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const LogsView: React.FC = () => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('sidecar');
  const [lines, setLines] = useState<string[]>([]);
  const [totalLines, setTotalLines] = useState(0);
  const [logPath, setLogPath] = useState<string>('');
  const [logExists, setLogExists] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);

  // ─── Log sources ─────────────────────────────────────────────────────
  const sources: LogSource[] = [
    {
      id: 'sidecar',
      label: 'Platform Sidecar',
      fetchLines: async () => {
        const r = await api.platform.readLog(500);
        return {
          path: r.path ?? '',
          exists: r.exists ?? false,
          totalLines: r.totalLines ?? 0,
          lines: (r.lines ?? []) as string[],
        };
      },
    },
  ];

  // ─── Fetch ───────────────────────────────────────────────────────────
  const fetchLog = useCallback(async () => {
    const src = sources.find((s) => s.id === activeTab) ?? sources[0];
    setLoading(true);
    setError(null);
    try {
      const result = await src.fetchLines();
      setLogPath(result.path);
      setLogExists(result.exists);
      setTotalLines(result.totalLines);
      setLines(result.lines);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  // Initial + auto-refresh
  useEffect(() => {
    fetchLog();
    if (!autoRefresh) return;
    const interval = setInterval(fetchLog, 2000);
    return () => clearInterval(interval);
  }, [fetchLog, autoRefresh]);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  // Detect manual scroll-up → pause auto-scroll
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 60;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      autoScrollRef.current = true;
    }
  }, []);

  const handleOpenInExplorer = useCallback(async () => {
    if (!logPath) return;
    // Open the parent directory in the system file explorer.
    // @tauri-apps/plugin-shell `open` handles both URLs and local paths
    // on all platforms (Windows: explorer.exe, macOS: open, Linux: xdg-open).
    const dir = logPath.replace(/[/\\][^/\\]+$/, '');
    try {
      await shellOpen(dir);
    } catch (e) {
      console.error('open folder failed:', e);
    }
  }, [logPath]);

  const handleClear = useCallback(async () => {
    // Just clear the UI — the actual log file will be rotated next time
    // the sidecar starts (old → .prev.log, fresh file created).
    setLines([]);
    setTotalLines(0);
  }, []);

  // ─── Filtered lines ──────────────────────────────────────────────────
  const filtered = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <ScrollText className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              {t('logs.title', '系统日志')}
            </h1>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {t('logs.subtitle', '查看平台 sidecar、OpenClaw 网关等运行日志')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Auto-refresh toggle */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={cn(autoRefresh && 'border-primary/40 bg-primary/5')}
          >
            {autoRefresh ? (
              <Pause className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            {autoRefresh
              ? t('logs.autoRefreshOn', '自动刷新')
              : t('logs.autoRefreshOff', '已暂停')}
          </Button>

          <Button variant="outline" size="sm" onClick={fetchLog} disabled={loading}>
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
            {t('logs.refresh', '刷新')}
          </Button>

          {logPath && (
            <Button variant="outline" size="sm" onClick={handleOpenInExplorer}>
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
              {t('logs.openFolder', '打开目录')}
            </Button>
          )}

          <Button variant="outline" size="sm" onClick={handleClear} disabled={!logExists}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {t('logs.clear', '清除')}
          </Button>
        </div>
      </div>

      {/* Tab bar + filter */}
      <div className="flex items-center gap-3 border-b border-border px-6 py-2">
        {/* Tabs */}
        <div className="flex items-center gap-1">
          {sources.map((src) => (
            <button
              key={src.id}
              type="button"
              onClick={() => setActiveTab(src.id)}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                activeTab === src.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              {src.label}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-border" />

        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('logs.filter', '过滤日志...')}
            className="h-7 pl-8 text-[12px]"
          />
        </div>

        {/* Stats */}
        <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
          {logPath && (
            <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{logPath}</code>
          )}
          <span>
            {filter ? `${filtered.length} / ` : ''}
            {totalLines} {t('logs.lines', '行')}
          </span>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/5 px-6 py-2 text-[12px] text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Log content */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-[#0a0e17] px-4 py-3 font-mono text-[11px] leading-relaxed"
      >
        {!logExists && !loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
            <ScrollText className="h-10 w-10 opacity-30" />
            <div className="text-[12px]">
              {t('logs.noLog', '日志文件不存在。启动 sidecar 后会自动创建。')}
            </div>
            {logPath && (
              <code className="rounded bg-muted/50 px-2 py-1 text-[10px]">{logPath}</code>
            )}
          </div>
        )}

        {logExists && filtered.length === 0 && !loading && (
          <div className="py-10 text-center text-[12px] text-muted-foreground">
            {filter
              ? t('logs.noMatch', '没有匹配的日志行')
              : t('logs.empty', '日志文件为空')}
          </div>
        )}

        {filtered.map((line, i) => (
          <div key={i} className={cn('whitespace-pre-wrap break-all', lineClass(line))}>
            {line}
          </div>
        ))}
      </div>

      {/* Scroll-to-bottom FAB */}
      {logExists && filtered.length > 50 && (
        <div className="absolute bottom-6 right-8">
          <Button
            variant="secondary"
            size="sm"
            onClick={scrollToBottom}
            className="rounded-full shadow-lg"
          >
            <ArrowDown className="mr-1 h-3.5 w-3.5" />
            {t('logs.scrollToBottom', '跳到底部')}
          </Button>
        </div>
      )}
    </div>
  );
};

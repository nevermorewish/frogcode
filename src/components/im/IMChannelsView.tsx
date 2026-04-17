/**
 * IM Channels View — unified IM config management.
 * All channels stored in ~/.frogcode/im-channels.json.
 * Claude Code and OpenClaw can each have one channel assigned.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  Settings2,
  Plus,
  CheckCircle2,
  Loader2,
  Terminal,
  ChevronDown,
  CircleOff,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api, type IMChannelConfig } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { usePlatformStatus } from '@/hooks/usePlatformStatus';
import { FeishuSetupDialog } from './FeishuSetupDialog';
import { QQSetupDialog } from './QQSetupDialog';
import { WeChatSetupDialog } from './WeChatSetupDialog';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const FeishuIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 48 48" className={className} xmlns="http://www.w3.org/2000/svg">
    <path fill="#00D6B9" d="M32.5 12C38 12 42 16 42 21.5V36c0 .5-.6.8-1 .5-6.3-4.8-11.3-8-17-8-3.2 0-6 .7-9 2.2-.4.2-.8-.1-.8-.5V21.5C14.2 16 18.2 12 23.7 12h8.8z" />
    <path fill="#3370FF" d="M6 22.8c0-.5.6-.8 1-.5 4.8 3.6 9.3 7 14.5 9.7 4.8 2.4 9.5 3 14.7 2.5.5 0 .8.4.6.8-2.5 4.3-7.2 7.2-12.5 7.2-3 0-5.8-.9-8.2-2.4C10.2 37 6 31.4 6 24.8v-2z" />
  </svg>
);

const QQIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path fill="#12B7F5" d="M24 4C15.2 4 10 10.5 10 18.5c0 2.6.5 5 1.4 7-.9 1.4-2.4 4-2.4 5.5 0 1 .6 1.2 1.4.6l2.3-1.9c1 1 2.4 2 4 2.7-.5 1-1 2-1 3 0 2.4 1.8 3.6 5.5 3.6h5.6c3.7 0 5.5-1.2 5.5-3.6 0-1-.5-2-1-3 1.6-.7 3-1.7 4-2.7l2.3 1.9c.8.6 1.4.4 1.4-.6 0-1.5-1.5-4.1-2.4-5.5.9-2 1.4-4.4 1.4-7C38 10.5 32.8 4 24 4z" />
    <circle fill="white" cx="18" cy="18" r="3" />
    <circle fill="white" cx="30" cy="18" r="3" />
    <circle fill="#12B7F5" cx="18" cy="18" r="1.5" />
    <circle fill="#12B7F5" cx="30" cy="18" r="1.5" />
  </svg>
);

const WeChatIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path fill="#07C160" d="M18 8C10 8 4 14 4 22c0 4.3 2 8 5 10.7L8 37l4.8-2.2c1.7.5 3.4.8 5.2.8 1 0 2-.1 2.9-.3-.5-1.2-.8-2.5-.8-3.8 0-6.8 6.3-12 14-12 .7 0 1.4 0 2.1.2C35.6 14 27.6 8 18 8zm-5 10.5a2 2 0 110-4 2 2 0 010 4zm10 0a2 2 0 110-4 2 2 0 010 4z" />
    <path fill="#07C160" d="M44 32c0-5.5-5.4-10-12-10s-12 4.5-12 10 5.4 10 12 10c1.5 0 2.9-.2 4.2-.6L40 43l-.9-3.3c3-1.8 4.9-4.5 4.9-7.7zm-16-2a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm8 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" />
  </svg>
);

const OpenClawIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <defs>
      <linearGradient id="oc-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#ff4d4d" />
        <stop offset="100%" stopColor="#991b1b" />
      </linearGradient>
    </defs>
    <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#oc-grad)" />
    <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="url(#oc-grad)" />
    <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="url(#oc-grad)" />
    <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
    <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
    <circle cx="45" cy="35" r="6" fill="#050810" />
    <circle cx="75" cy="35" r="6" fill="#050810" />
    <circle cx="46" cy="34" r="2.5" fill="#00e5cc" />
    <circle cx="76" cy="34" r="2.5" fill="#00e5cc" />
  </svg>
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentAssignment = 'claudecode' | 'openclaw' | 'none';

const AGENT_OPTIONS: { value: AgentAssignment; label: string; icon: React.ReactNode }[] = [
  { value: 'none', label: '未分配', icon: <CircleOff className="h-3.5 w-3.5 text-muted-foreground" /> },
  { value: 'claudecode', label: 'Claude Code', icon: <Terminal className="h-3.5 w-3.5" /> },
  { value: 'openclaw', label: 'OpenClaw', icon: <OpenClawIcon className="h-3.5 w-3.5" /> },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const IMChannelsView: React.FC = () => {
  const { t } = useTranslation();
  const bridge = usePlatformStatus();
  const { feishuAppId: serverFeishuAppId, dismissFeishuAppId } = useAuth();

  const [channels, setChannels] = useState<IMChannelConfig[]>([]);
  const [suppressedAppIds, setSuppressedAppIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [feishuDialogOpen, setFeishuDialogOpen] = useState(false);
  const [qqDialogOpen, setQQDialogOpen] = useState(false);
  const [wechatDialogOpen, setWeChatDialogOpen] = useState(false);
  const [agentDropdownId, setAgentDropdownId] = useState<string | null>(null);

  const feishuConnected = bridge.status === 'running' && bridge.feishuStatus === 'running';

  const loadChannels = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getImChannels();
      const list = [...data.channels];
      const suppressed = data.suppressedAppIds;

      // Merge server feishu appId if not already present AND not dismissed.
      // Without the suppression check, the deleted channel would reappear
      // on every reload because the server keeps advertising it.
      if (
        serverFeishuAppId &&
        !list.some(ch => ch.appId === serverFeishuAppId) &&
        !suppressed.includes(serverFeishuAppId)
      ) {
        list.push({
          id: `server-${serverFeishuAppId}`,
          platform: 'feishu',
          appId: serverFeishuAppId,
          appSecret: '',
          label: '',
          assignment: 'none',
        });
        // Auto-save the merged entry (preserve suppressedAppIds!)
        await api.saveImChannels({ channels: list, suppressedAppIds: suppressed });
      }

      setChannels(list);
      setSuppressedAppIds(suppressed);
    } catch {
      setChannels([]);
      setSuppressedAppIds([]);
    } finally {
      setLoading(false);
    }
  }, [serverFeishuAppId]);

  useEffect(() => { loadChannels(); }, [loadChannels]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!agentDropdownId) return;
    const handler = () => setAgentDropdownId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [agentDropdownId]);

  const saveAndApply = async (
    updated: IMChannelConfig[],
    nextSuppressed: string[] = suppressedAppIds,
  ) => {
    // Save to im-channels.json — the sidecar reads this directly.
    // Always include suppressedAppIds so the normalizer doesn't drop them.
    await api.saveImChannels({ channels: updated, suppressedAppIds: nextSuppressed });
    setChannels(updated);
    setSuppressedAppIds(nextSuppressed);

    const hasAnyAssigned = updated.some(ch => ch.assignment !== 'none');

    // Keep platform config in sync for projectPath/enabled
    const cfg = await api.platform.getConfig().catch(() => ({
      appId: '', appSecret: '', projectPath: '', enabled: false,
    })) as any;
    await api.platform.saveConfig({
      ...cfg,
      enabled: hasAnyAssigned,
    });

    // Tell sidecar to reconcile bots from im-channels.json
    const status = await api.platform.status().catch(() => ({ status: 'stopped' }));
    if (status.status === 'running') {
      try { await api.platform.reloadConfig(); } catch {}
    } else if (hasAnyAssigned) {
      // Start sidecar if not running and at least one bot is assigned
      await api.platform.start();
      try { await api.platform.connectFeishu(); } catch {}
    }
  };

  const handleAgentChange = async (channelId: string, newAssignment: AgentAssignment) => {
    setAgentDropdownId(null);
    const channel = channels.find(ch => ch.id === channelId);
    if (!channel || channel.assignment === newAssignment) return;

    setSwitching(channelId);
    try {
      // Each agent can only have one channel.
      // Unassign any other channel that has the same agent (unless 'none').
      const updated = channels.map(ch => {
        if (ch.id === channelId) {
          return { ...ch, assignment: newAssignment };
        }
        if (newAssignment !== 'none' && ch.assignment === newAssignment) {
          return { ...ch, assignment: 'none' as AgentAssignment };
        }
        return ch;
      });

      await saveAndApply(updated);
    } catch {
      // ignore
    } finally {
      setSwitching(null);
    }
  };

  const handleDelete = async (channelId: string) => {
    const channel = channels.find(ch => ch.id === channelId);
    if (!channel) return;
    const updated = channels.filter(ch => ch.id !== channelId);
    // Suppress so that loadChannels / syncFeishuToImChannels /
    // migrateFromAgentConfigs don't re-add this appId on the next tick.
    const nextSuppressed = Array.from(new Set([...suppressedAppIds, channel.appId]));
    try {
      await saveAndApply(updated, nextSuppressed);
      // If this was the server-provided feishu channel, also clear the
      // cached appId from AuthContext so the badge/UI doesn't keep
      // showing it as "available from server".
      if (channel.appId === serverFeishuAppId) {
        await dismissFeishuAppId(channel.appId);
      }
    } catch {
      // ignore
    }
  };

  const handleDialogConnected = async () => {
    // After FeishuSetupDialog saves, reload and migrate new creds into im-channels
    await migrateFromAgentConfigs();
    await loadChannels();
  };

  // One-time migration: pull feishu creds from agent configs into im-channels.json
  const migrateFromAgentConfigs = async () => {
    const data = await api.getImChannels().catch(() => ({
      channels: [] as IMChannelConfig[],
      suppressedAppIds: [] as string[],
    }));
    const list = [...data.channels];
    const suppressed = data.suppressedAppIds;
    const seen = new Set(list.map(ch => ch.appId));
    let changed = false;

    const platformCfg = await api.platform.getConfig().catch(() => ({ agentType: '' })) as any;
    const activeAgent = platformCfg.agentType || '';

    for (const agentType of ['claudecode', 'openclaw'] as const) {
      const cfg = await api.platform.getAgentConfig(agentType).catch(() => ({})) as any;
      const appId = cfg?.feishu?.appId;
      // Skip if already tracked OR user explicitly deleted it
      if (appId && !seen.has(appId) && !suppressed.includes(appId)) {
        list.push({
          id: `feishu-${appId}`,
          platform: 'feishu',
          appId,
          appSecret: cfg.feishu.appSecret || '',
          label: '',
          assignment: activeAgent === agentType ? agentType : 'none',
        });
        seen.add(appId);
        changed = true;
      }
    }

    if (changed) {
      await api.saveImChannels({ channels: list, suppressedAppIds: suppressed });
    }
  };

  // Migrate on first load
  useEffect(() => { migrateFromAgentConfigs(); }, []);

  const selectedOpt = (assignment: AgentAssignment) =>
    AGENT_OPTIONS.find(a => a.value === assignment) || AGENT_OPTIONS[0];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold">{t('sidebar.imChannels', 'IM 通道')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('imChannels.subtitle', '管理消息通道配置，选择 AI 后端')}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm">
              <Plus className="mr-1.5 h-4 w-4" />
              {t('imChannels.addChannel', '添加通道')}
              <ChevronDown className="ml-1 h-3 w-3 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={() => setFeishuDialogOpen(true)}>
              <FeishuIcon className="mr-2 h-4 w-4" />
              {t('home.imChannel.feishu', '飞书')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setQQDialogOpen(true)}>
              <QQIcon className="mr-2 h-4 w-4" />
              QQ
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setWeChatDialogOpen(true)}>
              <WeChatIcon className="mr-2 h-4 w-4" />
              {t('home.imChannel.wechat', '微信')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Usage guide */}
      <div className="mx-6 mt-4 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3">
        <p className="mb-1.5 text-xs font-medium text-blue-700 dark:text-blue-400">
          {t('imChannels.guideTitle', '使用说明')}
        </p>
        <ul className="space-y-1 text-[11px] leading-relaxed text-blue-700/80 dark:text-blue-400/80">
          <li>{t('imChannels.guide1', '1. 点击「添加通道」选择飞书或 QQ，填写机器人的 App ID 和 App Secret')}</li>
          <li>{t('imChannels.guide2', '2. 通过右侧下拉框为每个通道选择 AI 后端：Claude Code（使用官方 Claude Max 订阅）或 OpenClaw（通过 Frogclaw 服务器）')}</li>
          <li>{t('imChannels.guide3', '3. 每种后端同一时间只能绑定一个通道，切换时会自动解绑原通道')}</li>
          <li>{t('imChannels.guide4', '4. 分配后端后机器人将自动连接，在 IM 中发送消息即可开始 AI 对话')}</li>
        </ul>
      </div>

      {/* Channel List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          </div>
        ) : channels.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-3 rounded-full bg-muted p-4">
              <Settings2 className="h-8 w-8 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">{t('imChannels.noChannels', '暂无通道配置')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('imChannels.noChannelsHint', '点击"添加通道"配置飞书或 QQ 机器人')}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {channels.map((ch) => {
              const isAssigned = ch.assignment !== 'none';
              const isSwitching = switching === ch.id;
              const statusColor = isAssigned && feishuConnected
                ? 'bg-green-500'
                : isAssigned && bridge.feishuStatus === 'starting'
                  ? 'bg-amber-400'
                  : isAssigned && bridge.feishuStatus === 'error'
                    ? 'bg-red-500'
                    : 'bg-muted-foreground/40';
              const opt = selectedOpt(ch.assignment);

              return (
                <div
                  key={ch.id}
                  className={cn(
                    'flex items-center gap-4 rounded-lg border bg-background px-4 py-3 transition-colors hover:bg-muted/30',
                    isAssigned ? 'border-primary/30' : 'border-border',
                  )}
                >
                  {/* Icon */}
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-white">
                    {ch.platform === 'qq' ? (
                      <QQIcon className="h-5 w-5" />
                    ) : ch.platform === 'wechat' ? (
                      <WeChatIcon className="h-5 w-5" />
                    ) : (
                      <FeishuIcon className="h-5 w-5" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {ch.platform === 'qq'
                          ? 'QQ'
                          : ch.platform === 'wechat'
                            ? t('home.imChannel.wechat', '微信')
                            : t('home.imChannel.feishu', '飞书')}
                      </span>
                      <span className={cn('h-2 w-2 rounded-full', statusColor)} />
                      {isAssigned && feishuConnected && (
                        <span className="text-[10px] text-green-600">{t('imChannels.connected', '已连接')}</span>
                      )}
                      {!isAssigned && (
                        <span className="text-[10px] text-muted-foreground">{t('imChannels.unassigned', '未分配')}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <code className="text-[11px] text-muted-foreground font-mono">{ch.appId}</code>
                      {ch.label && (
                        <span className="text-[10px] text-muted-foreground">· {ch.label}</span>
                      )}
                    </div>
                  </div>

                  {/* Agent Selector */}
                  <div className="relative" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      disabled={switching !== null}
                      onClick={() => setAgentDropdownId(agentDropdownId === ch.id ? null : ch.id)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-50',
                        isAssigned
                          ? 'border-primary/40 bg-primary/5 hover:bg-primary/10'
                          : 'border-input bg-background hover:bg-accent/50',
                      )}
                    >
                      {isSwitching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : opt.icon}
                      {isSwitching ? '...' : opt.label}
                      <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', agentDropdownId === ch.id && 'rotate-180')} />
                    </button>
                    {agentDropdownId === ch.id && (
                      <div className="absolute right-0 z-50 mt-1 w-44 rounded-md border border-border bg-popover shadow-lg">
                        {AGENT_OPTIONS.map((aopt) => (
                          <button
                            key={aopt.value}
                            type="button"
                            onClick={() => handleAgentChange(ch.id, aopt.value)}
                            className={cn(
                              'flex w-full items-center gap-2 px-3 py-2 text-[11px] hover:bg-accent/50 first:rounded-t-md last:rounded-b-md transition-colors',
                              ch.assignment === aopt.value && 'bg-accent/30',
                            )}
                          >
                            {aopt.icon}
                            <span className="font-medium">{aopt.label}</span>
                            {ch.assignment === aopt.value && (
                              <CheckCircle2 className="ml-auto h-3 w-3 text-primary" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Delete */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(ch.id)}
                    className="flex-shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <FeishuSetupDialog
        open={feishuDialogOpen}
        onOpenChange={setFeishuDialogOpen}
        onConnected={handleDialogConnected}
      />
      <QQSetupDialog
        open={qqDialogOpen}
        onOpenChange={setQQDialogOpen}
        onConnected={handleDialogConnected}
      />
      <WeChatSetupDialog
        open={wechatDialogOpen}
        onOpenChange={setWeChatDialogOpen}
        onConnected={handleDialogConnected}
      />
    </div>
  );
};

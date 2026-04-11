/**
 * Feishu Setup Dialog — config credentials + CLI backend selector
 */
import React, { useEffect, useState } from 'react';
import { ExternalLink, Loader2, AlertCircle, ChevronDown, Terminal, Cpu } from 'lucide-react';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useTranslation } from 'react-i18next';

const FEISHU_CREDENTIALS_URL = 'https://open.feishu.cn/app';
const FEISHU_TUTORIAL_URL = 'https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process';

type AgentType = 'claudecode' | 'openclaw';

const AGENT_OPTIONS: { value: AgentType; label: string; icon: React.ReactNode; desc: string }[] = [
  {
    value: 'claudecode',
    label: 'Claude Code',
    icon: <Terminal className="h-3.5 w-3.5" />,
    desc: 'Anthropic Claude Code CLI',
  },
  {
    value: 'openclaw',
    label: 'OpenClaw',
    icon: <Cpu className="h-3.5 w-3.5" />,
    desc: 'OpenClaw Gateway (multi-channel)',
  },
];

const FeishuIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 8C4 5.79086 5.79086 4 8 4H24C26.2091 4 28 5.79086 28 8V24C28 26.2091 26.2091 28 24 28H8C5.79086 28 4 26.2091 4 24V8Z" fill="#00D6B9"/>
    <path d="M22 11C22 11 18.5 14 16 14C13.5 14 10 11 10 11V21C10 21 13.5 18 16 18C18.5 18 22 21 22 21V11Z" fill="white"/>
  </svg>
);

interface FeishuSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
}

type FeishuCreds = { appId: string; appSecret: string };

const EMPTY_CREDS: FeishuCreds = { appId: '', appSecret: '' };

export const FeishuSetupDialog: React.FC<FeishuSetupDialogProps> = ({
  open,
  onOpenChange,
  onConnected,
}) => {
  const { t } = useTranslation();
  // Per-agent credentials — each CLI backend has its own Feishu app.
  const [credsByAgent, setCredsByAgent] = useState<Record<AgentType, FeishuCreds>>({
    claudecode: { ...EMPTY_CREDS },
    openclaw: { ...EMPTY_CREDS },
  });
  const [projectPath, setProjectPath] = useState('');
  const [agentType, setAgentType] = useState<AgentType>('claudecode');
  // Keep the non-feishu fields of each agent's config so we can round-trip
  // them when saving credentials (otherwise we'd blow away binPath etc.).
  const [agentCfgRest, setAgentCfgRest] = useState<Record<AgentType, Record<string, any>>>({
    claudecode: {},
    openclaw: {},
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);

  // OpenClaw-specific surfaced fields
  const [ocBinPath, setOcBinPath] = useState('');
  const [ocGatewayPort, setOcGatewayPort] = useState('18789');

  // Currently-displayed creds = whichever agent the dropdown points at.
  const appId = credsByAgent[agentType].appId;
  const appSecret = credsByAgent[agentType].appSecret;

  const updateCurrentCreds = (patch: Partial<FeishuCreds>) => {
    setCredsByAgent((prev) => ({
      ...prev,
      [agentType]: { ...prev[agentType], ...patch },
    }));
  };

  useEffect(() => {
    if (!open) return;

    // Load both agent configs in parallel so switching the dropdown is instant.
    const loadAll = async () => {
      // platform-config.json carries the active agent selection + project path.
      let activeAgent: AgentType = 'claudecode';
      let activeProjectPath = '';
      try {
        const cfg = await api.platform.getConfig();
        activeAgent = (cfg.agentType as AgentType) || 'claudecode';
        activeProjectPath = cfg.projectPath || '';
      } catch {}

      // Pull each agent's config (including feishu creds) so the form can
      // switch between them without another round trip.
      const [claudeCfg, openclawCfg] = (await Promise.all([
        api.platform.getAgentConfig('claudecode').catch(() => ({})),
        api.platform.getAgentConfig('openclaw').catch(() => ({})),
      ])) as [any, any];

      const extractCreds = (cfg: any): FeishuCreds => ({
        appId: cfg?.feishu?.appId || cfg?.feishu?.app_id || '',
        appSecret: cfg?.feishu?.appSecret || cfg?.feishu?.app_secret || '',
      });

      const stripFeishu = (cfg: any): Record<string, any> => {
        if (!cfg || typeof cfg !== 'object') return {};
        const { feishu: _drop, ...rest } = cfg;
        return rest;
      };

      setCredsByAgent({
        claudecode: extractCreds(claudeCfg),
        openclaw: extractCreds(openclawCfg),
      });
      setAgentCfgRest({
        claudecode: stripFeishu(claudeCfg),
        openclaw: stripFeishu(openclawCfg),
      });
      setProjectPath(activeProjectPath);
      setAgentType(activeAgent);
      setOcBinPath(openclawCfg?.binPath || '');
      setOcGatewayPort(String(openclawCfg?.gatewayPort || 18789));
    };

    loadAll().catch(() => {});
  }, [open]);

  const handleSubmit = async () => {
    setError(null);
    if (!appId.trim() || !appSecret.trim()) {
      setError(t('home.imChannel.feishu.setup.errorMissing', '请填写 App ID 和 App Secret'));
      return;
    }
    setSaving(true);
    try {
      // Persist credentials into each agent's per-agent config so switching
      // the backend also switches which Feishu app is used.
      const saveAgent = async (type: AgentType, extra: Record<string, any>) => {
        const creds = credsByAgent[type];
        const base = agentCfgRest[type] || {};
        await api.platform.saveAgentConfig(type, {
          ...base,
          ...extra,
          feishu: {
            appId: creds.appId.trim(),
            appSecret: creds.appSecret.trim(),
          },
        });
      };

      // claudecode: only creds (extra fields preserved from agentCfgRest).
      await saveAgent('claudecode', {});
      // openclaw: creds + the editable fields surfaced in this dialog.
      await saveAgent('openclaw', {
        binPath: ocBinPath.trim() || null,
        gatewayPort: parseInt(ocGatewayPort, 10) || 18789,
      });

      // Platform root: only shared fields now — creds live in agent files.
      // We still pass appId/appSecret in the DTO for wire-compat with the
      // Rust FeishuConfig struct; the Rust side re-routes them into the
      // active agent's file on write.
      await api.platform.saveConfig({
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        projectPath: projectPath.trim(),
        enabled: true,
        agentType,
      });

      // Restart sidecar
      try { await api.platform.stop(); } catch {}
      const result = await api.platform.start();
      if (result.status === 'running') {
        try { await api.platform.connectFeishu(); } catch {}
        onConnected?.();
        onOpenChange(false);
      } else {
        setError(result.error || t('home.imChannel.feishu.setup.errorStart', '启动 sidecar 失败'));
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const selectedAgent = AGENT_OPTIONS.find((a) => a.value === agentType) || AGENT_OPTIONS[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-white">
              <FeishuIcon className="h-6 w-6" />
            </div>
            <div>
              <DialogTitle className="text-base">
                {t('home.imChannel.feishu.setup.connect', '连接 飞书 / Feishu')}
              </DialogTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {t('home.imChannel.feishu.setup.configCredentials', '配置 Bot 凭证 + CLI 后端')}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* ─── CLI Backend Selector ──────────────────────────────────── */}
          <div>
            <label className="text-[12px] font-medium text-foreground">CLI Backend</label>
            <div className="relative mt-1.5">
              <button
                type="button"
                onClick={() => setAgentDropdownOpen(!agentDropdownOpen)}
                disabled={saving}
                className="flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-[12px] hover:bg-accent/50 transition-colors disabled:opacity-50"
              >
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted">
                    {selectedAgent.icon}
                  </div>
                  <div className="text-left">
                    <div className="font-medium">{selectedAgent.label}</div>
                    <div className="text-[10px] text-muted-foreground">{selectedAgent.desc}</div>
                  </div>
                </div>
                <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${agentDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

              {agentDropdownOpen && (
                <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-lg">
                  {AGENT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        setAgentType(opt.value);
                        setAgentDropdownOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-[12px] hover:bg-accent/50 first:rounded-t-md last:rounded-b-md transition-colors ${
                        agentType === opt.value ? 'bg-accent/30' : ''
                      }`}
                    >
                      <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted">
                        {opt.icon}
                      </div>
                      <div className="text-left">
                        <div className="font-medium">{opt.label}</div>
                        <div className="text-[10px] text-muted-foreground">{opt.desc}</div>
                      </div>
                      {agentType === opt.value && (
                        <div className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ─── OpenClaw Config (conditional) ─────────────────────────── */}
          {agentType === 'openclaw' && (
            <div className="space-y-3 rounded-lg border border-border/50 bg-muted/30 p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                <Cpu className="h-3 w-3" />
                OpenClaw
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground">
                  Binary Path
                  <span className="text-[10px] ml-1 opacity-60">(empty = auto detect from PATH)</span>
                </label>
                <Input
                  value={ocBinPath}
                  onChange={(e) => setOcBinPath(e.target.value)}
                  placeholder="openclaw (auto)"
                  className="mt-1 font-mono text-[11px] h-8"
                  disabled={saving}
                />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground">Gateway Port</label>
                <Input
                  value={ocGatewayPort}
                  onChange={(e) => setOcGatewayPort(e.target.value)}
                  placeholder="18789"
                  className="mt-1 font-mono text-[11px] h-8 w-28"
                  disabled={saving}
                  type="number"
                />
              </div>
            </div>
          )}

          {/* ─── Feishu Credentials ────────────────────────────────────── */}
          <div>
            <label className="text-[12px] font-medium text-foreground">
              App ID
              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                ({selectedAgent.label})
              </span>
            </label>
            <Input
              value={appId}
              onChange={(e) => updateCurrentCreds({ appId: e.target.value })}
              placeholder="cli_xxxxxxxxxxxxxxxx"
              className="mt-1.5 font-mono text-[12px]"
              autoComplete="off"
              disabled={saving}
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {t(
                'home.imChannel.feishu.setup.appIdHint',
                '从'
              )}{' '}
              <button
                type="button"
                onClick={() => openUrl(FEISHU_CREDENTIALS_URL)}
                className="text-primary hover:underline inline-flex items-center gap-0.5"
              >
                飞书开放平台 &gt; 应用凭证
                <ExternalLink className="h-2.5 w-2.5" />
              </button>{' '}
              {t('home.imChannel.feishu.setup.pageGet', '页面获取')}
            </p>
          </div>

          <div>
            <label className="text-[12px] font-medium text-foreground">
              App Secret
              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                ({selectedAgent.label})
              </span>
            </label>
            <Input
              type="password"
              value={appSecret}
              onChange={(e) => updateCurrentCreds({ appSecret: e.target.value })}
              placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="mt-1.5 font-mono text-[12px]"
              autoComplete="off"
              disabled={saving}
            />
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              {t(
                'home.imChannel.feishu.setup.perAgentHint',
                '每个 CLI 后端使用独立的飞书应用 — 切换后端会自动切换凭证。'
              )}
            </p>
          </div>

          <div>
            <label className="text-[12px] font-medium text-foreground">
              {t('home.imChannel.feishu.setup.projectPathLabel', '项目路径 (可选)')}
            </label>
            <Input
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder="D:\\Claude\\your-project"
              className="mt-1.5 font-mono text-[12px]"
              autoComplete="off"
              disabled={saving}
            />
          </div>

          <div className="text-[11px] text-muted-foreground">
            {t('home.imChannel.feishu.setup.tutorialPrefix', '查看')}{' '}
            <button
              type="button"
              onClick={() => openUrl(FEISHU_TUTORIAL_URL)}
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              飞书 / Feishu 接入教程
              <ExternalLink className="h-2.5 w-2.5" />
            </button>
            {' '}。
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-destructive mt-0.5" />
              <div className="text-[11px] text-destructive leading-relaxed">{error}</div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t('common.cancel', '取消')}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {t('home.imChannel.feishu.setup.connecting', '连接中...')}
              </>
            ) : (
              t('home.imChannel.feishu.setup.connect', '连接')
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

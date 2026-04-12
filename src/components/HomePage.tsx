import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  XCircle,
  RefreshCw,
  Loader2,
  Download,
  Wand2,
  Terminal,
  LogIn,
  Key,
  LogOut,
  Check,
  MessageSquare,
  ExternalLink,
  Play,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toast, ToastContainer } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigation } from '@/contexts/NavigationContext';
import { usePlatformStatus } from '@/hooks/usePlatformStatus';

interface ToolStatus {
  id: string;
  name: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  installable: boolean;
}

// =====================================================================
// Shared Card wrapper
// =====================================================================

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  step?: number;
  completed?: boolean;
}

const FeatureCard: React.FC<FeatureCardProps> = ({
  icon,
  title,
  subtitle,
  headerRight,
  children,
  className,
  step,
  completed,
}) => {
  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-5 shadow-sm transition-colors',
        completed ? 'border-green-500/30' : 'border-border',
        className
      )}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          {step != null && (
            <div className={cn(
              'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
              completed
                ? 'bg-green-500 text-white'
                : 'bg-blue-500 text-white'
            )}>
              {completed ? <Check className="h-3.5 w-3.5" /> : step}
            </div>
          )}
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-background">
            {icon}
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        {headerRight}
      </div>
      {children}
    </div>
  );
};

// =====================================================================
// Dev Environment Card
// =====================================================================

const DevEnvironmentCard: React.FC<{
  onToast: (message: string, type: 'success' | 'error' | 'info') => void;
  step?: number;
}> = ({ onToast, step }) => {
  const { t } = useTranslation();
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installingAll, setInstallingAll] = useState(false);

  // OpenClaw runtime status
  const [openclawRunning, setOpenclawRunning] = useState<boolean | null>(null);
  const [openclawStarting, setOpenclawStarting] = useState(false);
  const [openclawAutoStart, setOpenclawAutoStart] = useState(false);

  const loadOpenclawStatus = useCallback(async () => {
    try {
      const s = await api.platform.getOpenclawStatus();
      setOpenclawRunning(!!(s.active && s.processAlive && s.wsConnected));
    } catch {
      setOpenclawRunning(null);
    }
  }, []);

  const handleOpenclawStart = useCallback(async () => {
    setOpenclawStarting(true);
    try {
      await api.platform.openclawStart();
      await loadOpenclawStatus();
    } catch (e: any) {
      onToast(`OpenClaw 启动失败: ${e?.message || e}`, 'error');
    } finally {
      setOpenclawStarting(false);
    }
  }, [loadOpenclawStatus, onToast]);

  const toggleAutoStart = useCallback(async (checked: boolean) => {
    setOpenclawAutoStart(checked);
    try {
      const cfg = await api.platform.getConfig();
      await api.platform.saveConfig({ ...cfg, openclawAutoStart: checked });
    } catch (e: any) {
      onToast(`保存失败: ${e?.message || e}`, 'error');
      setOpenclawAutoStart(!checked);
    }
  }, [onToast]);

  const checkTools = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.checkToolsInstalled();
      setTools(result.tools);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkTools();
    loadOpenclawStatus();
    // Load autostart setting
    api.platform.getConfig().then((cfg) => {
      setOpenclawAutoStart(cfg.openclawAutoStart ?? false);
    }).catch(() => {});
    // Poll OpenClaw status every 3s
    const interval = setInterval(loadOpenclawStatus, 3000);
    return () => clearInterval(interval);
  }, [checkTools, loadOpenclawStatus]);

  const installOne = useCallback(
    async (toolId: string, toolName: string) => {
      setInstallingId(toolId);
      onToast(`${t('home.installing', '安装中')} ${toolName}...`, 'info');
      try {
        const result = await api.installTool(toolId);
        onToast(
          result.message || (result.success ? `${toolName} 安装成功` : `${toolName} 安装失败`),
          result.success ? 'success' : 'error'
        );
        await checkTools();
      } catch (e) {
        onToast(`${toolName} 安装失败: ${e}`, 'error');
      } finally {
        setInstallingId(null);
      }
    },
    [checkTools, onToast, t]
  );

  const installAllMissing = useCallback(async () => {
    setInstallingAll(true);
    try {
      const order = ['node', 'git', 'claude', 'codex', 'gemini', 'openclaw'];
      const missing = order
        .map((id) => tools.find((tool) => tool.id === id))
        .filter((tool): tool is ToolStatus => !!tool && !tool.installed && tool.installable);

      for (const tool of missing) {
        setInstallingId(tool.id);
        onToast(`${t('home.installing', '安装中')} ${tool.name}...`, 'info');
        try {
          const result = await api.installTool(tool.id);
          onToast(
            result.message || (result.success ? `${tool.name} 安装成功` : `${tool.name} 安装失败`),
            result.success ? 'success' : 'error'
          );
        } catch (e) {
          onToast(`${tool.name} 安装失败: ${e}`, 'error');
        }
        await checkTools();
      }
    } finally {
      setInstallingId(null);
      setInstallingAll(false);
    }
  }, [tools, checkTools, onToast, t]);

  const installedCount = tools.filter((tool) => tool.installed).length;
  const totalCount = tools.length;
  const missingCount = tools.filter((t) => !t.installed && t.installable).length;
  const allReady = installedCount === totalCount && totalCount > 0;

  return (
    <FeatureCard
      icon={<Terminal className="h-5 w-5 text-blue-500" />}
      title={t('home.devEnv.title', '开发环境检测')}
      subtitle={t('home.devEnv.subtitle', '检测并一键安装必备开发工具')}
      step={step}
      completed={allReady}
      headerRight={
        <div className="flex items-center gap-2">
          {!loading && totalCount > 0 && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                allReady
                  ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                  : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
              )}
            >
              {allReady ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
              {installedCount}/{totalCount}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={checkTools}
            disabled={loading || installingAll || installingId !== null}
            className="h-7 w-7"
            title={t('home.refresh')}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      }
    >
      {missingCount > 0 && !loading && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {t('home.devEnv.missingHint', '有 {{count}} 个工具未安装', { count: missingCount })}
          </span>
          <Button
            size="sm"
            onClick={installAllMissing}
            disabled={installingAll || installingId !== null}
            className="h-7 bg-gradient-to-r from-blue-600 to-indigo-600 text-xs text-white hover:from-blue-700 hover:to-indigo-700"
          >
            {installingAll ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Wand2 className="mr-1 h-3 w-3" />
            )}
            {t('home.installAll', '一键安装')}
          </Button>
        </div>
      )}

      {loading && tools.length === 0 ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              className="flex h-14 items-center gap-2 rounded-lg border border-border p-3 animate-pulse"
            >
              <div className="h-4 w-4 rounded-full bg-muted" />
              <div className="h-3 w-20 rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {tools.map((tool) => {
            const isInstalling = installingId === tool.id;
            const isOpenClaw = tool.id === 'openclaw';
            return (
              <div
                key={tool.id}
                className={cn(
                  'flex items-center gap-2 rounded-lg border p-2.5 transition-colors',
                  tool.installed
                    ? 'border-green-500/20 bg-green-500/5'
                    : 'border-red-500/20 bg-red-500/5'
                )}
              >
                {tool.installed ? (
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-500" />
                ) : (
                  <XCircle className="h-4 w-4 flex-shrink-0 text-red-500" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">{tool.name}</div>
                  {isOpenClaw && tool.installed ? (
                    <div className="text-[10px] text-muted-foreground">
                      {openclawRunning ? (
                        <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                          {t('home.running', '运行中')}
                        </span>
                      ) : (
                        t('home.installed', '已安装')
                      )}
                    </div>
                  ) : tool.version ? (
                    <div className="truncate text-[10px] text-muted-foreground" title={tool.version}>
                      {tool.version.split('\n')[0]}
                    </div>
                  ) : (
                    <div className="text-[10px] text-muted-foreground">
                      {tool.installed ? t('home.installed', '已安装') : t('home.notInstalled')}
                    </div>
                  )}
                </div>
                {/* OpenClaw: show Start button when installed but not running */}
                {isOpenClaw && tool.installed && !openclawRunning && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleOpenclawStart}
                    disabled={openclawStarting}
                    className="h-6 flex-shrink-0 px-2 text-[10px]"
                  >
                    {openclawStarting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <>
                        <Play className="mr-0.5 h-3 w-3" />
                        {t('home.start', '启动')}
                      </>
                    )}
                  </Button>
                )}
                {!tool.installed && tool.installable && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => installOne(tool.id, tool.name)}
                    disabled={installingAll || installingId !== null}
                    className="h-6 flex-shrink-0 px-2 text-[10px]"
                  >
                    {isInstalling ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <>
                        <Download className="mr-0.5 h-3 w-3" />
                        {t('home.install', '安装')}
                      </>
                    )}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* OpenClaw autostart checkbox */}
      {tools.some((t) => t.id === 'openclaw' && t.installed) && (
        <label className="mt-3 flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 transition-colors hover:bg-muted/30">
          <input
            type="checkbox"
            checked={openclawAutoStart}
            onChange={(e) => toggleAutoStart(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-border accent-blue-600"
          />
          <span className="text-xs text-muted-foreground">
            {t('home.devEnv.openclawAutoStart', 'OpenClaw 自动启动')}
          </span>
        </label>
      )}
    </FeatureCard>
  );
};

// =====================================================================
// Frogclaw Connect Card
// =====================================================================

const FrogclawCard: React.FC<{
  onToast: (message: string, type: 'success' | 'error' | 'info') => void;
  step?: number;
}> = ({ onToast, step }) => {
  const { t } = useTranslation();
  const { user, isAuthenticated, login, logout, tokens, selectedTokenId, selectToken, openclawModels, feishuAppId } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [switchingToken, setSwitchingToken] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true);
    try {
      await login(username, password);
      onToast(t('home.frogclaw.loginSuccess', '登录成功'), 'success');
      setUsername('');
      setPassword('');
    } catch (err: any) {
      onToast(err?.message || t('home.frogclaw.loginFailed', '登录失败'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleTokenSelect = async (tokenId: number) => {
    setSwitchingToken(true);
    try {
      await selectToken(tokenId);
      onToast(t('home.frogclaw.tokenSwitched', '令牌已切换'), 'success');
    } catch (err: any) {
      onToast(err?.message || t('home.frogclaw.tokenSwitchFailed', '令牌切换失败'), 'error');
    } finally {
      setSwitchingToken(false);
    }
  };

  return (
    <FeatureCard
      icon={<Key className="h-5 w-5 text-emerald-500" />}
      title={t('home.frogclaw.title', 'Frogclaw 连接')}
      subtitle={t('home.frogclaw.subtitle', '登录 Frogclaw 获取 API 令牌和 OpenClaw 配置')}
      step={step}
      completed={isAuthenticated}
      headerRight={
        isAuthenticated && (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-3 w-3" />
            {t('home.frogclaw.connected', '已连接')}
          </span>
        )
      }
    >
      {!isAuthenticated ? (
        <form onSubmit={handleLogin} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">
              {t('home.frogclaw.username', '用户名')}
            </label>
            <Input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('home.frogclaw.usernamePlaceholder', '请输入用户名')}
              disabled={loading}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">
              {t('home.frogclaw.password', '密码')}
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('home.frogclaw.passwordPlaceholder', '请输入密码')}
              disabled={loading}
            />
          </div>
          <Button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full"
          >
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <LogIn className="mr-2 h-4 w-4" />
            )}
            {t('home.frogclaw.login', '登录')}
          </Button>
        </form>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border bg-background/50 px-3 py-2">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">
                {t('home.frogclaw.loggedInAs', '当前用户')}
              </div>
              <div className="truncate text-sm font-medium">
                {user?.display_name || user?.username}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={logout} className="flex-shrink-0">
              <LogOut className="mr-1 h-3.5 w-3.5" />
              {t('home.frogclaw.logout', '退出')}
            </Button>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">
              {t('home.frogclaw.selectToken', '选择令牌')}
            </label>
            {tokens.length > 0 ? (
              <div className="space-y-1.5">
                {tokens.map((token) => {
                  const isSelected = selectedTokenId === token.id;
                  return (
                    <button
                      key={token.id}
                      onClick={() => handleTokenSelect(token.id)}
                      disabled={switchingToken || isSelected}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors',
                        isSelected
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-border hover:border-border/80 hover:bg-muted/50'
                      )}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium">{token.name}</div>
                      </div>
                      {isSelected && (
                        <Check className="h-4 w-4 flex-shrink-0 text-primary" />
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                {t('home.frogclaw.noTokens', '暂无可用令牌')}
              </div>
            )}
          </div>

          {/* OpenClaw Config from Server */}
          {(openclawModels.length > 0 || feishuAppId) && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                OpenClaw {t('home.frogclaw.serverConfig', '服务器配置')}
              </div>
              {openclawModels.length > 0 && (
                <div>
                  <div className="text-[11px] text-muted-foreground mb-1">
                    {t('home.frogclaw.models', '模型')} ({openclawModels.length})
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {openclawModels.map((m) => (
                      <span
                        key={`${m.provider}/${m.id}`}
                        className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-mono text-foreground"
                        title={`${m.provider}/${m.id}`}
                      >
                        {m.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {feishuAppId && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    {t('home.frogclaw.feishuAppId', '飞书 App ID')}:
                  </span>
                  <code className="text-[11px] font-mono text-foreground bg-muted px-1.5 py-0.5 rounded">
                    {feishuAppId}
                  </code>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </FeatureCard>
  );
};

// =====================================================================
// IM Channel Card — quick overview, click to go to IM Channels page
// =====================================================================

const FeishuIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 48 48" className={className} xmlns="http://www.w3.org/2000/svg">
    <path fill="#00D6B9" d="M32.5 12C38 12 42 16 42 21.5V36c0 .5-.6.8-1 .5-6.3-4.8-11.3-8-17-8-3.2 0-6 .7-9 2.2-.4.2-.8-.1-.8-.5V21.5C14.2 16 18.2 12 23.7 12h8.8z" />
    <path fill="#3370FF" d="M6 22.8c0-.5.6-.8 1-.5 4.8 3.6 9.3 7 14.5 9.7 4.8 2.4 9.5 3 14.7 2.5.5 0 .8.4.6.8-2.5 4.3-7.2 7.2-12.5 7.2-3 0-5.8-.9-8.2-2.4C10.2 37 6 31.4 6 24.8v-2z" />
  </svg>
);

const WechatIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 48 48" className={className} xmlns="http://www.w3.org/2000/svg" fill="#07C160">
    <path d="M18.5 6C9.9 6 3 11.8 3 19c0 4.1 2.3 7.7 5.9 10.1L7 34l5.4-2.7c1.9.5 3.9.8 6.1.8.5 0 1 0 1.5-.1-.3-1-.5-2-.5-3 0-6.2 5.8-11.2 13-11.2.5 0 1 0 1.5.1C33 11.3 26.4 6 18.5 6zm-5 8.5c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm10 0c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2z" />
    <path d="M45 29.5c0-5.8-5.8-10.5-13-10.5s-13 4.7-13 10.5S24.8 40 32 40c1.7 0 3.3-.2 4.8-.7L41 41l-1.2-3.7C43 35.4 45 32.6 45 29.5zm-17-3c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zm8 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5z" />
  </svg>
);

interface ChannelQuickCardProps {
  icon: React.ReactNode;
  name: string;
  description: string;
  statusColor: string;
  statusText: string;
  onClick: () => void;
}

const ChannelQuickCard: React.FC<ChannelQuickCardProps> = ({
  icon, name, description, statusColor, statusText, onClick,
}) => {
  const { t } = useTranslation();
  return (
    <div className="group flex flex-col rounded-lg border border-border bg-background/50 p-3 transition-all hover:border-border/80 hover:bg-background">
      <div className="mb-2 flex items-center gap-2.5">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-white">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{name}</div>
          <div className="flex items-center gap-1">
            <span className={cn('h-1.5 w-1.5 rounded-full', statusColor)} aria-hidden />
            <span className="text-[10px] text-muted-foreground">{statusText}</span>
          </div>
        </div>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground line-clamp-2">
        {description}
      </p>
      <Button size="sm" variant="outline" onClick={onClick} className="h-7 w-full text-xs">
        <ExternalLink className="mr-1 h-3 w-3" />
        {t('home.imChannel.configure', '配置')}
      </Button>
    </div>
  );
};

const IMChannelCard: React.FC<{ step?: number }> = ({ step }) => {
  const { t } = useTranslation();
  const { navigateTo } = useNavigation();
  const bridge = usePlatformStatus();

  const feishuConnected = bridge.status === 'running' && bridge.feishuStatus === 'running';
  const feishuColor = feishuConnected
    ? 'bg-green-500'
    : bridge.status === 'running' && bridge.feishuStatus === 'starting'
      ? 'bg-amber-400'
      : bridge.status === 'running' && bridge.feishuStatus === 'error'
        ? 'bg-red-500'
        : 'bg-muted-foreground/40';
  const feishuStatusText = feishuConnected
    ? t('home.imChannel.connected', '已连接')
    : t('home.imChannel.notConfigured', '未配置');

  const goToChannels = () => navigateTo('im-channels');

  return (
    <FeatureCard
      icon={<MessageSquare className="h-5 w-5 text-purple-500" />}
      title={t('home.imChannel.title', 'IM 通道设置')}
      subtitle={t('home.imChannel.subtitle', '配置飞书机器人，选择 Claude Code 或 OpenClaw 作为后端')}
      step={step}
      completed={feishuConnected}
    >
      {/* Backend choice hint */}
      <div className="mb-3 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2">
        <p className="text-[11px] leading-relaxed text-blue-700 dark:text-blue-400">
          {t('home.imChannel.backendHint', '飞书机器人支持两种 AI 后端：Claude Code（使用官方 Claude Max 订阅）或 OpenClaw（通过 Frogclaw 服务器）。在 IM 通道页面中选择并配置。')}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <ChannelQuickCard
          icon={<FeishuIcon className="h-5 w-5" />}
          name={t('home.imChannel.feishu', '飞书')}
          description={t('home.imChannel.feishuDesc', '通过飞书机器人接收通知，支持消息卡片和交互按钮')}
          statusColor={feishuColor}
          statusText={feishuStatusText}
          onClick={goToChannels}
        />
        <ChannelQuickCard
          icon={<WechatIcon className="h-5 w-5" />}
          name={t('home.imChannel.wechat', '微信')}
          description={t('home.imChannel.wechatDesc', '通过企业微信或 Server 酱推送消息到个人微信')}
          statusColor="bg-muted-foreground/40"
          statusText={t('home.imChannel.comingSoon', '即将推出')}
          onClick={goToChannels}
        />
      </div>
    </FeatureCard>
  );
};

// =====================================================================
// HomePage
// =====================================================================

export const HomePage: React.FC = () => {
  const { t } = useTranslation();
  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  const showToast = useCallback(
    (message: string, type: 'success' | 'error' | 'info') => {
      setToast({ message, type });
    },
    []
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="container mx-auto max-w-5xl p-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight">{t('home.title')}</h1>
          <div className="mt-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
            <p className="mb-2 text-sm font-medium text-foreground">
              {t('home.guideTitle', '三步快速上手')}
            </p>
            <ol className="space-y-1 text-xs leading-relaxed text-muted-foreground">
              <li>
                <span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white">1</span>
                {t('home.guideStep1', '安装开发环境 — 检测 Node.js、Git、Claude Code、OpenClaw 等工具，缺少的可一键安装')}
              </li>
              <li>
                <span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white">2</span>
                {t('home.guideStep2', '登录 Frogclaw — 输入用户名和密码，自动获取 API 令牌、OpenClaw 模型配置和飞书凭据')}
              </li>
              <li>
                <span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white">3</span>
                {t('home.guideStep3', '配置飞书通道 — 选择 Claude Code（官方 Claude Max 订阅）或 OpenClaw 作为 AI 后端，完成后即可在飞书中与 AI 对话编程')}
              </li>
            </ol>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <DevEnvironmentCard onToast={showToast} step={1} />
          <FrogclawCard onToast={showToast} step={2} />
          <IMChannelCard step={3} />
        </div>
      </div>

      <ToastContainer>
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </ToastContainer>
    </div>
  );
};

/**
 * WeChat Setup Dialog — QR-scan login for personal WeChat (ilink gateway).
 *
 * Flow:
 *   1. Open dialog → call wechatQrStart() → render QR
 *   2. Call wechatQrWait(sessionKey) → polls until scanned
 *   3. On confirmed → save channel to im-channels.json with platform: 'wechat'
 */
import React, { useState, useEffect, useRef } from 'react';
import { Loader2, AlertCircle, Terminal, CircleOff, RefreshCw, CheckCircle2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { api, type IMChannelConfig } from '@/lib/api';
import { useTranslation } from 'react-i18next';

type AgentAssignment = 'claudecode' | 'openclaw' | 'none';
type Phase = 'idle' | 'loading-qr' | 'waiting-scan' | 'refreshing' | 'confirming' | 'done' | 'error';

const WeChatIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path fill="#07C160" d="M18 8C10 8 4 14 4 22c0 4.3 2 8 5 10.7L8 37l4.8-2.2c1.7.5 3.4.8 5.2.8 1 0 2-.1 2.9-.3-.5-1.2-.8-2.5-.8-3.8 0-6.8 6.3-12 14-12 .7 0 1.4 0 2.1.2C35.6 14 27.6 8 18 8zm-5 10.5a2 2 0 110-4 2 2 0 010 4zm10 0a2 2 0 110-4 2 2 0 010 4z" />
    <path fill="#07C160" d="M44 32c0-5.5-5.4-10-12-10s-12 4.5-12 10 5.4 10 12 10c1.5 0 2.9-.2 4.2-.6L40 43l-.9-3.3c3-1.8 4.9-4.5 4.9-7.7zm-16-2a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm8 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" />
  </svg>
);

interface WeChatSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
}

export const WeChatSetupDialog: React.FC<WeChatSetupDialogProps> = ({
  open,
  onOpenChange,
  onConnected,
}) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('idle');
  const [qrUrl, setQrUrl] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [assignment, setAssignment] = useState<AgentAssignment>('none');
  const sessionKeyRef = useRef<string>('');
  const cancelRef = useRef<boolean>(false);

  const cleanup = async () => {
    cancelRef.current = true;
    const key = sessionKeyRef.current;
    if (key) {
      try { await api.platform.wechatQrCancel(key); } catch {}
    }
    sessionKeyRef.current = '';
    setQrUrl('');
  };

  // Start the QR flow when dialog opens
  useEffect(() => {
    if (!open) {
      cleanup();
      setPhase('idle');
      setError(null);
      return;
    }

    let mounted = true;
    cancelRef.current = false;

    (async () => {
      setPhase('loading-qr');
      setError(null);

      try {
        const start = await api.platform.wechatQrStart();
        if (!mounted || cancelRef.current) return;
        if (!start.ok || !start.sessionKey || !start.qrUrl) {
          throw new Error(start.error || 'failed to start QR login');
        }
        sessionKeyRef.current = start.sessionKey;
        setQrUrl(start.qrUrl);
        setPhase('waiting-scan');

        // Poll loop — handles QR refresh as well
        while (mounted && !cancelRef.current) {
          const result = await api.platform.wechatQrWait(sessionKeyRef.current);
          if (!mounted || cancelRef.current) return;

          if (result.confirmed && result.botToken && result.ilinkBotId) {
            setPhase('confirming');
            await saveChannel(result.botToken, result.ilinkBotId, result.ilinkUserId || '');
            setPhase('done');
            onConnected?.();
            setTimeout(() => onOpenChange(false), 1200);
            return;
          }

          // Refreshed QR — update and keep polling
          if (result.qrUrl && !result.confirmed) {
            setQrUrl(result.qrUrl);
            setPhase('waiting-scan');
            continue;
          }

          // Terminal error
          throw new Error(result.error || 'login failed');
        }
      } catch (e: any) {
        if (!mounted || cancelRef.current) return;
        setError(String(e?.message || e));
        setPhase('error');
      }
    })();

    return () => {
      mounted = false;
      cancelRef.current = true;
      const key = sessionKeyRef.current;
      if (key) {
        api.platform.wechatQrCancel(key).catch(() => {});
      }
    };
  }, [open]);

  const saveChannel = async (botToken: string, ilinkBotId: string, ilinkUserId: string) => {
    const data = await api.getImChannels().catch(() => ({
      channels: [] as IMChannelConfig[],
      suppressedAppIds: [] as string[],
    }));
    const channels: IMChannelConfig[] = [...data.channels];
    const suppressedAppIds = data.suppressedAppIds.filter(id => id !== ilinkBotId);

    // Remove any existing WeChat channel (singleton model for v1)
    const nonWechat = channels.filter(ch => ch.platform !== 'wechat');
    const labelText = ilinkUserId ? `WeChat: ${ilinkUserId.slice(0, 12)}` : 'WeChat';

    nonWechat.push({
      id: `wechat-${ilinkBotId}`,
      platform: 'wechat',
      appId: ilinkBotId,
      appSecret: botToken,
      label: labelText,
      assignment,
    });

    // Unassign other channels if this one took an agent
    if (assignment !== 'none') {
      for (const ch of nonWechat) {
        if (ch.platform !== 'wechat' && ch.assignment === assignment) {
          ch.assignment = 'none';
        }
      }
    }

    await api.saveImChannels({ channels: nonWechat, suppressedAppIds });

    // Sync platform config + reconcile
    const cfg = await api.platform.getConfig().catch(() => ({
      appId: '', appSecret: '', projectPath: '', enabled: false, openclawAutoStart: false,
    })) as any;
    await api.platform.saveConfig({ ...cfg, enabled: assignment !== 'none' });
    try { await api.platform.reloadConfig(); } catch {}
  };

  const retry = async () => {
    await cleanup();
    setError(null);
    setPhase('idle');
    // Trigger effect by closing-opening (no easy way to re-run effect otherwise)
    // Simpler: manually re-run the flow
    sessionKeyRef.current = '';
    setPhase('loading-qr');
    try {
      const start = await api.platform.wechatQrStart();
      if (!start.ok || !start.sessionKey || !start.qrUrl) {
        throw new Error(start.error || 'failed to start');
      }
      sessionKeyRef.current = start.sessionKey;
      setQrUrl(start.qrUrl);
      setPhase('waiting-scan');
      cancelRef.current = false;
      // Resume polling in a separate async loop
      (async () => {
        while (!cancelRef.current) {
          const result = await api.platform.wechatQrWait(sessionKeyRef.current).catch((e): any => ({
            ok: false, confirmed: false, error: e.message,
          }));
          if (cancelRef.current) return;
          if (result.confirmed && result.botToken && result.ilinkBotId) {
            setPhase('confirming');
            await saveChannel(result.botToken, result.ilinkBotId, result.ilinkUserId || '');
            setPhase('done');
            onConnected?.();
            setTimeout(() => onOpenChange(false), 1200);
            return;
          }
          if (result.qrUrl && !result.confirmed) {
            setQrUrl(result.qrUrl);
            setPhase('waiting-scan');
            continue;
          }
          setError(result.error || 'login failed');
          setPhase('error');
          return;
        }
      })();
    } catch (e: any) {
      setError(String(e?.message || e));
      setPhase('error');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-white">
              <WeChatIcon className="h-6 w-6" />
            </div>
            <div>
              <DialogTitle className="text-base">
                {t('home.imChannel.wechat.setup.connect', '连接个人微信')}
              </DialogTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {t('home.imChannel.wechat.setup.subtitle', '使用微信扫一扫完成登录')}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* QR Display */}
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-muted/30 py-6">
            {phase === 'loading-qr' && (
              <div className="flex h-48 w-48 items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            )}

            {(phase === 'waiting-scan' || phase === 'refreshing') && qrUrl && (
              <>
                <div className="rounded-md bg-white p-3">
                  <QRCodeSVG value={qrUrl} size={192} level="M" />
                </div>
                <p className="text-[12px] font-medium text-foreground">
                  {t('home.imChannel.wechat.setup.scanPrompt', '请使用微信扫一扫')}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {t('home.imChannel.wechat.setup.scanHint', '手机微信 → 发现 → 扫一扫')}
                </p>
              </>
            )}

            {phase === 'confirming' && (
              <div className="flex h-48 w-48 flex-col items-center justify-center gap-2">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-[12px] text-muted-foreground">
                  {t('home.imChannel.wechat.setup.confirming', '正在完成登录...')}
                </p>
              </div>
            )}

            {phase === 'done' && (
              <div className="flex h-48 w-48 flex-col items-center justify-center gap-2">
                <CheckCircle2 className="h-12 w-12 text-green-500" />
                <p className="text-[13px] font-medium text-foreground">
                  {t('home.imChannel.wechat.setup.done', '登录成功')}
                </p>
              </div>
            )}

            {phase === 'error' && (
              <div className="flex h-48 flex-col items-center justify-center gap-3 px-4">
                <AlertCircle className="h-10 w-10 text-destructive" />
                <p className="text-[12px] text-center text-destructive">{error}</p>
                <Button size="sm" variant="outline" onClick={retry}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  {t('common.retry', '重试')}
                </Button>
              </div>
            )}
          </div>

          {/* AI Backend — only shown before login completes */}
          {phase !== 'done' && (
            <div>
              <label className="text-[12px] font-medium text-foreground">
                {t('home.imChannel.wechat.setup.backendLabel', 'AI 后端')}
                <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                  ({t('common.optional', '可选')})
                </span>
              </label>
              <Select
                value={assignment}
                onValueChange={(v) => setAssignment(v as AgentAssignment)}
                disabled={phase === 'confirming'}
              >
                <SelectTrigger className="mt-1.5 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    <span className="flex items-center gap-2">
                      <CircleOff className="h-3.5 w-3.5 text-muted-foreground" />
                      {t('imChannels.unassigned', '未分配')}
                    </span>
                  </SelectItem>
                  <SelectItem value="claudecode">
                    <span className="flex items-center gap-2">
                      <Terminal className="h-3.5 w-3.5" />
                      Claude Code
                    </span>
                  </SelectItem>
                  <SelectItem value="openclaw">
                    <span className="flex items-center gap-2">
                      <svg viewBox="0 0 120 120" fill="none" className="h-3.5 w-3.5">
                        <defs>
                          <linearGradient id="oc-wx-sel" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor="#ff4d4d" />
                            <stop offset="100%" stopColor="#991b1b" />
                          </linearGradient>
                        </defs>
                        <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#oc-wx-sel)" />
                        <circle cx="45" cy="35" r="6" fill="#050810" />
                        <circle cx="75" cy="35" r="6" fill="#050810" />
                      </svg>
                      OpenClaw
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
              {t('home.imChannel.wechat.setup.warning',
                '建议使用小号微信登录。ilink 是微信官方机器人接口,正常使用风险较低但请知悉。登录后可在 IM 通道页面更改 AI 后端。')}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={phase === 'confirming'}
          >
            {t('common.close', '关闭')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};


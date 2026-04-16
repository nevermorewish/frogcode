/**
 * QQ Setup Dialog — add/edit QQ bot credentials (Official QQ Bot API).
 * Saves to im-channels.json with platform: 'qq'.
 */
import React, { useState } from 'react';
import { ExternalLink, Loader2, AlertCircle, Terminal, CircleOff } from 'lucide-react';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
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

const QQ_DEVELOPER_URL = 'https://q.qq.com';
const QQ_TUTORIAL_URL = 'https://bot.q.qq.com/wiki/';

const QQIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path fill="#12B7F5" d="M24 4C15.2 4 10 10.5 10 18.5c0 2.6.5 5 1.4 7-.9 1.4-2.4 4-2.4 5.5 0 1 .6 1.2 1.4.6l2.3-1.9c1 1 2.4 2 4 2.7-.5 1-1 2-1 3 0 2.4 1.8 3.6 5.5 3.6h5.6c3.7 0 5.5-1.2 5.5-3.6 0-1-.5-2-1-3 1.6-.7 3-1.7 4-2.7l2.3 1.9c.8.6 1.4.4 1.4-.6 0-1.5-1.5-4.1-2.4-5.5.9-2 1.4-4.4 1.4-7C38 10.5 32.8 4 24 4z" />
    <circle fill="white" cx="18" cy="18" r="3" />
    <circle fill="white" cx="30" cy="18" r="3" />
    <circle fill="#12B7F5" cx="18" cy="18" r="1.5" />
    <circle fill="#12B7F5" cx="30" cy="18" r="1.5" />
  </svg>
);

interface QQSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
}

export const QQSetupDialog: React.FC<QQSetupDialogProps> = ({
  open,
  onOpenChange,
  onConnected,
}) => {
  const { t } = useTranslation();
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [label, setLabel] = useState('');
  const [sandbox, setSandbox] = useState(false);
  const [assignment, setAssignment] = useState<AgentAssignment>('none');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    const trimmedId = appId.trim();
    const trimmedSecret = appSecret.trim();
    if (!trimmedId || !trimmedSecret) {
      setError(t('home.imChannel.qq.setup.errorMissing', '请填写 App ID 和 App Secret'));
      return;
    }
    setSaving(true);
    try {
      const data = await api.getImChannels().catch(() => ({
        channels: [] as IMChannelConfig[],
        suppressedAppIds: [] as string[],
      }));
      const channels: IMChannelConfig[] = [...data.channels];
      const suppressedAppIds = data.suppressedAppIds.filter(id => id !== trimmedId);

      const existing = channels.find(ch => ch.appId === trimmedId && ch.platform === 'qq');
      if (existing) {
        existing.appSecret = trimmedSecret;
        existing.label = label.trim();
        existing.assignment = assignment;
        existing.sandbox = sandbox;
      } else {
        channels.push({
          id: `qq-${trimmedId}`,
          platform: 'qq',
          appId: trimmedId,
          appSecret: trimmedSecret,
          label: label.trim(),
          assignment,
          sandbox,
        });
      }

      // Each agent can only have one channel — unassign others
      if (assignment !== 'none') {
        for (const ch of channels) {
          if (ch.id !== (existing?.id || `qq-${trimmedId}`) && ch.assignment === assignment) {
            ch.assignment = 'none';
          }
        }
      }

      await api.saveImChannels({ channels, suppressedAppIds });

      setAppId('');
      setAppSecret('');
      setLabel('');
      setSandbox(false);
      setAssignment('none');
      onConnected?.();
      onOpenChange(false);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-white">
              <QQIcon className="h-6 w-6" />
            </div>
            <div>
              <DialogTitle className="text-base">
                {t('home.imChannel.qq.setup.connect', '添加 QQ 机器人')}
              </DialogTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {t('home.imChannel.qq.setup.configCredentials', '配置 QQ 官方机器人凭证')}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* Name (optional) */}
          <div>
            <label className="text-[12px] font-medium text-foreground">
              {t('home.imChannel.qq.setup.nameLabel', '名称')}
              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                ({t('common.optional', '可选')})
              </span>
            </label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('home.imChannel.qq.setup.namePlaceholder', '例如：项目助手、客服机器人')}
              className="mt-1.5 text-[12px]"
              autoComplete="off"
              disabled={saving}
            />
          </div>

          {/* App ID */}
          <div>
            <label className="text-[12px] font-medium text-foreground">
              App ID
            </label>
            <Input
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder="1020xxxxxx"
              className="mt-1.5 font-mono text-[12px]"
              autoComplete="off"
              disabled={saving}
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {t('home.imChannel.qq.setup.appIdHint', '从')}{' '}
              <button
                type="button"
                onClick={() => openUrl(QQ_DEVELOPER_URL)}
                className="text-primary hover:underline inline-flex items-center gap-0.5"
              >
                QQ 开放平台
                <ExternalLink className="h-2.5 w-2.5" />
              </button>{' '}
              {t('home.imChannel.qq.setup.pageGet', '获取')}
            </p>
          </div>

          {/* App Secret */}
          <div>
            <label className="text-[12px] font-medium text-foreground">
              App Secret
            </label>
            <Input
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="mt-1.5 font-mono text-[12px]"
              autoComplete="off"
              disabled={saving}
            />
          </div>

          {/* Sandbox toggle */}
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <label className="text-[12px] font-medium text-foreground">
                {t('home.imChannel.qq.setup.sandboxLabel', '沙箱模式')}
              </label>
              <p className="text-[11px] text-muted-foreground">
                {t('home.imChannel.qq.setup.sandboxHint', '使用 sandbox API 进行测试')}
              </p>
            </div>
            <Switch
              checked={sandbox}
              onCheckedChange={setSandbox}
              disabled={saving}
            />
          </div>

          {/* AI Backend */}
          <div>
            <label className="text-[12px] font-medium text-foreground">
              {t('home.imChannel.qq.setup.backendLabel', 'AI 后端')}
              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                ({t('common.optional', '可选')})
              </span>
            </label>
            <Select
              value={assignment}
              onValueChange={(v) => setAssignment(v as AgentAssignment)}
              disabled={saving}
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
                    <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5">
                      <defs>
                        <linearGradient id="oc-qq-sel" x1="0%" y1="0%" x2="100%" y2="100%">
                          <stop offset="0%" stopColor="#ff4d4d" />
                          <stop offset="100%" stopColor="#991b1b" />
                        </linearGradient>
                      </defs>
                      <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#oc-qq-sel)" />
                      <circle cx="45" cy="35" r="6" fill="#050810" />
                      <circle cx="75" cy="35" r="6" fill="#050810" />
                      <circle cx="46" cy="34" r="2.5" fill="#00e5cc" />
                      <circle cx="76" cy="34" r="2.5" fill="#00e5cc" />
                    </svg>
                    OpenClaw
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {t('home.imChannel.qq.setup.backendHint', '选择 AI 后端，也可以稍后在通道列表中更改')}
            </p>
          </div>

          <div className="text-[11px] text-muted-foreground">
            {t('home.imChannel.qq.setup.tutorialPrefix', '查看')}{' '}
            <button
              type="button"
              onClick={() => openUrl(QQ_TUTORIAL_URL)}
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              QQ 机器人接入文档
              <ExternalLink className="h-2.5 w-2.5" />
            </button>
            {' '}。{t('home.imChannel.qq.setup.groupNote', ' 群聊中机器人仅在被 @ 时响应。')}
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
                {t('common.saving', '保存中...')}
              </>
            ) : (
              t('common.save', '保存')
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

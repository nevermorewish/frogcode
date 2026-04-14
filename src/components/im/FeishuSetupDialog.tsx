/**
 * Feishu Setup Dialog — add/edit feishu bot credentials.
 * Saves to im-channels.json. Agent assignment is handled in IMChannelsView.
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

const FEISHU_CREDENTIALS_URL = 'https://open.feishu.cn/app';
const FEISHU_TUTORIAL_URL = 'https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process';

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

export const FeishuSetupDialog: React.FC<FeishuSetupDialogProps> = ({
  open,
  onOpenChange,
  onConnected,
}) => {
  const { t } = useTranslation();
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [label, setLabel] = useState('');
  const [assignment, setAssignment] = useState<AgentAssignment>('none');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    const trimmedId = appId.trim();
    const trimmedSecret = appSecret.trim();
    if (!trimmedId || !trimmedSecret) {
      setError(t('home.imChannel.feishu.setup.errorMissing', '请填写 App ID 和 App Secret'));
      return;
    }
    setSaving(true);
    try {
      // Load existing channels (normalized — always has channels + suppressedAppIds)
      const data = await api.getImChannels().catch(() => ({
        channels: [] as IMChannelConfig[],
        suppressedAppIds: [] as string[],
      }));
      const channels: IMChannelConfig[] = [...data.channels];

      // If the user had previously dismissed this appId, clear the
      // suppression — they're explicitly re-adding it now.
      const suppressedAppIds = data.suppressedAppIds.filter(id => id !== trimmedId);

      // Check if appId already exists
      const existing = channels.find(ch => ch.appId === trimmedId);
      if (existing) {
        // Update
        existing.appSecret = trimmedSecret;
        existing.label = label.trim();
        existing.assignment = assignment;
      } else {
        // Add new
        channels.push({
          id: `feishu-${trimmedId}`,
          platform: 'feishu',
          appId: trimmedId,
          appSecret: trimmedSecret,
          label: label.trim(),
          assignment,
        });
      }

      // Each agent can only have one channel — unassign others with the same agent
      if (assignment !== 'none') {
        for (const ch of channels) {
          if (ch.appId !== trimmedId && ch.assignment === assignment) {
            ch.assignment = 'none';
          }
        }
      }

      await api.saveImChannels({ channels, suppressedAppIds });

      // Reset form
      setAppId('');
      setAppSecret('');
      setLabel('');
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
              <FeishuIcon className="h-6 w-6" />
            </div>
            <div>
              <DialogTitle className="text-base">
                {t('home.imChannel.feishu.setup.connect', '添加飞书机器人')}
              </DialogTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {t('home.imChannel.feishu.setup.configCredentials', '配置 Bot 凭证')}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* Name (optional) */}
          <div>
            <label className="text-[12px] font-medium text-foreground">
              {t('home.imChannel.feishu.setup.nameLabel', '名称')}
              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                ({t('common.optional', '可选')})
              </span>
            </label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('home.imChannel.feishu.setup.namePlaceholder', '例如：项目助手、客服机器人')}
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
              placeholder="cli_xxxxxxxxxxxxxxxx"
              className="mt-1.5 font-mono text-[12px]"
              autoComplete="off"
              disabled={saving}
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {t('home.imChannel.feishu.setup.appIdHint', '从')}{' '}
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

          {/* AI Backend */}
          <div>
            <label className="text-[12px] font-medium text-foreground">
              {t('home.imChannel.feishu.setup.backendLabel', 'AI 后端')}
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
                        <linearGradient id="oc-sel" x1="0%" y1="0%" x2="100%" y2="100%">
                          <stop offset="0%" stopColor="#ff4d4d" />
                          <stop offset="100%" stopColor="#991b1b" />
                        </linearGradient>
                      </defs>
                      <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#oc-sel)" />
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
              {t('home.imChannel.feishu.setup.backendHint', '选择 AI 后端，也可以稍后在通道列表中更改')}
            </p>
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

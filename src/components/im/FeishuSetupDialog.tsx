/**
 * Feishu Setup Dialog — add/edit feishu bot credentials.
 * Saves to im-channels.json. Agent assignment is handled in IMChannelsView.
 */
import React, { useState } from 'react';
import { ExternalLink, Loader2, AlertCircle } from 'lucide-react';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, type IMChannelConfig } from '@/lib/api';
import { useTranslation } from 'react-i18next';

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
      // Load existing channels
      const data = await api.getImChannels().catch(() => ({ channels: [] as IMChannelConfig[] }));
      const channels: IMChannelConfig[] = data.channels || [];

      // Check if appId already exists
      const existing = channels.find(ch => ch.appId === trimmedId);
      if (existing) {
        // Update
        existing.appSecret = trimmedSecret;
        existing.label = label.trim();
      } else {
        // Add new
        channels.push({
          id: `feishu-${trimmedId}`,
          platform: 'feishu',
          appId: trimmedId,
          appSecret: trimmedSecret,
          label: label.trim(),
          assignment: 'none',
        });
      }

      await api.saveImChannels({ channels });

      // Reset form
      setAppId('');
      setAppSecret('');
      setLabel('');
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

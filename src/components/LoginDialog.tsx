import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth, type EngineId } from '@/contexts/AuthContext';
import { CheckCircle2 } from 'lucide-react';

const ENGINE_LABELS: Record<EngineId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  openclaw: 'OpenClaw',
};

interface LoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const LoginDialog: React.FC<LoginDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const { login, tokens, engineTokens } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loginSuccess, setLoginSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;

    setError('');
    setLoading(true);
    try {
      await login(username, password);
      setLoginSuccess(true);
    } catch (err) {
      setError(typeof err === 'string' ? err : (err as Error).message || t('loginFailed', 'Login failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    // Reset state after dialog close animation
    setTimeout(() => {
      setLoginSuccess(false);
      setUsername('');
      setPassword('');
      setError('');
    }, 200);
  };

  // Post-login: show auto-configured token summary per engine
  if (loginSuccess) {
    const engineEntries = Object.entries(engineTokens) as [EngineId, number][];
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-500" />
              {t('loginSuccess', 'Login Successful')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground">
              {t('home.frogclaw.autoConfigured', '已根据推荐分组为每个引擎自动配置令牌。')}
            </p>
            {engineEntries.length > 0 && (
              <div className="space-y-1.5 rounded-lg border border-border bg-background/50 px-3 py-2">
                {engineEntries.map(([engine, tokenId]) => {
                  const token = tokens.find(t => t.id === tokenId);
                  if (!token) return null;
                  return (
                    <div key={engine} className="flex items-center justify-between text-xs">
                      <span className="font-medium">{ENGINE_LABELS[engine] ?? engine}</span>
                      <span className="text-muted-foreground">
                        {token.name}
                        {token.group && (
                          <span className="ml-1.5 inline-flex items-center rounded bg-muted px-1 py-0.5 text-[10px]">
                            {token.group}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <Button onClick={handleClose} className="w-full" size="lg">
              {t('done', 'Done')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('sidebar.login', 'Sign In')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <Input
            type="text"
            placeholder={t('username', 'Username')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            inputSize="lg"
            autoFocus
            disabled={loading}
          />
          <Input
            type="password"
            placeholder={t('password', 'Password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            inputSize="lg"
            disabled={loading}
          />
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <Button
            type="submit"
            className="w-full"
            size="lg"
            disabled={loading || !username || !password}
          >
            {loading ? t('loggingIn', 'Signing in...') : t('sidebar.login', 'Sign In')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
};

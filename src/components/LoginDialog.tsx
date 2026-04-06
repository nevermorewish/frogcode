import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/contexts/AuthContext';
import { CheckCircle2 } from 'lucide-react';

interface LoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const LoginDialog: React.FC<LoginDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const { login, tokens, selectedTokenId, selectToken } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loginSuccess, setLoginSuccess] = useState(false);
  const [switchingToken, setSwitchingToken] = useState(false);

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

  const handleTokenSelect = async (tokenId: number) => {
    setSwitchingToken(true);
    try {
      await selectToken(tokenId);
    } catch (err) {
      console.error('Failed to switch token:', err);
    } finally {
      setSwitchingToken(false);
    }
  };

  // Post-login: show token selector if multiple tokens
  if (loginSuccess) {
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
            {tokens.length > 1 ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t('selectToken', 'Select an API token to use:')}
                </p>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {tokens.map((token) => (
                    <button
                      key={token.id}
                      onClick={() => handleTokenSelect(token.id)}
                      disabled={switchingToken}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-colors ${
                        selectedTokenId === token.id
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:border-primary/50 hover:bg-muted/50'
                      } ${switchingToken ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{token.name}</div>
                        <div className="text-xs text-muted-foreground">
                          sk-{token.key.slice(0, 6)}...{token.key.slice(-4)}
                          {token.unlimited_quota
                            ? ' | Unlimited'
                            : ` | ${(token.remain_quota / 500000).toFixed(2)}$`}
                        </div>
                      </div>
                      {selectedTokenId === token.id && (
                        <CheckCircle2 className="w-4 h-4 text-primary shrink-0 ml-2" />
                      )}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('providersConfigured', 'Providers have been auto-configured.')}
              </p>
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

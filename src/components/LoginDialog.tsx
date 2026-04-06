import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/contexts/AuthContext';

interface LoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const LoginDialog: React.FC<LoginDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;

    setError('');
    setLoading(true);
    try {
      await login(username, password);
      onOpenChange(false);
      setUsername('');
      setPassword('');
    } catch (err) {
      setError(typeof err === 'string' ? err : (err as Error).message || t('loginFailed', 'Login failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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

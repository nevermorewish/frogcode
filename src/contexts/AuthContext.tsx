import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { api, type FrogclawUserData } from '@/lib/api';

interface AuthContextType {
  user: FrogclawUserData | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const AUTH_CRED_KEY = 'frogclaw_auth_cred';
const AUTH_USER_KEY = 'frogclaw_auth_user';

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<FrogclawUserData | null>(() => {
    // Restore user from localStorage immediately (no loading state needed)
    const saved = localStorage.getItem(AUTH_USER_KEY);
    if (saved) {
      try { return JSON.parse(saved); } catch { return null; }
    }
    return null;
  });

  // Background re-verify saved credentials
  useEffect(() => {
    const cred = localStorage.getItem(AUTH_CRED_KEY);
    if (!cred) return;

    try {
      const { u, p } = JSON.parse(atob(cred));
      api.loginToFrogclaw(u, p)
        .then((userData) => {
          setUser(userData);
          localStorage.setItem(AUTH_USER_KEY, JSON.stringify(userData));
        })
        .catch(() => {
          // Credentials invalid, clear
          setUser(null);
          localStorage.removeItem(AUTH_CRED_KEY);
          localStorage.removeItem(AUTH_USER_KEY);
        });
    } catch {
      localStorage.removeItem(AUTH_CRED_KEY);
      localStorage.removeItem(AUTH_USER_KEY);
    }
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const userData = await api.loginToFrogclaw(username, password);
    setUser(userData);
    localStorage.setItem(AUTH_CRED_KEY, btoa(JSON.stringify({ u: username, p: password })));
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(userData));
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    localStorage.removeItem(AUTH_CRED_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated: !!user,
      login,
      logout,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

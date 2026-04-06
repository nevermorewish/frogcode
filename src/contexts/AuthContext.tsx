import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { api, type FrogclawUserData, type FrogclawToken, type FrogclawSystemProvider } from '@/lib/api';

interface AuthContextType {
  user: FrogclawUserData | null;
  isAuthenticated: boolean;
  tokens: FrogclawToken[];
  systemProviders: FrogclawSystemProvider[];
  selectedTokenId: number | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  selectToken: (tokenId: number) => Promise<void>;
  refreshProviders: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const AUTH_CRED_KEY = 'frogclaw_auth_cred';
const AUTH_USER_KEY = 'frogclaw_auth_user';
const AUTH_TOKENS_KEY = 'frogclaw_tokens';
const AUTH_SELECTED_TOKEN_KEY = 'frogclaw_selected_token';
const FROGCLAW_PROVIDER_PREFIX = 'frogclaw-';

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

// Map frogclaw provider_key to local provider type
const PROVIDER_KEY_MAP: Record<string, 'claude' | 'codex' | 'gemini'> = {
  'anthropic': 'claude',
  'claude': 'claude',
  'openai': 'codex',
  'google': 'gemini',
};

async function setupProviders(
  systemProviders: FrogclawSystemProvider[],
  token: FrogclawToken,
) {
  const apiKey = `sk-${token.key}`;
  const FROGCLAW_URL = 'https://frogclaw.com';
  const FROGCLAW_URL_V1 = 'https://frogclaw.com/v1';

  for (const sp of systemProviders) {
    const providerType = PROVIDER_KEY_MAP[sp.provider_key];
    if (!providerType) continue;

    const providerName = `${FROGCLAW_PROVIDER_PREFIX}${sp.name}`;

    try {
      if (providerType === 'claude') {
        const existing = await api.getProviderPresets();
        const found = existing.find(p => p.name === providerName);
        const config = {
          name: providerName,
          description: `Frogclaw - ${sp.name}`,
          base_url: FROGCLAW_URL,
          auth_token: '',
          api_key: apiKey,
          model: sp.default_model || undefined,
          enable_auto_api_key_helper: true,
        };
        if (found) {
          await api.updateProviderConfig({ ...found, ...config });
          await api.switchProviderConfig({ ...found, ...config });
        } else {
          const id = await api.addProviderConfig(config);
          await api.switchProviderConfig({ id, ...config });
        }
      } else if (providerType === 'codex') {
        const existing = await api.getCodexProviderPresets();
        const found = existing.find(p => p.name === providerName);
        const configToml = `model = "${sp.default_model || 'gpt-4.1'}"\nprovider = "openai"\nbase_url = "${FROGCLAW_URL_V1}"`;
        const config = {
          name: providerName,
          description: `Frogclaw - ${sp.name}`,
          category: 'third_party' as const,
          auth: { OPENAI_API_KEY: apiKey },
          config: configToml,
        };
        if (found) {
          await api.updateCodexProviderConfig({ ...found, ...config });
          await api.switchCodexProvider({ ...found, ...config });
        } else {
          const id = await api.addCodexProviderConfig(config);
          await api.switchCodexProvider({ id, ...config });
        }
      } else if (providerType === 'gemini') {
        const existing = await api.getGeminiProviderPresets();
        const found = existing.find(p => p.name === providerName);
        const env: Record<string, string> = {
          GEMINI_API_KEY: apiKey,
          GOOGLE_GEMINI_BASE_URL: FROGCLAW_URL,
        };
        if (sp.default_model) {
          env.GEMINI_MODEL = sp.default_model;
        }
        const config = {
          name: providerName,
          description: `Frogclaw - ${sp.name}`,
          category: 'third_party' as const,
          env,
        };
        if (found) {
          await api.updateGeminiProviderConfig({ ...found, ...config });
          await api.switchGeminiProvider({ ...found, ...config });
        } else {
          const id = await api.addGeminiProviderConfig(config);
          await api.switchGeminiProvider({ id, ...config });
        }
      }
    } catch (err) {
      console.error(`[Auth] Failed to setup ${providerType} provider:`, err);
    }
  }
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<FrogclawUserData | null>(() => {
    const saved = localStorage.getItem(AUTH_USER_KEY);
    if (saved) {
      try { return JSON.parse(saved); } catch { return null; }
    }
    return null;
  });

  const [tokens, setTokens] = useState<FrogclawToken[]>(() => {
    const saved = localStorage.getItem(AUTH_TOKENS_KEY);
    if (saved) {
      try { return JSON.parse(saved); } catch { return []; }
    }
    return [];
  });

  const [systemProviders, setSystemProviders] = useState<FrogclawSystemProvider[]>([]);

  const [selectedTokenId, setSelectedTokenId] = useState<number | null>(() => {
    const saved = localStorage.getItem(AUTH_SELECTED_TOKEN_KEY);
    if (saved) {
      try { return JSON.parse(saved); } catch { return null; }
    }
    return null;
  });

  // Background re-verify saved credentials & refresh tokens
  useEffect(() => {
    const cred = localStorage.getItem(AUTH_CRED_KEY);
    if (!cred) return;

    try {
      const { u, p } = JSON.parse(atob(cred));
      api.fetchFrogclawProviders(u, p)
        .then((session) => {
          setUser(session.user);
          setTokens(session.tokens);
          setSystemProviders(session.system_providers);
          localStorage.setItem(AUTH_USER_KEY, JSON.stringify(session.user));
          localStorage.setItem(AUTH_TOKENS_KEY, JSON.stringify(session.tokens));
        })
        .catch(() => {
          setUser(null);
          setTokens([]);
          localStorage.removeItem(AUTH_CRED_KEY);
          localStorage.removeItem(AUTH_USER_KEY);
          localStorage.removeItem(AUTH_TOKENS_KEY);
          localStorage.removeItem(AUTH_SELECTED_TOKEN_KEY);
        });
    } catch {
      localStorage.removeItem(AUTH_CRED_KEY);
      localStorage.removeItem(AUTH_USER_KEY);
    }
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    // Fetch user, tokens, and system providers in one call
    const session = await api.fetchFrogclawProviders(username, password);
    setUser(session.user);
    setTokens(session.tokens);
    setSystemProviders(session.system_providers);

    localStorage.setItem(AUTH_CRED_KEY, btoa(JSON.stringify({ u: username, p: password })));
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(session.user));
    localStorage.setItem(AUTH_TOKENS_KEY, JSON.stringify(session.tokens));

    // Auto-setup providers with first token
    if (session.tokens.length > 0) {
      const defaultToken = session.tokens[0];
      setSelectedTokenId(defaultToken.id);
      localStorage.setItem(AUTH_SELECTED_TOKEN_KEY, JSON.stringify(defaultToken.id));
      await setupProviders(session.system_providers, defaultToken);
    }
  }, []);

  const selectToken = useCallback(async (tokenId: number) => {
    const token = tokens.find(t => t.id === tokenId);
    if (!token) return;

    setSelectedTokenId(tokenId);
    localStorage.setItem(AUTH_SELECTED_TOKEN_KEY, JSON.stringify(tokenId));

    // Re-setup all providers with new token
    await setupProviders(systemProviders, token);
  }, [tokens, systemProviders]);

  const refreshProviders = useCallback(async () => {
    const cred = localStorage.getItem(AUTH_CRED_KEY);
    if (!cred) return;

    try {
      const { u, p } = JSON.parse(atob(cred));
      const session = await api.fetchFrogclawProviders(u, p);
      setTokens(session.tokens);
      setSystemProviders(session.system_providers);
      localStorage.setItem(AUTH_TOKENS_KEY, JSON.stringify(session.tokens));
    } catch (err) {
      console.error('[Auth] Failed to refresh providers:', err);
    }
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setTokens([]);
    setSystemProviders([]);
    setSelectedTokenId(null);
    localStorage.removeItem(AUTH_CRED_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem(AUTH_TOKENS_KEY);
    localStorage.removeItem(AUTH_SELECTED_TOKEN_KEY);
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated: !!user,
      tokens,
      systemProviders,
      selectedTokenId,
      login,
      logout,
      selectToken,
      refreshProviders,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

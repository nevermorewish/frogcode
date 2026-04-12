import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { api, type FrogclawUserData, type FrogclawToken, type FrogclawSystemProvider, type FrogclawCliProvider } from '@/lib/api';

export interface OpenClawModelInfo {
  id: string;
  name: string;
  provider: string;
}

interface AuthContextType {
  user: FrogclawUserData | null;
  isAuthenticated: boolean;
  tokens: FrogclawToken[];
  systemProviders: FrogclawSystemProvider[];
  selectedTokenId: number | null;
  openclawModels: OpenClawModelInfo[];
  feishuAppId: string | null;
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
const AUTH_OPENCLAW_MODELS_KEY = 'frogclaw_openclaw_models';
const AUTH_FEISHU_APPID_KEY = 'frogclaw_feishu_appid';
const FROGCLAW_PROVIDER_PREFIX = 'frogclaw-';

function extractOpenclawInfo(cliProviders: FrogclawCliProvider[]): {
  models: OpenClawModelInfo[];
  feishuAppId: string | null;
  configJson: string | null;
} {
  const openclawProviders = cliProviders.filter(p => p.provider_type === 'openclaw');
  if (openclawProviders.length === 0) {
    return { models: [], feishuAppId: null, configJson: null };
  }

  // Pick the default one, or fall back to latest by updated_time
  let chosen = openclawProviders.find(p => p.is_default);
  if (!chosen) {
    chosen = openclawProviders.sort((a, b) => (b.updated_time ?? 0) - (a.updated_time ?? 0))[0];
  }

  if (!chosen.settings_config) {
    return { models: [], feishuAppId: null, configJson: null };
  }

  let config: Record<string, any>;
  try {
    config = JSON.parse(chosen.settings_config);
  } catch {
    return { models: [], feishuAppId: null, configJson: null };
  }

  // Extract models from config.models.providers
  const models: OpenClawModelInfo[] = [];
  const providers = config?.models?.providers;
  if (providers && typeof providers === 'object') {
    for (const [providerName, providerData] of Object.entries(providers)) {
      const pd = providerData as any;
      if (Array.isArray(pd?.models)) {
        for (const m of pd.models) {
          if (m?.id) {
            models.push({
              id: m.id,
              name: m.name || m.id,
              provider: providerName,
            });
          }
        }
      }
    }
  }

  const feishuAppId = config?.channels?.feishu?.appId || null;

  return { models, feishuAppId, configJson: chosen.settings_config };
}

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

/** Process openclaw info from a login session and persist to state + disk */
function applyOpenclawInfo(
  session: { cli_providers?: FrogclawCliProvider[] },
  setOpenclawModels: (m: OpenClawModelInfo[]) => void,
  setFeishuAppId: (id: string | null) => void,
) {
  const ocInfo = extractOpenclawInfo(session.cli_providers || []);
  setOpenclawModels(ocInfo.models);
  setFeishuAppId(ocInfo.feishuAppId);
  localStorage.setItem(AUTH_OPENCLAW_MODELS_KEY, JSON.stringify(ocInfo.models));
  if (ocInfo.feishuAppId) {
    localStorage.setItem(AUTH_FEISHU_APPID_KEY, ocInfo.feishuAppId);
  } else {
    localStorage.removeItem(AUTH_FEISHU_APPID_KEY);
  }
  // Write config to disk (Rust side also logs to system log)
  if (ocInfo.configJson) {
    api.applyOpenclawConfig(ocInfo.configJson).catch(() => {});
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

  const [openclawModels, setOpenclawModels] = useState<OpenClawModelInfo[]>(() => {
    const saved = localStorage.getItem(AUTH_OPENCLAW_MODELS_KEY);
    if (saved) {
      try { return JSON.parse(saved); } catch { return []; }
    }
    return [];
  });

  const [feishuAppId, setFeishuAppId] = useState<string | null>(() => {
    return localStorage.getItem(AUTH_FEISHU_APPID_KEY) || null;
  });

  const [selectedTokenId, setSelectedTokenId] = useState<number | null>(() => {
    const saved = localStorage.getItem(AUTH_SELECTED_TOKEN_KEY);
    if (saved) {
      try { return JSON.parse(saved); } catch { return null; }
    }
    return null;
  });

  // On every startup: if credentials exist, re-verify and fetch openclaw config
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

          // Always fetch and apply openclaw config on startup
          applyOpenclawInfo(session, setOpenclawModels, setFeishuAppId);
        })
        .catch(() => {
          setUser(null);
          setTokens([]);
          localStorage.removeItem(AUTH_CRED_KEY);
          localStorage.removeItem(AUTH_USER_KEY);
          localStorage.removeItem(AUTH_TOKENS_KEY);
          localStorage.removeItem(AUTH_SELECTED_TOKEN_KEY);
          localStorage.removeItem(AUTH_OPENCLAW_MODELS_KEY);
          localStorage.removeItem(AUTH_FEISHU_APPID_KEY);
        });
    } catch {
      localStorage.removeItem(AUTH_CRED_KEY);
      localStorage.removeItem(AUTH_USER_KEY);
    }
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const session = await api.fetchFrogclawProviders(username, password);
    setUser(session.user);
    setTokens(session.tokens);
    setSystemProviders(session.system_providers);

    localStorage.setItem(AUTH_CRED_KEY, btoa(JSON.stringify({ u: username, p: password })));
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(session.user));
    localStorage.setItem(AUTH_TOKENS_KEY, JSON.stringify(session.tokens));

    // Fetch and apply openclaw config
    applyOpenclawInfo(session, setOpenclawModels, setFeishuAppId);

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

      // Also refresh openclaw config
      applyOpenclawInfo(session, setOpenclawModels, setFeishuAppId);
    } catch {
      // silently ignore
    }
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setTokens([]);
    setSystemProviders([]);
    setSelectedTokenId(null);
    setOpenclawModels([]);
    setFeishuAppId(null);
    localStorage.removeItem(AUTH_CRED_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem(AUTH_TOKENS_KEY);
    localStorage.removeItem(AUTH_SELECTED_TOKEN_KEY);
    localStorage.removeItem(AUTH_OPENCLAW_MODELS_KEY);
    localStorage.removeItem(AUTH_FEISHU_APPID_KEY);
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated: !!user,
      tokens,
      systemProviders,
      selectedTokenId,
      openclawModels,
      feishuAppId,
      login,
      logout,
      selectToken,
      refreshProviders,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

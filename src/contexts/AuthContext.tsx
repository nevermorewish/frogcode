import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { api, type FrogclawUserData, type FrogclawToken, type FrogclawSystemProvider, type FrogclawCliProvider, normalizeImChannelsData } from '@/lib/api';

export interface OpenClawModelInfo {
  id: string;
  name: string;
  provider: string;
}

export type EngineId = 'claude' | 'codex' | 'gemini' | 'openclaw';
export type EngineTokenMap = Partial<Record<EngineId, number>>;

interface AuthContextType {
  user: FrogclawUserData | null;
  isAuthenticated: boolean;
  tokens: FrogclawToken[];
  systemProviders: FrogclawSystemProvider[];
  engineTokens: EngineTokenMap;
  selectedTokenId: number | null;
  openclawModels: OpenClawModelInfo[];
  feishuAppId: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  dismissFeishuAppId: (appId: string) => Promise<void>;
  selectToken: (tokenId: number) => Promise<void>;
  selectEngineToken: (engine: EngineId, tokenId: number) => Promise<void>;
  refreshProviders: () => Promise<void>;
  getRecommendedGroup: (engine: EngineId) => string | null;
  ensureGroupToken: (group: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const AUTH_CRED_KEY = 'frogclaw_auth_cred';
const AUTH_USER_KEY = 'frogclaw_auth_user';
const AUTH_TOKENS_KEY = 'frogclaw_tokens';
const AUTH_SELECTED_TOKEN_KEY = 'frogclaw_selected_token'; // legacy, for migration
const AUTH_ENGINE_TOKENS_KEY = 'frogclaw_engine_tokens';
const AUTH_OPENCLAW_MODELS_KEY = 'frogclaw_openclaw_models';
const AUTH_FEISHU_APPID_KEY = 'frogclaw_feishu_appid';
const FROGCLAW_PROVIDER_PREFIX = 'frogclaw-';
const CLAUDE_MAX_GROUP = 'claude max';
const OPENCLAW_GROUP = 'default';
const CLAUDE_MAX_ONLY_KEY = 'claude_code_max_only';

function getClaudeMaxOnly(): boolean {
  try {
    const raw = localStorage.getItem(CLAUDE_MAX_ONLY_KEY);
    if (raw === null) return true;
    return raw === 'true';
  } catch {
    return true;
  }
}

function extractOpenclawInfo(cliProviders: FrogclawCliProvider[]): {
  models: OpenClawModelInfo[];
  feishuAppId: string | null;
  feishuAppSecret: string | null;
  configJson: string | null;
} {
  const openclawProviders = cliProviders.filter(p => p.provider_type === 'openclaw');
  if (openclawProviders.length === 0) {
    return { models: [], feishuAppId: null, feishuAppSecret: null, configJson: null };
  }

  // Pick the default one, or fall back to latest by updated_time
  let chosen = openclawProviders.find(p => p.is_default);
  if (!chosen) {
    chosen = openclawProviders.sort((a, b) => (b.updated_time ?? 0) - (a.updated_time ?? 0))[0];
  }

  if (!chosen.settings_config) {
    return { models: [], feishuAppId: null, feishuAppSecret: null, configJson: null };
  }

  let config: Record<string, any>;
  try {
    config = JSON.parse(chosen.settings_config);
  } catch {
    return { models: [], feishuAppId: null, feishuAppSecret: null, configJson: null };
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
  const feishuAppSecret = config?.channels?.feishu?.appSecret || null;

  return { models, feishuAppId, feishuAppSecret, configJson: chosen.settings_config };
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
const PROVIDER_KEY_MAP: Record<string, EngineId> = {
  'anthropic': 'claude',
  'claude': 'claude',
  'openai': 'codex',
  'google': 'gemini',
};

/** Get the recommended token group for an engine from system providers */
function getRecommendedGroupFromProviders(
  engine: EngineId,
  systemProviders: FrogclawSystemProvider[],
): string | null {
  for (const sp of systemProviders) {
    if (PROVIDER_KEY_MAP[sp.provider_key] === engine && sp.token_group) {
      return sp.token_group;
    }
  }
  if (engine === 'openclaw') return 'default';
  return null;
}

/** Auto-select the best token per engine based on group matching */
function autoSelectTokens(
  tokens: FrogclawToken[],
  systemProviders: FrogclawSystemProvider[],
  cliProviders: FrogclawCliProvider[],
): EngineTokenMap {
  if (tokens.length === 0) return {};

  const result: EngineTokenMap = {};
  const engines: EngineId[] = ['claude', 'codex', 'gemini'];
  const claudeMaxOnly = getClaudeMaxOnly();

  for (const engine of engines) {
    const hasProvider = systemProviders.some(sp => PROVIDER_KEY_MAP[sp.provider_key] === engine);
    if (!hasProvider) continue;

    // Claude Code is hard-restricted to the claude max group when the toggle is on.
    if (engine === 'claude' && claudeMaxOnly) {
      const match = tokens.find(t => t.group === CLAUDE_MAX_GROUP);
      if (match) {
        result[engine] = match.id;
      }
      continue;
    }

    const recommendedGroup = getRecommendedGroupFromProviders(engine, systemProviders);
    if (recommendedGroup) {
      const match = tokens.find(t => t.group === recommendedGroup);
      if (match) {
        result[engine] = match.id;
        continue;
      }
    }
    result[engine] = tokens[0].id;
  }

  // OpenClaw is locked to the default group.
  const hasOpenclaw = cliProviders.some(p => p.provider_type === 'openclaw');
  if (hasOpenclaw) {
    const match = tokens.find(t => t.group === OPENCLAW_GROUP || t.group === '');
    if (match) {
      result.openclaw = match.id;
    }
  }

  return result;
}

/** Determine which token groups must exist but currently have no token. */
function findMissingGroups(
  tokens: FrogclawToken[],
  cliProviders: FrogclawCliProvider[],
  systemProviders: FrogclawSystemProvider[],
): string[] {
  const missing = new Set<string>();
  const claudeMaxOnly = getClaudeMaxOnly();

  const hasOpenclaw = cliProviders.some(p => p.provider_type === 'openclaw');
  if (hasOpenclaw && !tokens.some(t => t.group === OPENCLAW_GROUP || t.group === '')) {
    missing.add(OPENCLAW_GROUP);
  }

  const hasClaudeProvider = systemProviders.some(
    sp => PROVIDER_KEY_MAP[sp.provider_key] === 'claude',
  );
  if (claudeMaxOnly && hasClaudeProvider && !tokens.some(t => t.group === CLAUDE_MAX_GROUP)) {
    missing.add(CLAUDE_MAX_GROUP);
  }

  return Array.from(missing);
}

async function setupProviders(
  systemProviders: FrogclawSystemProvider[],
  allTokens: FrogclawToken[],
  engineTokens: EngineTokenMap,
) {
  const FROGCLAW_URL = 'https://frogclaw.com';
  const FROGCLAW_URL_V1 = 'https://frogclaw.com/v1';

  for (const sp of systemProviders) {
    const providerType = PROVIDER_KEY_MAP[sp.provider_key];
    if (!providerType) continue;

    // Look up the token assigned to this engine
    const tokenId = engineTokens[providerType];
    if (!tokenId) continue;
    const token = allTokens.find(t => t.id === tokenId);
    if (!token) continue;

    const apiKey = `sk-${token.key}`;
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

  // Auto-provision Feishu credentials into IM channels + agent config
  if (ocInfo.feishuAppId && ocInfo.feishuAppSecret) {
    syncFeishuToImChannels(ocInfo.feishuAppId, ocInfo.feishuAppSecret).catch((e) =>
      console.error('[Auth] Failed to sync Feishu creds to IM channels:', e),
    );
  }
}

/**
 * Ensure the Feishu appId/appSecret from the openclaw server config are
 * present in im-channels.json, assigned to "openclaw", and written into
 * the per-agent config + platform root config so the sidecar picks them up.
 */
async function syncFeishuToImChannels(appId: string, appSecret: string) {
  // 1. Read existing IM channels (normalized — always has channels + suppressedAppIds)
  const data = await api.getImChannels().catch(() => normalizeImChannelsData());
  const { channels, suppressedAppIds } = data;

  // If the user has explicitly dismissed this appId, respect that and do
  // nothing. Otherwise every login/refresh would re-add the channel and
  // re-enable the sidecar, making deletion impossible.
  if (suppressedAppIds.includes(appId)) {
    return;
  }

  // 2. Check if this appId already exists
  const existing = channels.find((ch) => ch.appId === appId);
  if (existing) {
    // Already present — only refresh the secret if the server rotated it.
    // DO NOT touch `assignment`: the user may have deliberately set this
    // channel to 'none' or 'claudecode', and re-clobbering it on every
    // login/refresh would make that choice impossible to persist.
    if (existing.appSecret !== appSecret) {
      existing.appSecret = appSecret;
      await api.saveImChannels({ channels, suppressedAppIds });
    }
  } else {
    // Unassign any existing openclaw channel
    for (const ch of channels) {
      if (ch.assignment === 'openclaw') ch.assignment = 'none';
    }
    // Add new channel
    channels.push({
      id: `openclaw-${appId}`,
      platform: 'feishu',
      appId,
      appSecret,
      label: 'Frogclaw',
      assignment: 'openclaw',
    });
    await api.saveImChannels({ channels, suppressedAppIds });
  }

  // 3. Write creds into agent config + platform root config
  const agentCfg = await api.platform.getAgentConfig('openclaw').catch(() => ({})) as any;
  await api.platform.saveAgentConfig('openclaw', {
    ...agentCfg,
    feishu: { appId, appSecret },
  });

  const platformCfg = await api.platform.getConfig().catch(() => ({
    appId: '', appSecret: '', projectPath: '', enabled: false,
  })) as any;
  await api.platform.saveConfig({
    ...platformCfg,
    appId,
    appSecret,
    agentType: 'openclaw',
    enabled: true,
  });

  // 4. Restart sidecar to pick up new creds
  try { await api.platform.stop(); } catch { /* ignore */ }
  await api.platform.start();
  try { await api.platform.connectFeishu(); } catch { /* ignore */ }
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

  const [engineTokens, setEngineTokens] = useState<EngineTokenMap>(() => {
    // Try new per-engine format first
    const saved = localStorage.getItem(AUTH_ENGINE_TOKENS_KEY);
    if (saved) {
      try { return JSON.parse(saved); } catch { /* fall through */ }
    }
    // Migration: try old single-token format
    const oldSaved = localStorage.getItem(AUTH_SELECTED_TOKEN_KEY);
    if (oldSaved) {
      try {
        const oldId = JSON.parse(oldSaved);
        if (typeof oldId === 'number') {
          const migrated: EngineTokenMap = {
            claude: oldId, codex: oldId, gemini: oldId, openclaw: oldId,
          };
          localStorage.setItem(AUTH_ENGINE_TOKENS_KEY, JSON.stringify(migrated));
          localStorage.removeItem(AUTH_SELECTED_TOKEN_KEY);
          return migrated;
        }
      } catch { /* fall through */ }
    }
    return {};
  });

  // Derived for backward compatibility
  const selectedTokenId = engineTokens.claude ?? null;

  // On every startup: if credentials exist, re-verify and fetch openclaw config
  useEffect(() => {
    const cred = localStorage.getItem(AUTH_CRED_KEY);
    if (!cred) return;

    try {
      const { u, p } = JSON.parse(atob(cred));
      api.fetchFrogclawProviders(u, p)
        .then(async (initialSession) => {
          // Auto-provision missing required groups before applying state.
          let session = initialSession;
          const missing = findMissingGroups(
            session.tokens, session.cli_providers, session.system_providers,
          );
          for (const group of missing) {
            try {
              session = await api.ensureFrogclawGroupToken(u, p, group);
            } catch (err) {
              console.error(`[Auth] startup ensureFrogclawGroupToken(${group}) failed:`, err);
            }
          }

          setUser(session.user);
          setTokens(session.tokens);
          setSystemProviders(session.system_providers);
          localStorage.setItem(AUTH_USER_KEY, JSON.stringify(session.user));
          localStorage.setItem(AUTH_TOKENS_KEY, JSON.stringify(session.tokens));

          // Always fetch and apply openclaw config on startup
          applyOpenclawInfo(session, setOpenclawModels, setFeishuAppId);

          // Restore engine tokens from localStorage, validate they still exist
          const savedET = localStorage.getItem(AUTH_ENGINE_TOKENS_KEY);
          if (savedET) {
            try {
              const parsed: EngineTokenMap = JSON.parse(savedET);
              // Validate that referenced tokens still exist
              const validTokenIds = new Set(session.tokens.map(t => t.id));
              const validated: EngineTokenMap = {};
              for (const [engine, tokenId] of Object.entries(parsed)) {
                if (tokenId && validTokenIds.has(tokenId)) {
                  validated[engine as EngineId] = tokenId;
                }
              }
              // Fill missing engines via auto-select
              const autoSelected = autoSelectTokens(session.tokens, session.system_providers, session.cli_providers);
              const merged = { ...autoSelected, ...validated };
              setEngineTokens(merged);
              localStorage.setItem(AUTH_ENGINE_TOKENS_KEY, JSON.stringify(merged));
              setupProviders(session.system_providers, session.tokens, merged);
            } catch {
              // Fallback: auto-select all
              const autoSelected = autoSelectTokens(session.tokens, session.system_providers, session.cli_providers);
              setEngineTokens(autoSelected);
              localStorage.setItem(AUTH_ENGINE_TOKENS_KEY, JSON.stringify(autoSelected));
              setupProviders(session.system_providers, session.tokens, autoSelected);
            }
          }
        })
        .catch(() => {
          setUser(null);
          setTokens([]);
          localStorage.removeItem(AUTH_CRED_KEY);
          localStorage.removeItem(AUTH_USER_KEY);
          localStorage.removeItem(AUTH_TOKENS_KEY);
          localStorage.removeItem(AUTH_SELECTED_TOKEN_KEY);
          localStorage.removeItem(AUTH_ENGINE_TOKENS_KEY);
          localStorage.removeItem(AUTH_OPENCLAW_MODELS_KEY);
          localStorage.removeItem(AUTH_FEISHU_APPID_KEY);
        });
    } catch {
      localStorage.removeItem(AUTH_CRED_KEY);
      localStorage.removeItem(AUTH_USER_KEY);
    }
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    let session = await api.fetchFrogclawProviders(username, password);

    localStorage.setItem(AUTH_CRED_KEY, btoa(JSON.stringify({ u: username, p: password })));

    // Auto-provision missing required groups (openclaw=default, claude=claude max).
    const missing = findMissingGroups(
      session.tokens, session.cli_providers, session.system_providers,
    );
    for (const group of missing) {
      try {
        session = await api.ensureFrogclawGroupToken(username, password, group);
      } catch (err) {
        console.error(`[Auth] ensureFrogclawGroupToken(${group}) failed:`, err);
      }
    }

    setUser(session.user);
    setTokens(session.tokens);
    setSystemProviders(session.system_providers);

    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(session.user));
    localStorage.setItem(AUTH_TOKENS_KEY, JSON.stringify(session.tokens));

    // Fetch and apply openclaw config
    applyOpenclawInfo(session, setOpenclawModels, setFeishuAppId);

    // Auto-setup providers with best token per engine
    if (session.tokens.length > 0) {
      const autoTokens = autoSelectTokens(
        session.tokens, session.system_providers, session.cli_providers,
      );
      setEngineTokens(autoTokens);
      localStorage.setItem(AUTH_ENGINE_TOKENS_KEY, JSON.stringify(autoTokens));
      await setupProviders(session.system_providers, session.tokens, autoTokens);
    }
  }, []);

  /** Ensure a given token group has at least one active token on the server. */
  const ensureGroupToken = useCallback(async (group: string) => {
    const cred = localStorage.getItem(AUTH_CRED_KEY);
    if (!cred) return;
    let u: string, p: string;
    try {
      const parsed = JSON.parse(atob(cred));
      u = parsed.u; p = parsed.p;
    } catch {
      return;
    }

    try {
      const session = await api.ensureFrogclawGroupToken(u, p, group);
      setTokens(session.tokens);
      setSystemProviders(session.system_providers);
      localStorage.setItem(AUTH_TOKENS_KEY, JSON.stringify(session.tokens));

      const autoTokens = autoSelectTokens(
        session.tokens, session.system_providers, session.cli_providers,
      );
      // Merge: keep any explicit user choices that still reference valid tokens.
      const validIds = new Set(session.tokens.map(t => t.id));
      const preserved: EngineTokenMap = {};
      for (const [engine, tokenId] of Object.entries(engineTokens)) {
        if (tokenId && validIds.has(tokenId)) {
          preserved[engine as EngineId] = tokenId;
        }
      }
      const merged = { ...autoTokens, ...preserved };
      setEngineTokens(merged);
      localStorage.setItem(AUTH_ENGINE_TOKENS_KEY, JSON.stringify(merged));
      await setupProviders(session.system_providers, session.tokens, merged);
    } catch (err) {
      console.error(`[Auth] ensureGroupToken(${group}) failed:`, err);
    }
  }, [engineTokens]);

  /** Switch a single engine's token */
  const selectEngineToken = useCallback(async (engine: EngineId, tokenId: number) => {
    const token = tokens.find(t => t.id === tokenId);
    if (!token) return;

    const updated = { ...engineTokens, [engine]: tokenId };
    setEngineTokens(updated);
    localStorage.setItem(AUTH_ENGINE_TOKENS_KEY, JSON.stringify(updated));

    // OpenClaw token is informational only (config comes from server)
    if (engine === 'openclaw') return;

    // Re-setup only the affected engine's providers
    const relevantProviders = systemProviders.filter(sp =>
      PROVIDER_KEY_MAP[sp.provider_key] === engine,
    );
    if (relevantProviders.length > 0) {
      await setupProviders(relevantProviders, tokens, updated);
    }
  }, [tokens, systemProviders, engineTokens]);

  /** Switch ALL engines to the same token (backward compat, used by sidebar) */
  const selectToken = useCallback(async (tokenId: number) => {
    const token = tokens.find(t => t.id === tokenId);
    if (!token) return;

    const updated: EngineTokenMap = {};
    // Assign to all engines that have providers
    for (const sp of systemProviders) {
      const engine = PROVIDER_KEY_MAP[sp.provider_key];
      if (engine) updated[engine] = tokenId;
    }
    if (openclawModels.length > 0) {
      updated.openclaw = tokenId;
    }

    setEngineTokens(updated);
    localStorage.setItem(AUTH_ENGINE_TOKENS_KEY, JSON.stringify(updated));
    await setupProviders(systemProviders, tokens, updated);
  }, [tokens, systemProviders, openclawModels]);

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
    setEngineTokens({});
    setOpenclawModels([]);
    setFeishuAppId(null);
    localStorage.removeItem(AUTH_CRED_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem(AUTH_TOKENS_KEY);
    localStorage.removeItem(AUTH_SELECTED_TOKEN_KEY);
    localStorage.removeItem(AUTH_ENGINE_TOKENS_KEY);
    localStorage.removeItem(AUTH_OPENCLAW_MODELS_KEY);
    localStorage.removeItem(AUTH_FEISHU_APPID_KEY);
  }, []);

  const getRecommendedGroup = useCallback((engine: EngineId) => {
    return getRecommendedGroupFromProviders(engine, systemProviders);
  }, [systemProviders]);

  /**
   * Mark a server-provided Feishu appId as dismissed so that
   * syncFeishuToImChannels / IMChannelsView no longer auto-re-add it.
   * Also removes the matching channel from im-channels.json and clears
   * any cached feishuAppId state/localStorage so the UI doesn't keep
   * showing the stale server badge.
   */
  const dismissFeishuAppId = useCallback(async (appId: string) => {
    if (!appId) return;
    try {
      const data = await api.getImChannels().catch(() => normalizeImChannelsData());
      const channels = data.channels.filter((ch) => ch.appId !== appId);
      const suppressedAppIds = Array.from(new Set([...data.suppressedAppIds, appId]));
      await api.saveImChannels({ channels, suppressedAppIds });
    } catch (e) {
      console.error('[Auth] dismissFeishuAppId: failed to update im-channels.json:', e);
    }

    if (feishuAppId === appId) {
      setFeishuAppId(null);
      localStorage.removeItem(AUTH_FEISHU_APPID_KEY);
    }
  }, [feishuAppId]);

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated: !!user,
      tokens,
      systemProviders,
      engineTokens,
      selectedTokenId,
      openclawModels,
      feishuAppId,
      login,
      logout,
      dismissFeishuAppId,
      selectToken,
      selectEngineToken,
      refreshProviders,
      getRecommendedGroup,
      ensureGroupToken,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

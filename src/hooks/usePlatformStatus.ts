import { useEffect, useState } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { api } from '@/lib/api';

export type PlatformStatusValue = 'stopped' | 'starting' | 'running' | 'error';
export type FeishuStatusValue = 'stopped' | 'starting' | 'running' | 'error' | null;

export interface PlatformStatusState {
  status: PlatformStatusValue;
  feishuStatus: FeishuStatusValue;
  port: number | null;
  error: string | null;
}

const DEFAULT: PlatformStatusState = {
  status: 'stopped',
  feishuStatus: null,
  port: null,
  error: null,
};

/**
 * Subscribes to platform bridge status events from the Rust backend.
 * The sidecar pushes status via SSE → Rust → Tauri event `platform:status`.
 */
export function usePlatformStatus(): PlatformStatusState {
  const [state, setState] = useState<PlatformStatusState>(DEFAULT);

  useEffect(() => {
    let mounted = true;
    let unlistenStatus: UnlistenFn | null = null;

    // initial snapshot
    api.platform
      .status()
      .then((s) => {
        if (!mounted) return;
        setState({
          status: (s.status as PlatformStatusValue) || 'stopped',
          feishuStatus: (s.feishuStatus as FeishuStatusValue) || null,
          port: s.port,
          error: s.error,
        });
      })
      .catch((e) => {
        if (mounted) setState((prev) => ({ ...prev, error: String(e) }));
      });

    // SSE-relayed status events
    listen<any>('platform:status', (evt) => {
      const payload = evt.payload || {};
      const feishu = payload.feishu || {};
      setState((prev) => ({
        ...prev,
        feishuStatus: (feishu.status as FeishuStatusValue) || prev.feishuStatus,
        error: feishu.error ?? prev.error,
      }));
    }).then((un) => {
      if (!mounted) {
        un();
      } else {
        unlistenStatus = un;
      }
    });

    return () => {
      mounted = false;
      if (unlistenStatus) unlistenStatus();
    };
  }, []);

  return state;
}

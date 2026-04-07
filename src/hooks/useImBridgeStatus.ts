import { useEffect, useState } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { api } from '@/lib/api';

export type ImBridgeStatusValue = 'stopped' | 'starting' | 'running' | 'error';
export type FeishuStatusValue = 'stopped' | 'starting' | 'running' | 'error' | null;

export interface ImBridgeStatusState {
  status: ImBridgeStatusValue;
  feishuStatus: FeishuStatusValue;
  port: number | null;
  error: string | null;
}

const DEFAULT: ImBridgeStatusState = {
  status: 'stopped',
  feishuStatus: null,
  port: null,
  error: null,
};

/**
 * Subscribes to IM bridge status events from the Rust backend.
 * The sidecar pushes status via SSE → Rust → Tauri event `im-bridge:status`.
 */
export function useImBridgeStatus(): ImBridgeStatusState {
  const [state, setState] = useState<ImBridgeStatusState>(DEFAULT);

  useEffect(() => {
    let mounted = true;
    let unlistenStatus: UnlistenFn | null = null;

    // initial snapshot
    api.imBridge
      .status()
      .then((s) => {
        if (!mounted) return;
        setState({
          status: (s.status as ImBridgeStatusValue) || 'stopped',
          feishuStatus: (s.feishuStatus as FeishuStatusValue) || null,
          port: s.port,
          error: s.error,
        });
      })
      .catch((e) => {
        if (mounted) setState((prev) => ({ ...prev, error: String(e) }));
      });

    // SSE-relayed status events
    listen<any>('im-bridge:status', (evt) => {
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

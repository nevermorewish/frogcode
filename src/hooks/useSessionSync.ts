import { useEffect, useRef } from 'react';
import { useTabs } from './useTabs';
import { compatListen as listen } from '@/lib/apiAdapter';
import { api } from '@/lib/api';

/**
 * useSessionSync - Hybrid session state sync (event-driven + fallback polling)
 *
 * Three-layer approach for reliable tab streaming state:
 * 1. Event-driven: Listen for claude-session-state events (real-time, <100ms)
 * 2. Initial sync: Check all running sessions on mount (catches missed events on startup)
 * 3. Periodic fallback: Re-check every 30 seconds (catches any missed events)
 *
 * This ensures tabs always show the correct running/idle state, even when:
 * - The app restarts while sessions are running
 * - Events are missed during tab switches
 * - Tabs are restored from localStorage with stale state
 */
export const useSessionSync = () => {
  const { tabs, updateTabStreamingStatus } = useTabs();

  // Use refs to avoid re-registering the listener on every tabs change
  const tabsRef = useRef(tabs);
  const updateTabStreamingStatusRef = useRef(updateTabStreamingStatus);

  // Keep refs up to date
  useEffect(() => {
    tabsRef.current = tabs;
    updateTabStreamingStatusRef.current = updateTabStreamingStatus;
  }, [tabs, updateTabStreamingStatus]);

  // Layer 2 & 3: Initial sync on mount + periodic fallback
  // Queries the backend for actually running sessions and reconciles with tab states
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const syncRunningState = async () => {
      if (cancelled) return;

      try {
        const activeSessions = await api.listRunningClaudeSessions();
        if (cancelled) return;

        // Build a set of running session IDs from the backend response
        const runningSessionIds = new Set<string>();
        for (const s of activeSessions) {
          if ('process_type' in s && s.process_type && 'ClaudeSession' in s.process_type) {
            const sessionId = (s.process_type as any).ClaudeSession.session_id;
            if (sessionId) {
              runningSessionIds.add(sessionId);
            }
          }
        }

        // Reconcile tab states with actual running sessions
        const currentTabs = tabsRef.current;
        for (const tab of currentTabs) {
          if (!tab.session?.id) continue;

          const isRunning = runningSessionIds.has(tab.session.id);

          if (isRunning && tab.state !== 'streaming') {
            // Session is running but tab shows idle -> correct to streaming
            console.debug('[SessionSync] Sync: marking tab as streaming:', tab.id, tab.session.id);
            updateTabStreamingStatusRef.current(tab.id, true, tab.session.id);
          } else if (!isRunning && tab.state === 'streaming') {
            // Session stopped but tab still shows streaming -> correct to idle
            console.debug('[SessionSync] Sync: marking tab as idle:', tab.id, tab.session.id);
            updateTabStreamingStatusRef.current(tab.id, false, null);
          }
        }
      } catch (error) {
        console.error('[SessionSync] Failed to sync running sessions:', error);
      }
    };

    // Initial sync after a short delay to let tabs be restored from localStorage
    const initialTimer = setTimeout(syncRunningState, 1000);

    // Periodic fallback every 30 seconds to catch any missed events
    intervalId = setInterval(syncRunningState, 30000);

    return () => {
      cancelled = true;
      clearTimeout(initialTimer);
      if (intervalId) clearInterval(intervalId);
    };
  }, []); // Empty deps - only set up once

  // Layer 1: Event-driven real-time updates
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    // Listen to claude-session-state events
    const setupListener = async () => {
      try {
        unlisten = await listen<{
          session_id: string;
          status: 'started' | 'stopped';
          success?: boolean;
          error?: string;
          project_path?: string;
          model?: string;
          pid?: number;
          run_id?: number;
        }>('claude-session-state', (event) => {
          const { session_id, status, project_path } = event.payload;

          // Use multiple matching strategies to find the tab
          // 1. Match by session_id first (existing sessions)
          // 2. Fall back to project_path matching (new sessions where tab.session?.id is not yet set)
          const normalizePath = (p: string) => p?.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') || '';

          let tab = tabsRef.current.find(t => t.session?.id === session_id);

          if (!tab && project_path) {
            const normalizedEventPath = normalizePath(project_path);
            // 🔧 FIX: Only match tabs that already have a session (type: 'session').
            // Do NOT match 'new' tabs (type: 'new', no session) by project path,
            // as this would incorrectly mark a fresh new-session tab as streaming
            // for an old session that happens to share the same project path.
            tab = tabsRef.current.find(t => {
              if (!t.session) return false; // Skip tabs without session (new tabs)
              const tabProjectPath = t.projectPath || t.session?.project_path;
              return tabProjectPath && normalizePath(tabProjectPath) === normalizedEventPath;
            });
          }

          if (tab) {
            if (status === 'started') {
              // Session started - set to streaming
              if (tab.state !== 'streaming') {
                updateTabStreamingStatusRef.current(tab.id, true, session_id);
              }
            } else if (status === 'stopped') {
              // Session stopped - set to idle
              if (tab.state === 'streaming') {
                updateTabStreamingStatusRef.current(tab.id, false, null);

                // If error occurred, log it
                if (event.payload.error) {
                  console.error(`[SessionSync] Session ${session_id} stopped with error:`, event.payload.error);
                }
              }
            }
          } else {
            console.warn(`[SessionSync] No tab found for session ${session_id}`);
          }
        });
      } catch (error) {
        console.error('[SessionSync] Failed to setup event listener:', error);
        // Fallback: Continue without real-time updates
        // The periodic sync will still keep tab states accurate
      }
    };

    setupListener();

    // Cleanup
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []); // Empty deps - listener only needs to be registered once
};

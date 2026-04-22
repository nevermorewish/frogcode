/**
 * PtyTerminalPanel — renders an xterm.js terminal bound to a PTY-mode Claude
 * session. Used when the user manually switches to terminal mode or when a
 * blacklisted slash command (/login, /init, /logout, /setup-token) is sent.
 *
 * Protocol:
 *   - listens to `pty-output:{sessionId}` Tauri event, writes chunks to xterm
 *   - xterm `onData` → `api.pty.sendInput(sessionId, data)`
 *   - ResizeObserver → `fit.fit()` → `api.pty.resize(sessionId, cols, rows)`
 *   - listens to `claude-complete:{sessionId}` → calls `onExit`
 */
import React, { useEffect, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { api } from '@/lib/api';

interface PtyTerminalPanelProps {
  sessionId: string;
  onExit?: (success: boolean) => void;
  className?: string;
}

export const PtyTerminalPanel: React.FC<PtyTerminalPanelProps> = ({
  sessionId,
  onExit,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: true,
      scrollback: 1000,
      theme: {
        background: '#0f1115',
        foreground: '#c5c8c6',
        cursor: '#ffffff',
        selectionBackground: '#404040',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // Pipe user keystrokes → PTY stdin.
    const dataDisposable = term.onData((data) => {
      api.pty.sendInput(sessionId, data).catch((err) => {
        console.error('[PtyTerminalPanel] sendInput failed:', err);
      });
    });

    // Resize handling.
    const pushResize = () => {
      if (!fitRef.current || !termRef.current) return;
      fitRef.current.fit();
      const { cols, rows } = termRef.current;
      api.pty
        .resize(sessionId, cols, rows)
        .catch((err) => console.error('[PtyTerminalPanel] resize failed:', err));
    };
    const ro = new ResizeObserver(() => pushResize());
    ro.observe(containerRef.current);

    // Subscribe to PTY output.
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenComplete: UnlistenFn | null = null;
    (async () => {
      unlistenOutput = await listen<string>(`pty-output:${sessionId}`, (event) => {
        term.write(event.payload);
      });
      unlistenComplete = await listen<boolean>(`claude-complete:${sessionId}`, (event) => {
        term.writeln('');
        term.writeln(
          `\x1b[2m[session ${event.payload ? 'ended' : 'exited with error'}]\x1b[0m`,
        );
        if (onExit) onExit(event.payload);
      });
      // Initial resize once subscribed.
      pushResize();
    })();

    return () => {
      dataDisposable.dispose();
      ro.disconnect();
      if (unlistenOutput) unlistenOutput();
      if (unlistenComplete) unlistenComplete();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, onExit]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: '100%',
        height: '100%',
        background: '#0f1115',
        padding: '8px',
        boxSizing: 'border-box',
      }}
    />
  );
};

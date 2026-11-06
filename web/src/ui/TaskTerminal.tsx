import { useEffect, useReducer, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminalWebSocketUrl } from '../lib/serverApi';
import { onThemeChange, readToken } from '../lib/themeColour';
import { INITIAL_TERMINAL_CONNECTION_STATE, reduceTerminalConnectionState } from '../lib/terminalConnectionState';
import { createTerminalConnection, isTaskExpectedLive } from '../lib/terminalReconnect';
import type { LiveTerminalSession } from '../lib/serverApi';
import { useWorldStore } from '../store/worldStore';

/** The terminal keeps its dark charcoal surface in both themes; the colours come from the stage-charcoal token pair. */
const terminalTheme = () => {
  const background = readToken('--sc-stage-charcoal');
  const foreground = readToken('--sc-stage-charcoal-foreground');
  return { background, foreground, cursor: foreground, selectionBackground: readToken('--sc-muted-foreground') };
};

/**
 * Reconnects by itself whenever the session's PTY becomes live again (see `createTerminalConnection`).
 * `onSessionState` reports whether the session's CLI process is running ('live') or gone ('ended': it exited, or the daemon no longer has it). */
export function TaskTerminal({ taskId, onSessionState }: { taskId: string; onSessionState?: (state: 'live' | 'ended') => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSessionStateRef = useRef(onSessionState);
  useEffect(() => { onSessionStateRef.current = onSessionState; }, [onSessionState]);
  const nextConnectionId = useRef(0);
  const [connection, dispatchConnection] = useReducer(reduceTerminalConnectionState, INITIAL_TERMINAL_CONNECTION_STATE);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: terminalTheme(),
    });
    const stopThemeSync = onThemeChange(() => { terminal.options.theme = terminalTheme(); });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);

    const isLiveIn = (sessions: LiveTerminalSession[]) => sessions.some((session) => session.id === taskId);
    // `link` is assigned before any socket event can call this.
    const sendSize = () => link.send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
    const link = createTerminalConnection({
      openSocket: (handlers) => {
        const socket = new WebSocket(terminalWebSocketUrl(taskId));
        socket.addEventListener('open', handlers.onOpen);
        socket.addEventListener('message', (event) => handlers.onMessage(String(event.data)));
        socket.addEventListener('error', handlers.onError);
        socket.addEventListener('close', handlers.onClose);
        return { isOpen: () => socket.readyState === WebSocket.OPEN, send: (data) => socket.send(data), close: () => socket.close() };
      },
      write: (data) => terminal.write(data),
      reset: () => terminal.reset(),
      onConnectionEvent: dispatchConnection,
      onSessionState: (state) => onSessionStateRef.current?.(state),
      onOpen: () => { fit.fit(); sendSize(); terminal.focus(); },
      nextConnectionId: () => ++nextConnectionId.current,
      // Agent and Content Studio sessions have no Task record: they rely on the live-session snapshots alone.
      isExpectedLive: () => isTaskExpectedLive(useWorldStore.getState().tasksById[taskId]),
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      initiallyLive: isLiveIn(useWorldStore.getState().liveTerminalSessions),
    });
    // Every snapshot, not a render-time selector: React may batch a quick not-live/live pair into one render.
    const stopLiveSync = useWorldStore.subscribe((state, previous) => {
      if (state.liveTerminalSessions !== previous.liveTerminalSessions) link.setLive(isLiveIn(state.liveTerminalSessions));
    });
    const resize = new ResizeObserver(() => {
      try { fit.fit(); sendSize(); } catch { /* The container may be between layouts. */ }
    });
    resize.observe(container);
    const input = terminal.onData((data) => link.send({ type: 'input', data }));

    return () => {
      stopThemeSync();
      input.dispose();
      resize.disconnect();
      stopLiveSync();
      link.dispose();
      terminal.dispose();
    };
  }, [taskId]);

  return (
    <div data-task-terminal className="relative min-h-0 flex-1 bg-stage-charcoal p-2">
      <div ref={containerRef} className="h-full min-h-72 w-full" aria-label="Interactive coding agent terminal" />
      {connection.error && <p className="absolute bottom-3 left-3 rounded bg-destructive px-2 py-1 text-xs text-destructive-foreground">{connection.error}</p>}
    </div>
  );
}

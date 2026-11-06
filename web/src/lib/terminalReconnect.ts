import type { TaskStatus, TerminalRuntimeStatus } from './serverApi';
import type { TerminalConnectionEvent } from './terminalConnectionState';

/** The slice of a WebSocket the terminal connection needs; the component adapts a real WebSocket to it. */
export interface TerminalSocket {
  isOpen(): boolean;
  send(data: string): void;
  close(): void;
}

export interface TerminalSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onError(): void;
  onClose(): void;
}

export interface TerminalConnectionDeps {
  openSocket(handlers: TerminalSocketHandlers): TerminalSocket;
  /** Writes PTY output into the terminal view. */
  write(data: string): void;
  /** Clears the terminal view; the daemon replays the session's whole buffer on every attach. */
  reset(): void;
  onConnectionEvent(event: TerminalConnectionEvent): void;
  onSessionState(state: 'live' | 'ended'): void;
  /** The socket opened: size the PTY and focus the view. */
  onOpen(): void;
  nextConnectionId(): number;
  /** Whether the session should have a PTY soon even though no snapshot lists it yet; gates the fallback retry. */
  isExpectedLive(): boolean;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Whether the latest live-PTY snapshot lists this session. */
  initiallyLive: boolean;
}

export interface TerminalConnection {
  /** Sends a frame on the current socket, if it is open. */
  send(frame: object): void;
  /** Feeds one live-PTY snapshot: call it for every snapshot, so a quick not-live/live pair is never missed. */
  setLive(isLive: boolean): void;
  dispose(): void;
}

/** Delays before each fallback attach attempt while a Task is expected live but no snapshot lists its PTY yet. */
export const FALLBACK_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 4000] as const;

/** A Task whose CLI is (about to be) running; only these get the fallback retry. */
export function isTaskExpectedLive(task: { status: TaskStatus; runtimeStatus?: TerminalRuntimeStatus } | undefined): boolean {
  if (!task) return false;
  return task.status === 'developing' || task.status === 'blocked' || task.runtimeStatus === 'starting';
}

type Phase = 'connecting' | 'attached' | 'failed' | 'ended';

/**
 * One terminal view's link to its PTY, reconnecting whenever the session becomes live again.
 *
 * The daemon announces a session before it registers the PTY, so the first attach can fail; and a socket
 * attached to an ended session never hears from a PTY restarted under the same id. How the socket died
 * decides when to reconnect:
 * - `failed` (attach refused, or the socket dropped): on the next snapshot that lists the id. Attach only
 *   fails when no PTY exists, so a fresh listing is proof a new one started.
 * - `ended` (the CLI exited): only after a snapshot has shown the id not live since that frame, then live
 *   again. The `ended` frame outruns the snapshot of the same exit, so the snapshot still in hand when it
 *   arrives can be stale.
 */
export function createTerminalConnection(deps: TerminalConnectionDeps): TerminalConnection {
  let isLive = deps.initiallyLive;
  let phase: Phase = 'connecting';
  let notLiveSeenSinceEnd = false;
  // A live snapshot that arrived during this connection; a failure without one waits for the next
  // snapshot, so a stale listing (e.g. the daemon went away) cannot spin into a reconnect loop.
  let liveSeenSinceConnect = false;
  let socket: TerminalSocket | null = null;
  let retryTimer: unknown = null;
  let retriesUsed = 0;
  let disposed = false;
  let attempts = 0;

  const clearRetry = () => {
    if (retryTimer !== null) deps.clearTimer(retryTimer);
    retryTimer = null;
  };

  const connect = () => {
    clearRetry();
    socket?.close();
    if (attempts++ > 0) deps.reset();
    phase = 'connecting';
    liveSeenSinceConnect = false;
    const connectionId = deps.nextConnectionId();
    deps.onConnectionEvent({ type: 'start', connectionId });
    const current = (): boolean => !disposed && socket === opened;
    const fail = (message?: string) => {
      if (message) deps.onConnectionEvent({ type: 'error', connectionId, message });
      if (phase === 'ended' || phase === 'failed') return;
      phase = 'failed';
      if (isLive && liveSeenSinceConnect) connect();
      else scheduleRetry();
    };
    const opened: TerminalSocket = deps.openSocket({
      onOpen: () => {
        if (!current()) return;
        deps.onConnectionEvent({ type: 'open', connectionId });
        deps.onOpen();
      },
      onMessage: (data) => {
        if (!current()) return;
        let message: { type?: string; data?: string; message?: string };
        try { message = JSON.parse(data); } catch { return; /* Ignore frames from an incompatible server. */ }
        if (message.type === 'output' && typeof message.data === 'string') {
          deps.write(message.data);
          markAttached();
        }
        if (message.type === 'live' || message.type === 'ended') deps.onSessionState(message.type);
        if (message.type === 'live') markAttached();
        if (message.type === 'ended') {
          phase = 'ended';
          notLiveSeenSinceEnd = !isLive;
        }
        if (message.type === 'error') {
          deps.onSessionState('ended');
          fail(message.message ?? 'Terminal unavailable');
        }
      },
      onError: () => { if (current()) fail('Could not connect to the terminal session.'); },
      onClose: () => { if (current()) fail(); },
    });
    socket = opened;
  };

  const markAttached = () => {
    if (phase === 'connecting') phase = 'attached';
    retriesUsed = 0;
  };

  const scheduleRetry = () => {
    if (retryTimer !== null || retriesUsed >= FALLBACK_RETRY_DELAYS_MS.length || !deps.isExpectedLive()) return;
    retryTimer = deps.setTimer(() => {
      retryTimer = null;
      if (disposed || phase !== 'failed' || !deps.isExpectedLive()) return;
      retriesUsed += 1;
      connect();
    }, FALLBACK_RETRY_DELAYS_MS[retriesUsed]);
  };

  connect();

  return {
    send(frame) {
      if (socket?.isOpen()) socket.send(JSON.stringify(frame));
    },
    setLive(next) {
      isLive = next;
      if (disposed) return;
      if (!next) {
        if (phase === 'ended') notLiveSeenSinceEnd = true;
        return;
      }
      liveSeenSinceConnect = true;
      if (phase === 'failed' || (phase === 'ended' && notLiveSeenSinceEnd)) connect();
    },
    dispose() {
      disposed = true;
      clearRetry();
      socket?.close();
    },
  };
}

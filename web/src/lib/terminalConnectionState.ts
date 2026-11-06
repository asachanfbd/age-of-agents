export interface TerminalConnectionState {
  connectionId: number;
  error: string;
}

export type TerminalConnectionEvent =
  | { type: 'start'; connectionId: number }
  | { type: 'open'; connectionId: number }
  | { type: 'error'; connectionId: number; message: string };

export const INITIAL_TERMINAL_CONNECTION_STATE: TerminalConnectionState = { connectionId: 0, error: '' };

/**
 * Keeps delayed events from an already-disposed WebSocket from changing the
 * visible status of its replacement. React Strict Mode deliberately performs
 * one setup/cleanup/setup cycle in development, which makes this ordering a
 * normal occurrence rather than an exceptional race.
 */
export function reduceTerminalConnectionState(
  state: TerminalConnectionState,
  event: TerminalConnectionEvent,
): TerminalConnectionState {
  if (event.type === 'start') {
    return event.connectionId >= state.connectionId ? { connectionId: event.connectionId, error: '' } : state;
  }
  if (event.connectionId !== state.connectionId) return state;
  return event.type === 'open' ? { ...state, error: '' } : { ...state, error: event.message };
}

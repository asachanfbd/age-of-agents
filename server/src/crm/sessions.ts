import type { CrmSettings, FollowupType } from './settings.ts';
import { MESSAGE_TYPES } from './settings.ts';

export interface SessionItem { id: number; type: FollowupType; dueAt: number }
export interface Session { kind: 'messages' | 'calls'; minutes: number; items: SessionItem[] }
export const SESSION_MINUTES = 30;

/** Groups due items into blocks: message-type items by `messagesPer30`, calls by `callsPer30`; the two never share a block. Items run in due order. */
export function buildSessions(items: SessionItem[], settings: CrmSettings): Session[] {
  const byDue = [...items].sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
  const out: Session[] = [];
  const chunk = (kind: Session['kind'], list: SessionItem[], size: number) => {
    for (let i = 0; i < list.length; i += size) out.push({ kind, minutes: SESSION_MINUTES, items: list.slice(i, i + size) });
  };
  chunk('messages', byDue.filter((i) => MESSAGE_TYPES.includes(i.type)), settings.sessions.messagesPer30);
  chunk('calls', byDue.filter((i) => i.type === 'call'), settings.sessions.callsPer30);
  return out;
}


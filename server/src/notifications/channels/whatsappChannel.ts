import { SEND_API_KEY, SEND_HOST, SEND_TO } from '../../config.ts';
import type { NotificationChannel } from './notificationChannel.ts';

/** Thrown instead of silently no-op-ing or letting `fetch` be called with an undefined URL when SEND_HOST/SEND_API_KEY/SEND_TO aren't configured. */
export class WhatsAppChannelConfigError extends Error {
  constructor() {
    super('WhatsApp channel is not configured: set SEND_HOST, SEND_API_KEY, and SEND_TO env vars to use it.');
    this.name = 'WhatsAppChannelConfigError';
  }
}

/** A non-2xx response from the configured endpoint, surfaced as a rejected `send()` rather than swallowed. */
export class WhatsAppChannelSendError extends Error {
  constructor(status: number, body: string) {
    super(`WhatsApp send failed with status ${status}: ${body}`);
    this.name = 'WhatsAppChannelSendError';
  }
}

/**
 * Config + `fetch` injectable per instance, defaulting to config.ts's env
 * vars and the global `fetch` — the same `Dependencies`-with-defaults shape
 * server/src/executors/claudeUsage.ts's `ClaudeUsagePoller` already uses, so
 * tests can construct a channel with fixed/missing config or a stub `fetch`
 * without reaching for real env vars or network calls.
 */
export interface WhatsAppChannelOverrides {
  sendHost?: string;
  sendApiKey?: string;
  sendTo?: string;
  fetch?: typeof fetch;
}

/**
 * Wraps the exact HTTP call docs/notify.sh already makes —
 * `POST ${SEND_HOST}/api/send` with an `x-api-key` header and a
 * `{ to, message }` JSON body — called directly from Node's native `fetch`
 * (already the pattern in server/src/executors/claudeUsage.ts) instead of
 * shelling out to the script.
 *
 * `target` is part of `NotificationChannel`'s shared signature but is
 * intentionally ignored here in favor of the configured `SEND_TO`: this is a
 * local, single-user app (docs/architecture.md, "Local, single-user, no
 * hosting") with exactly one real recipient, and `SEND_HOST`/`SEND_API_KEY`/
 * `SEND_TO` are consumed the same way `EXECUTORS_PATH`/`CLAUDE_BIN` already
 * are elsewhere in config.ts — read once as fixed machine config, never
 * overridden per call. Honoring a caller-supplied `target` would add a
 * second, unused notion of "recipient" for a distinction this app has no use
 * for yet; if a real multi-recipient need shows up later, that's a config
 * shape change, not something this adapter should improvise per call.
 */
export function createWhatsAppChannel(overrides: WhatsAppChannelOverrides = {}): NotificationChannel {
  const sendHost = overrides.sendHost ?? SEND_HOST;
  const sendApiKey = overrides.sendApiKey ?? SEND_API_KEY;
  const sendTo = overrides.sendTo ?? SEND_TO;
  const fetchImpl = overrides.fetch ?? globalThis.fetch;

  return {
    async send(message: string, _target: string): Promise<void> {
      if (!sendHost || !sendApiKey || !sendTo) throw new WhatsAppChannelConfigError();
      const response = await fetchImpl(`${sendHost}/api/send`, {
        method: 'POST',
        headers: { 'x-api-key': sendApiKey },
        body: JSON.stringify({ to: sendTo, message }),
      });
      if (!response.ok) throw new WhatsAppChannelSendError(response.status, await response.text());
    },
  };
}

/** The one WhatsApp channel instance real callers use — not yet wired to the action executor (separate, ongoing work). */
export const whatsappChannel: NotificationChannel = createWhatsAppChannel();

/**
 * The in-memory list of credential values that must never reach a log line, command output, terminal
 * stream or error message. It has no dependencies so low-level modules (git.ts) can use it without
 * pulling in daemon configuration.
 */
const known = new Set<string>();
/** Shorter values would garble ordinary log lines; real credentials are longer. */
const MIN_SCRUBBED_LENGTH = 6;

/** Remembers a credential with the encodings it could show up in (HTTP Basic auth, URL, JSON). */
export function rememberSecret(value: string, encodings = false): void {
  known.add(value);
  if (!encodings) return;
  for (const form of [Buffer.from(`x-access-token:${value}`).toString('base64'), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) known.add(form);
}

/** Every secret value seen so far, replaced in `text`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const value of known) if (value.length >= MIN_SCRUBBED_LENGTH) out = out.split(value).join('[secret]');
  return out;
}

/** How long text that might be the start of a secret is held back waiting for the rest. */
const HOLD_BACK_MS = 100;

/** The longest suffix of `text` that is a proper prefix of a known secret: it may be the first half of a split secret. */
function possibleSecretPrefix(text: string): number {
  let held = 0;
  for (const value of known) {
    if (value.length < MIN_SCRUBBED_LENGTH) continue;
    for (let length = Math.min(value.length - 1, text.length); length > held; length -= 1) {
      if (text.endsWith(value.slice(0, length))) { held = length; break; }
    }
  }
  return held;
}

/**
 * Redacts a chunked stream so a secret split across two chunks is still caught. Only a tail that could
 * be the start of a secret is held back, and only until the next chunk or a short timer, so ordinary
 * output is never delayed.
 */
export function createStreamRedactor(emit: (safe: string) => void, holdMs = HOLD_BACK_MS) {
  let pending = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    clearTimeout(timer);
    timer = undefined;
    const text = redactSecrets(pending);
    pending = '';
    if (text) emit(text);
  };
  return {
    push(chunk: string): void {
      clearTimeout(timer);
      const text = redactSecrets(pending + chunk);
      const held = possibleSecretPrefix(text);
      pending = held > 0 ? text.slice(-held) : '';
      const ready = held > 0 ? text.slice(0, -held) : text;
      if (ready) emit(ready);
      if (pending) { timer = setTimeout(release, holdMs); timer.unref?.(); }
    },
    /** Emits whatever is still held, for the end of a stream. */
    flush: release,
  };
}

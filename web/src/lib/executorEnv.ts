/**
 * Pure text <-> env-map conversion for the settings panel's "add/edit coding
 * agent" form (`AgentsSettings.tsx`) — lets an executor's extra
 * environment variables (e.g. `CLAUDE_CONFIG_DIR` to pick a specific
 * logged-in account, see server/executors.example.json) be edited as plain
 * "KEY=value" lines instead of a dynamic list of key/value input rows.
 * Extracted so the parsing itself is unit-testable without a React renderer —
 * this codebase has none configured (see the `web-interaction-conventions`
 * skill).
 */

/** One "KEY=value" per line; blank lines and lines with no "=" are ignored. Whitespace around the key and value is trimmed. */
export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key) continue;
    env[key] = trimmed.slice(separatorIndex + 1).trim();
  }
  return env;
}

/** The inverse of parseEnvText, for pre-filling the form when editing an executor that already has env vars set. */
export function formatEnvText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

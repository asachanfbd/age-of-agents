# Claude quota in the footer

The daemon requests each Claude account's usage immediately on startup and every five minutes from `https://api.anthropic.com/api/oauth/usage`. It sends `anthropic-beta: oauth-2025-04-20` and `User-Agent: claude-code/<installed version>`, following the [community workaround](https://github.com/anthropics/claude-code/issues/30930#issuecomment-4032624631). This endpoint is undocumented; the header workaround is not a guaranteed service contract.

One poller serves all browser tabs. Requests sharing a credential profile are deduplicated. The poll is driven by the analytics sampler, which also stores each reading as history (see [agent-analytics.md](agent-analytics.md)); a manual Refresh there may check sooner, but not within a minute of the last successful check or inside a failure backoff. Failed requests retain the last successful reading and back off from ten minutes to an hour, honoring longer `Retry-After` values. A zero retry interval never triggers an immediate retry. Each request has a ten-second network timeout and rejects redirects.

On macOS the server reads the profile-specific Claude Code credential from Keychain. On other platforms it reads the profile's `.credentials.json`. Tokens remain server-side and go only to the fixed Anthropic endpoint; they are neither logged nor included in API responses. Claude retains responsibility for login and token refresh. Missing or expired credentials are retried on the next polling interval without rotating tokens. Profiles using a secure-storage directory override use that credential identity.

The existing interactive status-line feed remains a fallback. `server/scripts/statusline-usage-cache.sh`, sourced or embedded after `input=$(cat)`, atomically saves quota fields and observation time to `$CLAUDE_CONFIG_DIR/context-village-usage.json` (default `~/.claude`). The footer uses whichever reading is newer. No additional model calls are made.

The browser rereads the server every 30 seconds. Both windows show percent used and a reset countdown, with exact IST reset times on hover. Selecting an agent's footer item opens its Analytics view, which shows remaining capacity over time. Older readings show their age; elapsed windows await fresh data rather than assuming zero usage. Headless tasks and idle interactive sessions no longer prevent usage refresh while the daemon is running.

Restart the daemon after installing this change. The server poller runs independently of whether a browser tab is open.

Status-line schema: https://code.claude.com/docs/en/statusline

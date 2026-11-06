# Codex executor

Codex supports task execution, follow-ups, blocked-task answers, restart recovery, and account usage in the status bar. Planning sessions need the interactive `codex-cli` kind; this structured `codex` kind (`codex exec`) cannot run one.

Configure an entry in `server/executors.json`:

```json
{ "id": "codex", "label": "Codex", "kind": "codex", "bin": "codex", "env": {} }
```

Use an absolute binary path if Codex is not on the daemon's PATH. The local machine config uses `/opt/homebrew/bin/codex`. Authenticate with `codex login` first. To select another account, set `env.CODEX_HOME` to that account's absolute Codex directory; execution, resume, and usage polling all use this environment. Restart the daemon after installing/upgrading its CLI.

Tasks run through `codex exec --json --output-schema`, with the Codex thread ID persisted for `exec resume`. Template instructions become developer instructions. Automatic tasks use full access; approval-mode tasks use read-only sandboxing with gated operations denied because the daemon has no interactive approval relay. Planning disables the shell tool and retains the existing plan-only instructions. Structured outcomes drive done/blocked/failed states; invalid output or an incomplete/nonzero process exit fails the task. Resumed cumulative usage is reduced by usage already recorded across tasks in that session. Cached input is split out of input tokens so totals count it once. Codex does not report a dollar cost here; the existing numeric cost field stays zero.

The daemon requests `account/rateLimits/read` over a short-lived `codex app-server` stdio connection at startup and every five minutes. The CLI owns authentication; this integration does not read credentials. Failed requests back off while retaining the last successful reading. The footer shows five-hour and weekly windows by their reported duration, including reset times and stale-data notices. Missing data remains unavailable (for example, API-key-only authentication); other quota durations are not mislabeled as five-hour or weekly limits. The same readings are stored as history for the Analytics view (see [agent-analytics.md](agent-analytics.md)).

References: [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [App Server](https://learn.chatgpt.com/docs/app-server), [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

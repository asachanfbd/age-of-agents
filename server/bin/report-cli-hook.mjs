#!/usr/bin/env node

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const url = process.env.AGENT_VISUAL_OS_HOOK_URL;
  const token = process.env.AGENT_VISUAL_OS_HOOK_TOKEN;
  const taskId = process.env.AGENT_VISUAL_OS_TASK_ID;
  const cliKind = process.env.AGENT_VISUAL_OS_CLI_KIND;
  if (url && token && taskId && cliKind) {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ taskId, cliKind, event }),
      signal: AbortSignal.timeout(2_000),
    });
  }
} catch {
  // Status reporting must never interrupt or alter the CLI turn.
}

// Both Claude and Codex accept an empty JSON hook response as "no decision".
process.stdout.write('{}\n');

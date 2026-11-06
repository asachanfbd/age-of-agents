// The shared core of the daemon's session-scoped stdio MCP servers (bin/*-task-mcp.mjs): a minimal
// newline-delimited JSON-RPC 2.0 loop, and a relay that forwards a tool call to one internal daemon
// route, scoped to the launching Task and authenticated with the per-daemon CLI hook token. Each
// server only declares its tools.

import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';

export function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Calls longer than this skip the global `fetch`: its built-in client gives up after 300 s without response headers or body
 * bytes, whatever the abort signal says, so a long call (a video or image render that waits for its result) goes over `node:http`, which
 * has no such limit and is bounded only by the call's own timeout.
 */
export const FETCH_SAFE_MS = 290_000;

/** The same call as `requestDaemon` over `node:http`, for calls that may wait longer than `fetch` allows. */
export function requestDaemonLong(method, url, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AGENT_VISUAL_OS_HOOK_TOKEN}`, ...(payload && { 'content-length': Buffer.byteLength(payload) }) },
      signal: AbortSignal.timeout(timeoutMs),
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let reply = {};
        try { reply = text ? JSON.parse(text) : {}; } catch { reply = {}; }
        if (res.statusCode < 200 || res.statusCode >= 300) resolve({ error: toolResult(`Failed: ${reply.error ?? `HTTP ${res.statusCode}`}`, true) });
        else resolve({ body: reply });
      });
    });
    req.on('error', (error) => resolve({ error: toolResult(`Failed: ${error.message}`, true) }));
    req.end(payload);
  });
}

/** One authenticated HTTP call to the daemon: `{ body }` on success, or `{ error }` — a ready-to-return failed tool result. */
export async function requestDaemon(method, url, body, timeoutMs) {
  if (timeoutMs > FETCH_SAFE_MS) return requestDaemonLong(method, url, body, timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AGENT_VISUAL_OS_HOOK_TOKEN}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const reply = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) return { error: toolResult(`Failed: ${reply.error ?? `HTTP ${res.status}`}`, true) };
    return { body: reply };
  } catch (error) {
    return { error: toolResult(`Failed: ${error.message}`, true) };
  }
}

/**
 * A function that relays one call to the daemon at `$<urlEnv><pathAndQuery>` with `taskId` appended,
 * and renders a successful JSON reply with `describe`. Any failure comes back as a tool error.
 */
export function createDaemonRelay({ urlEnv, notConnected, timeoutMs }) {
  return async function daemon(method, pathAndQuery, body, describe, { timeoutMs: callTimeoutMs } = {}) {
    const url = process.env[urlEnv];
    const taskId = process.env.AGENT_VISUAL_OS_TASK_ID;
    if (!url || !process.env.AGENT_VISUAL_OS_HOOK_TOKEN || !taskId) return toolResult(notConnected, true);
    const join = pathAndQuery.includes('?') ? '&' : '?';
    const result = await requestDaemon(method, `${url}${pathAndQuery}${join}taskId=${encodeURIComponent(taskId)}`, body, callTimeoutMs ?? timeoutMs);
    return result.error ?? toolResult(describe(result.body));
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

async function handle(request, serverInfo, tools) {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const tool = tools.find(({ name }) => name === request.params?.name);
      if (!tool) return toolResult(`Unknown tool: ${request.params?.name}`, true);
      return tool.call(request.params.arguments);
    }
    default:
      throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
  }
}

/** Serves `tools` (each `{name, description, inputSchema, call(args)}`) over stdin/stdout until stdin closes. */
export async function serveMcp(serverInfo, tools) {
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    if (request.id === undefined || request.id === null) continue; // Notifications need no reply.
    try {
      send({ id: request.id, result: await handle(request, serverInfo, tools) });
    } catch (error) {
      send({ id: request.id, error: { code: error.code ?? -32603, message: error.message } });
    }
  }
}

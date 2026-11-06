/**
 * Session-scoped stdio MCP servers the daemon registers with a CLI session (planning, WorkflowRun
 * step and testing tools), and the one place their command-line registration is built for each CLI.
 * Structured (`claude -p`/`codex exec`) and interactive terminal runners share these builders, so a
 * session with several servers is registered the same way whichever path launches it.
 */

/** One stdio MCP server to register with a CLI for a single session. */
export interface McpServerLaunch {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Tool names this server exposes, all pre-approved: Claude's `--allowed-tools`, Codex's per-tool `approval_mode`. */
  tools: string[];
  /** Overrides Codex's per-call tool timeout (60s by default) for a server whose tools may block longer. */
  toolTimeoutSec?: number;
}

/**
 * One `--mcp-config` holding every server, plus a single `--allowed-tools` pre-approving each
 * server's tools. Both flags are variadic, so an interactive caller must follow them with another
 * flag before the prompt.
 */
export function claudeMcpArgs(servers: McpServerLaunch[]): string[] {
  if (!servers.length) return [];
  const mcpServers = Object.fromEntries(servers.map((server) => [server.name, { type: 'stdio', command: server.command, args: server.args, env: server.env }]));
  const allowed = servers.flatMap((server) => server.tools.map((tool) => `mcp__${server.name}__${tool}`));
  return ['--mcp-config', JSON.stringify({ mcpServers }), ...(allowed.length ? ['--allowed-tools', allowed.join(',')] : [])];
}

/**
 * Codex takes MCP servers as `-c` TOML overrides; JSON strings and arrays are valid TOML values.
 * Its tools are pre-approved per tool, as Claude's `--allowed-tools` does: a read-only session runs
 * `--ask-for-approval never`, which otherwise refuses every MCP call that would need approval.
 */
export function codexMcpArgs(servers: McpServerLaunch[]): string[] {
  return servers.flatMap((server) => {
    const key = `mcp_servers.${server.name}`;
    const env = Object.entries(server.env).map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join(', ');
    return [
      '-c', `${key}.command=${JSON.stringify(server.command)}`,
      '-c', `${key}.args=${JSON.stringify(server.args)}`,
      '-c', `${key}.env={ ${env} }`,
      ...(server.toolTimeoutSec ? ['-c', `${key}.tool_timeout_sec=${server.toolTimeoutSec}`] : []),
      ...server.tools.flatMap((tool) => ['-c', `${key}.tools.${tool}.approval_mode="approve"`]),
    ];
  });
}

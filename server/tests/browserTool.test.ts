import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DATA_DIR, PROJECTS_DIR } from '../src/config.ts';
import { claudeMcpArgs, codexMcpArgs } from '../src/terminal/mcpServers.ts';
import {
  BROWSER_MCP_SERVER_NAME, BROWSER_TOOLS, PLAYWRIGHT_MCP_VERSION, browserMcpServer, browserOutputDir, checkBrowserAvailability,
  type BrowserProbeDeps,
} from '../src/terminal/browserTool.ts';

const okDeps: BrowserProbeDeps = {
  packageRoot: () => '/pkg/@playwright/mcp',
  readVersion: () => PLAYWRIGHT_MCP_VERSION,
  chromiumExecutable: () => '/cache/chromium',
  exists: () => true,
};

test('the pinned version is an exact x.y.z and matches server/package.json', async () => {
  assert.match(PLAYWRIGHT_MCP_VERSION, /^\d+\.\d+\.\d+$/);
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8')) as { optionalDependencies: Record<string, string> };
  assert.equal(pkg.optionalDependencies['@playwright/mcp'], PLAYWRIGHT_MCP_VERSION);
});

test('the server runs headless and isolated, never against the owner profile or a browser extension', () => {
  const server = browserMcpServer('task-1', '/pkg/cli.js');
  assert.equal(server.name, BROWSER_MCP_SERVER_NAME);
  assert.equal(server.command, process.execPath);
  assert.equal(server.args[0], '/pkg/cli.js');
  assert.ok(server.args.includes('--headless'));
  assert.ok(server.args.includes('--isolated'));
  for (const forbidden of ['--user-data-dir', '--extension', '--endpoint', '--cdp-endpoint', '--browser', '--executable-path']) assert.ok(!server.args.includes(forbidden), forbidden);
  assert.deepEqual(server.tools, [...BROWSER_TOOLS]);
});

test('the output directory is per task, under the data dir and outside the repository worktree', () => {
  const dir = browserOutputDir('task-1');
  assert.equal(browserMcpServer('task-1', '/c.js').args[browserMcpServer('task-1', '/c.js').args.indexOf('--output-dir') + 1], dir);
  assert.ok(dir.startsWith(`${DATA_DIR}${path.sep}`));
  assert.notEqual(browserOutputDir('task-2'), dir);
  const escaping = browserOutputDir('../../etc/x');
  assert.equal(path.dirname(escaping), path.join(DATA_DIR, 'browser-output'));
  assert.ok(!escaping.includes('..'));
  assert.ok(!dir.startsWith(`${PROJECTS_DIR}${path.sep}`), 'never inside a project worktree');
});

test('Claude allows every browser tool and registers the server; Codex approves each tool', () => {
  const server = browserMcpServer('task-1', '/pkg/cli.js');
  const claude = claudeMcpArgs([server]);
  assert.ok(claude[1]!.includes(`"${BROWSER_MCP_SERVER_NAME}"`));
  const allowed = claude[claude.indexOf('--allowed-tools') + 1]!.split(',');
  for (const tool of BROWSER_TOOLS) assert.ok(allowed.includes(`mcp__${BROWSER_MCP_SERVER_NAME}__${tool}`), tool);
  const codex = codexMcpArgs([server]);
  assert.ok(codex.includes(`mcp_servers.${BROWSER_MCP_SERVER_NAME}.command=${JSON.stringify(process.execPath)}`));
  for (const tool of BROWSER_TOOLS) assert.ok(codex.includes(`mcp_servers.${BROWSER_MCP_SERVER_NAME}.tools.${tool}.approval_mode="approve"`), tool);
});

test('availability: package and browser binary present', () => {
  assert.deepEqual(checkBrowserAvailability(okDeps), { available: true, cliPath: path.join('/pkg/@playwright/mcp', 'cli.js') });
});

test('availability: missing package, wrong version and missing binary each say why', () => {
  const missing = checkBrowserAvailability({ ...okDeps, packageRoot: () => { throw new Error("Cannot find module '@playwright/mcp/package.json'\nrequire stack"); } });
  assert.equal(missing.available, false);
  assert.match(missing.available ? '' : missing.reason, /not installed.*Cannot find module/);
  assert.doesNotMatch(missing.available ? '' : missing.reason, /require stack/);
  const wrong = checkBrowserAvailability({ ...okDeps, readVersion: () => '9.9.9' });
  assert.match(wrong.available ? '' : wrong.reason, /9\.9\.9 is installed but .* is required/);
  const noBinary = checkBrowserAvailability({ ...okDeps, exists: () => false });
  assert.match(noBinary.available ? '' : noBinary.reason, /Chromium browser is not installed/);
  const nonError = checkBrowserAvailability({ ...okDeps, packageRoot: () => { throw 'boom'; } });
  assert.match(nonError.available ? '' : nonError.reason, /boom/);
});

test('the real probe returns a result without throwing', () => {
  assert.equal(typeof checkBrowserAvailability().available, 'boolean');
});

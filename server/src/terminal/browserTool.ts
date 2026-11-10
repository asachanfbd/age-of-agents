import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DATA_DIR } from '../config.ts';
import type { McpServerLaunch } from './mcpServers.ts';

/**
 * The headless browser a workflow step gets when its `canUseBrowser` is set: the Playwright MCP
 * server (`@playwright/mcp`), run from the daemon's own pinned install in headless, isolated mode
 * (an in-memory profile, never the owner's Chrome). Screenshots and traces go to a per-task
 * directory under the daemon's data dir, never the worktree. The package and its Chromium are
 * optional: when either is missing the session starts without the browser (see
 * `checkBrowserAvailability`).
 */
export const BROWSER_MCP_SERVER_NAME = 'agent_visual_os_browser';

/** Must equal the `@playwright/mcp` version in server/package.json; an install of any other version is reported unavailable. */
export const PLAYWRIGHT_MCP_VERSION = '0.0.85';

/** The Playwright MCP tools a step may call: page driving and inspection, not arbitrary code, file upload or storage tools. */
export const BROWSER_TOOLS = [
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click', 'browser_hover', 'browser_type',
  'browser_fill_form', 'browser_press_key', 'browser_select_option', 'browser_wait_for', 'browser_take_screenshot',
  'browser_resize', 'browser_console_messages', 'browser_network_requests', 'browser_handle_dialog', 'browser_tabs', 'browser_close',
] as const;

export type BrowserAvailability = { available: true; cliPath: string } | { available: false; reason: string };

/** The filesystem and module lookups the availability probe makes, replaceable in tests. */
export interface BrowserProbeDeps {
  /** Directory of the installed `@playwright/mcp` package; throws when it is not installed. */
  packageRoot(): string;
  readVersion(packageRoot: string): string;
  /** Path Playwright would launch Chromium from. */
  chromiumExecutable(packageRoot: string): string;
  exists(filePath: string): boolean;
}

const require = createRequire(import.meta.url);

const defaultProbeDeps: BrowserProbeDeps = {
  packageRoot: () => path.dirname(require.resolve('@playwright/mcp/package.json')),
  readVersion: (root) => (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version,
  chromiumExecutable: (root) => {
    const playwright = require(require.resolve('playwright-core', { paths: [root] })) as { chromium: { executablePath(): string } };
    return playwright.chromium.executablePath();
  },
  exists: existsSync,
};

export const BROWSER_INSTALL_HINT = 'Install it with `cd server && npm install` followed by `npx playwright install chromium` (see docs/architecture.md).';

/** Whether the pinned Playwright MCP package and a Chromium binary are installed. Never throws. */
export function checkBrowserAvailability(deps: BrowserProbeDeps = defaultProbeDeps): BrowserAvailability {
  try {
    const root = deps.packageRoot();
    const version = deps.readVersion(root);
    if (version !== PLAYWRIGHT_MCP_VERSION) return { available: false, reason: `@playwright/mcp ${version} is installed but ${PLAYWRIGHT_MCP_VERSION} is required` };
    if (!deps.exists(deps.chromiumExecutable(root))) return { available: false, reason: 'the Playwright Chromium browser is not installed' };
    return { available: true, cliPath: path.join(root, 'cli.js') };
  } catch (error) {
    return { available: false, reason: `@playwright/mcp is not installed (${error instanceof Error ? error.message.split('\n')[0] : String(error)})` };
  }
}

/** The per-task directory for screenshots and traces; the task id can't escape the data dir. */
export function browserOutputDir(taskId: string): string {
  return path.join(DATA_DIR, 'browser-output', taskId.replace(/[^A-Za-z0-9_-]/g, '_'));
}

export function browserMcpServer(taskId: string, cliPath: string): McpServerLaunch {
  return {
    name: BROWSER_MCP_SERVER_NAME,
    command: process.execPath,
    args: [cliPath, '--headless', '--isolated', '--output-dir', browserOutputDir(taskId)],
    env: {},
    tools: [...BROWSER_TOOLS],
  };
}

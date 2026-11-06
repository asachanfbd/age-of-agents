import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every path the daemon touches, resolved once from this file's own location
 * so the server behaves the same regardless of the working directory it was
 * launched from (`npm run dev` inside server/, a process manager, etc.).
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SRC_DIR, '..', '..');

/**
 * Where created Projects live on disk, and where the file-based database is
 * stored. Both are git-ignored (see root .gitignore) and both are
 * overridable via env var so tests can point them at a throwaway temp
 * directory instead of touching the real projects/ and server/data/.
 */
export const PROJECTS_DIR = process.env.AGENT_VISUAL_OS_PROJECTS_DIR ?? path.join(REPO_ROOT, 'projects');
export const DATA_DIR = process.env.AGENT_VISUAL_OS_DATA_DIR ?? path.join(REPO_ROOT, 'server', 'data');

/**
 * The Catalog lives in its own repo-root `catalog/` folder — `catalog/agents/`
 * and `catalog/skills/` — format-compatible with Claude Code's own agent
 * markdown / `SKILL.md` shape, but never read from or written to any real
 * Claude Code config. Fully independent of both this repo's own `.claude/`
 * (this repo's dev-tooling agents/skills, e.g. server-daemon-architect,
 * threejs-scene-artist, ui-interaction-engineer) and the *user's home*
 * `~/.claude/` — the daemon never reads or writes either. Overridable so
 * tests point at a throwaway temp directory instead of this repo's real
 * `catalog/`.
 */
export const CATALOG_DIR = process.env.AGENT_VISUAL_OS_CATALOG_DIR ?? path.join(REPO_ROOT, 'catalog');
export const CATALOG_AGENTS_DIR = path.join(CATALOG_DIR, 'agents');
export const CATALOG_SKILLS_DIR = path.join(CATALOG_DIR, 'skills');
/** Workflow definitions (task 3.012) — one `<id>.json` per WorkflowRecord, no sidecar index (unlike agents/skills, a Workflow's game-only fields already live in its own JSON, not markdown frontmatter). */
export const CATALOG_WORKFLOWS_DIR = path.join(CATALOG_DIR, 'workflows');
/** Sidecar metadata (avatar, manager flag, default autonomy, enabled, triggers) the game needs but Claude Code itself has no concept of — keyed by agent/skill id, kept separate so the agent/skill files themselves stay ordinary and portable. */
export const CATALOG_INDEX_PATH = path.join(CATALOG_DIR, 'catalog-index.json');

/**
 * Machine-specific, git-ignored executor config (real account paths) — see
 * server/executors.example.json. Overridable so tests use a fixture instead
 * of whatever real accounts happen to be configured on the machine.
 */
export const EXECUTORS_PATH = process.env.AGENT_VISUAL_OS_EXECUTORS_PATH ?? path.join(REPO_ROOT, 'server', 'executors.json');
export const EXECUTORS_EXAMPLE_PATH = path.join(REPO_ROOT, 'server', 'executors.example.json');

export const PORT = Number(process.env.PORT ?? 4500);

/**
 * The app's own checkout root — distinct from REPO_ROOT (which never changes meaning: it's always
 * "where this daemon's source lives", resolved from this file's own location). APP_CHECKOUT_ROOT is
 * what task 7.001's update detection/apply machinery treats as "the app" for git-compare and
 * pull/build/restart purposes. They're the same directory in a real install; tests override this one
 * via AGENT_VISUAL_OS_APP_ROOT to point at a throwaway git fixture instead, the same trick
 * gitSyncPoller.test.ts uses for a Project's path, but here for the whole app root.
 */
export const APP_CHECKOUT_ROOT = process.env.AGENT_VISUAL_OS_APP_ROOT ?? REPO_ROOT;

/** Where `prod.pids`, the app-update log and its result file live — see scripts/prod-start.sh, scripts/prod-stop.sh and server/src/appUpdate/. Overridable so tests never touch the real `.run/`. */
export const RUN_DIR = process.env.AGENT_VISUAL_OS_RUN_DIR ?? path.join(APP_CHECKOUT_ROOT, '.run');

/** Set by scripts/prod-start.sh (`NODE_ENV=production`); nothing else reads it. Gates whether an app update may ever be applied in-app — see appUpdate/appUpdateDetector.ts. */
export const IS_PROD_MODE = process.env.NODE_ENV === 'production';

/** How often the daemon checks its own checkout against origin for an available update — see appUpdate/appUpdatePoller.ts. Same cadence pattern as GIT_SYNC_REFRESH_MS. */
export const APP_UPDATE_REFRESH_MS = 60_000;

/** Overridable in tests / alternate installs where the binary has a different name. */
export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

/**
 * WhatsApp notification channel config (docs/milestones/milestone-5-notification-system.md,
 * "External channels") — the same endpoint docs/notify.sh already calls,
 * wrapped in Node instead of shelled out to (see
 * server/src/notifications/channels/whatsappChannel.ts). Unlike CLAUDE_BIN,
 * these have no sensible default (no default API host/key/recipient), so
 * they're left undefined when unset and the adapter throws a clear error
 * rather than silently no-op-ing or calling `fetch` on `undefined`.
 */
export const SEND_HOST = process.env.SEND_HOST;
export const SEND_API_KEY = process.env.SEND_API_KEY;
export const SEND_TO = process.env.SEND_TO;

/**
 * How many completed Test Runs to keep per Project (active queued/running runs are never pruned) —
 * see testing/testRunner.ts. Overridable for installs that want a longer or shorter history.
 */
export const TEST_RUN_RETENTION = Math.max(1, Number(process.env.AGENT_VISUAL_OS_TEST_RUN_RETENTION) || 100);

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Adds the `documentation-n-retro-agent` Template and `maintain-project-context` Skill to a
 * per-test-file catalog directory (after the shared `fixtures/catalog` has already been copied
 * into it) — needed only by tests that exercise `startDocsBootstrapTask` with an injected fake
 * `runClaudeTurn`/`terminalSessions`, never the real ones.
 *
 * Deliberately NOT added to the shared `fixtures/catalog` itself: `api.test.ts` runs the daemon's
 * real singleton `workerManager` (real executor, no injected fake) behind every `POST /api/projects`
 * call, and `startDocsBootstrapTask` fires on every one of them — resolving this Template there would
 * make each of those tests actually spawn the real `claude` CLI.
 */
export async function installDocsRetroFixture(catalogDir: string): Promise<void> {
  const indexPath = path.join(catalogDir, 'catalog-index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf-8')) as { agents: Record<string, unknown>; skills: Record<string, unknown> };
  index.agents['documentation-n-retro-agent'] = { name: 'Documentation N Retro Agent', avatar: '📑', manager: false, defaultAutonomy: 'auto', enabled: true };
  index.skills['maintain-project-context'] = { name: 'Maintain Project Context', avatar: '🧩', enabled: true, triggers: [] };
  await writeFile(indexPath, JSON.stringify(index, null, 2));

  await writeFile(
    path.join(catalogDir, 'agents', 'documentation-n-retro-agent.md'),
    '---\nname: documentation-n-retro-agent\ndescription: Test fixture stand-in for the real documentation-n-retro-agent persona.\n---\n\n# Documentation N Retro Agent (fixture)\n',
  );

  const skillDir = path.join(catalogDir, 'skills', 'maintain-project-context');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: maintain-project-context\ndescription: Test fixture stand-in for the real maintain-project-context skill.\n---\n\n# Maintain project context (fixture)\n',
  );
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The fixed blueprint template — see docs/glossary.md#blueprint and
 * docs/architecture.md#blueprints-are-agent-authored. Nothing writes this file
 * automatically any more (see `readBlueprint`'s doc comment); a person can
 * still write it by hand through the generic `.docs` file routes, same as
 * any other file there.
 */
export const BLUEPRINT_FILENAME = 'blueprint.md';
/** Every Project's own hidden docs folder, at its root — see docs/file-structure.md. */
export const DOCS_DIR = '.docs';

export function blueprintPath(projectAbsolutePath: string): string {
  return path.join(projectAbsolutePath, DOCS_DIR, BLUEPRINT_FILENAME);
}

export function stubBlueprint(projectName: string): string {
  return `# Blueprint

**What this document is**: a living snapshot of what currently exists in "${projectName}". See agent-visual-os's own docs/glossary.md for the full definition.

## What currently exists

No Task has run yet.

## Proposed next steps

Awaiting the first Task.
`;
}

/**
 * Self-heals a missing blueprint file in place rather than throwing — the
 * same pattern `plan.ts`'s `readPlanDoc` already uses. Nothing writes this
 * file automatically any more (see docs/plan/typesafe-jev-decision-layer.md's
 * predecessor discussion — real `.docs` content now comes from the
 * `documentation-n-retro-agent` Catalog agent, not a per-Task rewrite): a
 * Project may simply never have one. Without this self-heal,
 * GET /api/projects/:id/blueprint 500s (a raw ENOENT matches no entry in
 * router.ts's STATUS_BY_ERROR) instead of returning a fresh stub.
 */
export async function readBlueprint(projectAbsolutePath: string, projectName: string): Promise<string> {
  try {
    return await readFile(blueprintPath(projectAbsolutePath), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const stub = stubBlueprint(projectName);
    await mkdir(path.dirname(blueprintPath(projectAbsolutePath)), { recursive: true });
    await writeFile(blueprintPath(projectAbsolutePath), stub);
    return stub;
  }
}

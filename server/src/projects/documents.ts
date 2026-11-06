import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { BLUEPRINT_FILENAME } from './blueprint.ts';
import { PLAN_DIR, PLAN_DOC_FILENAMES, PLAN_DOC_KEYS, PLAN_DOC_TITLES } from './plan.ts';
import { readFileSafely } from './fileTree.ts';
import type { PlanDocKey } from '../domain/types.ts';

/**
 * The Documents tab's real file tree (docs/roadmap.md's "Project Popover
 * Redesign"): the project's already-managed docs — the one blueprint file
 * and whatever's actually in its plan directory — listed by reading the
 * directory rather than assuming exactly today's five PlanDocKeys, so a doc
 * added or removed on disk shows up here without a code change. Deliberately
 * scoped to just these two known, agent-visual-os-managed locations — not
 * arbitrary repo browsing (that's fileTree.ts's Code tab).
 */

export interface ProjectDocumentEntry {
  name: string;
  title: string;
  /** Set when this file backs one of the fixed PlanDocKeys — the existing PlanDocPanel/updatePlanDoc machinery already knows how to open and save it. Null for a file found in the plan directory that isn't one of them: still listed, but opened read-only (see readPlanDocumentRaw). */
  docKey: PlanDocKey | null;
}

export interface ProjectDocuments {
  blueprint: { name: string; title: string };
  plan: ProjectDocumentEntry[];
}

const FILENAME_TO_PLAN_KEY = new Map<string, PlanDocKey>(
  PLAN_DOC_KEYS.map((key) => [PLAN_DOC_FILENAMES[key], key]),
);
const PLAN_KEY_ORDER = new Map<PlanDocKey, number>(PLAN_DOC_KEYS.map((key, index) => [key, index]));

export async function listProjectDocuments(projectRoot: string): Promise<ProjectDocuments> {
  return {
    blueprint: { name: BLUEPRINT_FILENAME, title: 'Blueprint' },
    plan: await readPlanDirEntries(path.join(projectRoot, PLAN_DIR)),
  };
}

async function readPlanDirEntries(planDir: string): Promise<ProjectDocumentEntry[]> {
  let entries;
  try {
    entries = await readdir(planDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry): ProjectDocumentEntry => {
      const docKey = FILENAME_TO_PLAN_KEY.get(entry.name) ?? null;
      return { name: entry.name, title: docKey ? PLAN_DOC_TITLES[docKey] : entry.name, docKey };
    })
    // Known docs first, in their fixed display order; anything else after, alphabetically.
    .sort((a, b) => {
      const orderA = a.docKey ? PLAN_KEY_ORDER.get(a.docKey)! : Infinity;
      const orderB = b.docKey ? PLAN_KEY_ORDER.get(b.docKey)! : Infinity;
      return orderA !== orderB ? orderA - orderB : a.name.localeCompare(b.name);
    });
}

export class UnknownPlanDocumentError extends Error {
  constructor(name: string) {
    super(`No plan document named "${name}"`);
    this.name = 'UnknownPlanDocumentError';
  }
}

/**
 * Read-only fallback for a plan-directory file that isn't one of the known PlanDocKeys — reuses
 * fileTree.ts's `readFileSafely` (resolved against the plan directory only, never the wider
 * project) so a crafted `name` still can't escape it, even though every name in practice comes
 * from `listProjectDocuments`' own readdir.
 */
export async function readPlanDocumentRaw(projectRoot: string, name: string): Promise<string> {
  const planDir = path.join(projectRoot, PLAN_DIR);
  try {
    const result = await readFileSafely(planDir, name);
    if (result.kind !== 'text') throw new UnknownPlanDocumentError(name);
    return result.content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UnknownPlanDocumentError(name);
    throw error;
  }
}

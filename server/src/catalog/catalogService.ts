import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CATALOG_AGENTS_DIR, CATALOG_DIR, CATALOG_SKILLS_DIR } from '../config.ts';
import type { Autonomy, SkillRecord, TemplateRecord } from '../domain/types.ts';
import {
  DEFAULT_AGENT_AVATAR,
  DEFAULT_AUTONOMY,
  DEFAULT_SKILL_AVATAR,
  syncCatalogIndex,
  setIndexEntry,
  updateIndexEntry,
  deleteIndexEntry,
  titleCaseId,
} from './catalogIndex.ts';
import type { AgentIndexEntry, SkillIndexEntry } from './catalogIndex.ts';
import { getAttr, parseFrontmatter, serializeFrontmatter, setAttr } from './frontmatter.ts';
import type { FrontmatterAttrs } from './frontmatter.ts';
import { agentFilePath, assertSafeFileName, assertValidId, skillDirPath, skillFilePath } from './paths.ts';
import { extractZip } from './skillZip.ts';
import { namedAtStart } from '../domain/displayName.ts';

/**
 * The Catalog: agents (→ TemplateRecord) live as `catalog/agents/<id>.md`,
 * skills (→ SkillRecord) as `catalog/skills/<id>/SKILL.md` plus whatever
 * support files sit alongside it — format-compatible with Claude Code's own
 * agent markdown / SKILL.md shape, but a fully separate folder, never the
 * real `.claude/` (see config.ts's CATALOG_DIR doc comment). Every read here
 * re-syncs the sidecar index against disk first (`syncCatalogIndex`) and
 * reads the markdown files fresh, the same "hand-edited between runs, never
 * cached" policy the old catalog/ read, so external edits (a person editing
 * a file by hand, `npx skills add` dropping in a new skill) show up
 * immediately with no restart needed.
 */

export class AgentNotFoundError extends Error {
  constructor() {
    super('This agent is not in the Catalog — it may have been deleted');
    this.name = 'AgentNotFoundError';
  }
}

export class AgentAlreadyExistsError extends Error {
  constructor(existing: Pick<TemplateRecord, 'name'>) {
    super(`${namedAtStart('agent', existing.name)} already uses this id in the Catalog — choose a different id`);
    this.name = 'AgentAlreadyExistsError';
  }
}

export class InvalidAgentFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAgentFileError';
  }
}

export class SkillNotFoundError extends Error {
  constructor() {
    super('This skill is not in the Catalog — it may have been deleted');
    this.name = 'SkillNotFoundError';
  }
}

export class SkillAlreadyExistsError extends Error {
  constructor(existing: Pick<SkillRecord, 'name'>) {
    super(`${namedAtStart('skill', existing.name)} already uses this id in the Catalog — choose a different id`);
    this.name = 'SkillAlreadyExistsError';
  }
}

export class InvalidSkillFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSkillFileError';
  }
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (!value || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

// ---- Agents (Templates) ----

function toTemplateRecord(id: string, entry: AgentIndexEntry): TemplateRecord {
  return {
    id,
    name: entry.name,
    avatar: entry.avatar,
    manager: entry.manager,
    defaultAutonomy: entry.defaultAutonomy,
    agentFile: path.posix.join('agents', `${id}.md`),
    enabled: entry.enabled,
  };
}

export async function listAgents(): Promise<TemplateRecord[]> {
  const index = await syncCatalogIndex();
  return Object.entries(index.agents).map(([id, entry]) => toTemplateRecord(id, entry));
}

export async function getAgent(id: string): Promise<TemplateRecord | undefined> {
  const agents = await listAgents();
  return agents.find((agent) => agent.id === id);
}

/** The Template a new Task uses when none is chosen explicitly — the first enabled agent, in the Catalog's own listing order. Throws if the Catalog has no enabled agent at all, since a Task always needs a persona to run. */
export async function getDefaultAgent(): Promise<TemplateRecord> {
  const agents = await listAgents();
  const first = agents.find((agent) => agent.enabled);
  if (!first) throw new Error('Catalog has no enabled agents in catalog/agents');
  return first;
}

/** The agent markdown file's body, stripped of its frontmatter, used as the Worker's persona. */
export async function readAgentPersona(agent: Pick<TemplateRecord, 'agentFile'>): Promise<string> {
  const raw = await readFile(path.join(CATALOG_DIR, agent.agentFile), 'utf-8');
  return parseFrontmatter(raw).body;
}

export interface CreateAgentInput {
  id: string;
  name: string;
  description: string;
  body?: string;
  avatar?: string;
  manager?: boolean;
  defaultAutonomy?: Autonomy;
  enabled?: boolean;
}

/** Every write path below forces the frontmatter `name:` key to equal the agent's id — that's the key Claude Code itself uses to identify a subagent, so it must always match how this Template is actually invoked, independent of whatever human-friendly display `name` the sidecar index tracks. */
function agentFrontmatter(id: string, description: string, existingAttrs: FrontmatterAttrs = []): FrontmatterAttrs {
  return setAttr(setAttr(existingAttrs, 'name', id), 'description', description);
}

export async function createAgent(input: CreateAgentInput): Promise<TemplateRecord> {
  assertValidId('agent', input.id);
  const name = requireNonEmpty(input.name, 'name');
  const description = requireNonEmpty(input.description, 'description');
  const existing = await getAgent(input.id);
  if (existing) throw new AgentAlreadyExistsError(existing);

  await mkdir(CATALOG_AGENTS_DIR, { recursive: true });
  const filePath = await agentFilePath(CATALOG_AGENTS_DIR, input.id);
  const content = serializeFrontmatter(agentFrontmatter(input.id, description), input.body ?? '');
  await writeFile(filePath, content, 'utf-8');

  await setIndexEntry('agents', input.id, {
    name,
    avatar: input.avatar?.trim() || DEFAULT_AGENT_AVATAR,
    manager: input.manager ?? false,
    defaultAutonomy: input.defaultAutonomy ?? DEFAULT_AUTONOMY,
    enabled: input.enabled ?? true,
  });

  return requireAgent(input.id);
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  body?: string;
  avatar?: string;
  manager?: boolean;
  defaultAutonomy?: Autonomy;
}

export async function updateAgent(id: string, patch: UpdateAgentInput): Promise<TemplateRecord> {
  if (!(await getAgent(id))) throw new AgentNotFoundError();

  if (patch.description !== undefined || patch.body !== undefined) {
    const filePath = await agentFilePath(CATALOG_AGENTS_DIR, id);
    const raw = await readFile(filePath, 'utf-8');
    const { attrs, body } = parseFrontmatter(raw);
    const description = patch.description !== undefined ? requireNonEmpty(patch.description, 'description') : (getAttr(attrs, 'description') ?? '');
    const nextBody = patch.body !== undefined ? patch.body : body;
    await writeFile(filePath, serializeFrontmatter(agentFrontmatter(id, description, attrs), nextBody), 'utf-8');
  }

  const indexPatch: Partial<AgentIndexEntry> = {};
  if (patch.name !== undefined) indexPatch.name = requireNonEmpty(patch.name, 'name');
  if (patch.avatar !== undefined) indexPatch.avatar = patch.avatar.trim() || DEFAULT_AGENT_AVATAR;
  if (patch.manager !== undefined) indexPatch.manager = patch.manager;
  if (patch.defaultAutonomy !== undefined) indexPatch.defaultAutonomy = patch.defaultAutonomy;
  if (Object.keys(indexPatch).length > 0) await updateIndexEntry('agents', id, indexPatch);

  return requireAgent(id);
}

export async function deleteAgent(id: string): Promise<void> {
  if (!(await getAgent(id))) throw new AgentNotFoundError();
  const filePath = await agentFilePath(CATALOG_AGENTS_DIR, id);
  await rm(filePath, { force: true });
  await deleteIndexEntry('agents', id);
}

export async function setAgentEnabled(id: string, enabled: boolean): Promise<TemplateRecord> {
  if (!(await getAgent(id))) throw new AgentNotFoundError();
  await updateIndexEntry('agents', id, { enabled });
  return requireAgent(id);
}

export interface UploadAgentInput {
  id: string;
  /** The raw `.md` file content, frontmatter and all. */
  content: string;
  name?: string;
  avatar?: string;
  manager?: boolean;
  defaultAutonomy?: Autonomy;
  enabled?: boolean;
}

/** Registers an uploaded agent markdown file as-is (frontmatter preserved, only its `name:` key is forced to match `id` — see agentFrontmatter's doc comment). */
export async function uploadAgentFile(input: UploadAgentInput): Promise<TemplateRecord> {
  assertValidId('agent', input.id);
  const existing = await getAgent(input.id);
  if (existing) throw new AgentAlreadyExistsError(existing);

  const { attrs, body } = parseFrontmatter(input.content);
  const description = getAttr(attrs, 'description');
  if (!description) throw new InvalidAgentFileError('Uploaded agent file must have a "description" in its frontmatter');

  await mkdir(CATALOG_AGENTS_DIR, { recursive: true });
  const filePath = await agentFilePath(CATALOG_AGENTS_DIR, input.id);
  await writeFile(filePath, serializeFrontmatter(agentFrontmatter(input.id, description, attrs), body), 'utf-8');

  await setIndexEntry('agents', input.id, {
    name: input.name?.trim() || titleCaseId(input.id),
    avatar: input.avatar?.trim() || DEFAULT_AGENT_AVATAR,
    manager: input.manager ?? false,
    defaultAutonomy: input.defaultAutonomy ?? DEFAULT_AUTONOMY,
    enabled: input.enabled ?? true,
  });

  return requireAgent(input.id);
}

async function requireAgent(id: string): Promise<TemplateRecord> {
  const agent = await getAgent(id);
  if (!agent) throw new AgentNotFoundError();
  return agent;
}

// ---- Skills ----

async function listSupportFiles(skillDir: string): Promise<string[]> {
  try {
    const entries = await readdir(skillDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name !== 'SKILL.md').map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function buildSkillRecord(id: string, entry: SkillIndexEntry): Promise<SkillRecord> {
  const dir = path.join(CATALOG_SKILLS_DIR, id);
  const raw = await readFile(path.join(dir, 'SKILL.md'), 'utf-8').catch(() => '');
  const description = getAttr(parseFrontmatter(raw).attrs, 'description') ?? '';
  return {
    id,
    name: entry.name,
    description,
    triggers: entry.triggers,
    avatar: entry.avatar,
    enabled: entry.enabled,
    skillDir: path.posix.join('skills', id),
    supportFiles: await listSupportFiles(dir),
  };
}

export async function listSkills(): Promise<SkillRecord[]> {
  const index = await syncCatalogIndex();
  return Promise.all(Object.entries(index.skills).map(([id, entry]) => buildSkillRecord(id, entry)));
}

export async function getSkill(id: string): Promise<SkillRecord | undefined> {
  const skills = await listSkills();
  return skills.find((skill) => skill.id === id);
}

/** The skill's SKILL.md body, stripped of its frontmatter — folded into a Worker's session context alongside its Template persona when a Task chooses this Skill. Mirrors readAgentPersona. */
export async function readSkillBody(skill: Pick<SkillRecord, 'skillDir'>): Promise<string> {
  const raw = await readFile(path.join(CATALOG_DIR, skill.skillDir, 'SKILL.md'), 'utf-8');
  return parseFrontmatter(raw).body;
}

function skillFrontmatter(id: string, description: string, existingAttrs: FrontmatterAttrs = []): FrontmatterAttrs {
  return setAttr(setAttr(existingAttrs, 'name', id), 'description', description);
}

export interface CreateSkillInput {
  id: string;
  name: string;
  description: string;
  body?: string;
  avatar?: string;
  triggers?: string[];
  enabled?: boolean;
}

export async function createSkill(input: CreateSkillInput): Promise<SkillRecord> {
  assertValidId('skill', input.id);
  const name = requireNonEmpty(input.name, 'name');
  const description = requireNonEmpty(input.description, 'description');
  const existing = await getSkill(input.id);
  if (existing) throw new SkillAlreadyExistsError(existing);

  const dir = await skillDirPath(CATALOG_SKILLS_DIR, input.id);
  await mkdir(dir, { recursive: true });
  const content = serializeFrontmatter(skillFrontmatter(input.id, description), input.body ?? '');
  await writeFile(path.join(dir, 'SKILL.md'), content, 'utf-8');

  await setIndexEntry('skills', input.id, {
    name,
    avatar: input.avatar?.trim() || DEFAULT_SKILL_AVATAR,
    enabled: input.enabled ?? true,
    triggers: input.triggers ?? [],
  });

  return requireSkill(input.id);
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  body?: string;
  avatar?: string;
  triggers?: string[];
}

export async function updateSkill(id: string, patch: UpdateSkillInput): Promise<SkillRecord> {
  if (!(await getSkill(id))) throw new SkillNotFoundError();

  if (patch.description !== undefined || patch.body !== undefined) {
    const dir = await skillDirPath(CATALOG_SKILLS_DIR, id);
    const filePath = path.join(dir, 'SKILL.md');
    const raw = await readFile(filePath, 'utf-8');
    const { attrs, body } = parseFrontmatter(raw);
    const description = patch.description !== undefined ? requireNonEmpty(patch.description, 'description') : (getAttr(attrs, 'description') ?? '');
    const nextBody = patch.body !== undefined ? patch.body : body;
    await writeFile(filePath, serializeFrontmatter(skillFrontmatter(id, description, attrs), nextBody), 'utf-8');
  }

  const indexPatch: Partial<SkillIndexEntry> = {};
  if (patch.name !== undefined) indexPatch.name = requireNonEmpty(patch.name, 'name');
  if (patch.avatar !== undefined) indexPatch.avatar = patch.avatar.trim() || DEFAULT_SKILL_AVATAR;
  if (patch.triggers !== undefined) indexPatch.triggers = patch.triggers;
  if (Object.keys(indexPatch).length > 0) await updateIndexEntry('skills', id, indexPatch);

  return requireSkill(id);
}

export async function deleteSkill(id: string): Promise<void> {
  if (!(await getSkill(id))) throw new SkillNotFoundError();
  const dir = await skillDirPath(CATALOG_SKILLS_DIR, id);
  await rm(dir, { recursive: true, force: true });
  await deleteIndexEntry('skills', id);
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<SkillRecord> {
  if (!(await getSkill(id))) throw new SkillNotFoundError();
  await updateIndexEntry('skills', id, { enabled });
  return requireSkill(id);
}

export async function addSkillSupportFile(skillId: string, fileName: string, content: Buffer): Promise<SkillRecord> {
  if (!(await getSkill(skillId))) throw new SkillNotFoundError();
  assertSafeFileName(fileName);
  const dir = await skillDirPath(CATALOG_SKILLS_DIR, skillId);
  const filePath = await skillFilePath(dir, fileName);
  await writeFile(filePath, content);
  return requireSkill(skillId);
}

export async function removeSkillSupportFile(skillId: string, fileName: string): Promise<SkillRecord> {
  if (!(await getSkill(skillId))) throw new SkillNotFoundError();
  assertSafeFileName(fileName);
  const dir = await skillDirPath(CATALOG_SKILLS_DIR, skillId);
  const filePath = await skillFilePath(dir, fileName);
  await rm(filePath, { force: true });
  return requireSkill(skillId);
}

/** Just `(await getSkill(id)).supportFiles` under the hood — a named entry point per the spec, since `SkillRecord.supportFiles` is otherwise only reachable by fetching the whole record. */
export async function listSkillSupportFiles(skillId: string): Promise<string[]> {
  const skill = await getSkill(skillId);
  if (!skill) throw new SkillNotFoundError();
  return skill.supportFiles;
}

export interface UploadSkillZipInput {
  id: string;
  zipBuffer: Buffer;
  name?: string;
  avatar?: string;
  triggers?: string[];
  enabled?: boolean;
}

/** Extracts an uploaded zip as a new skill's folder — see skillZip.ts for the zip-slip guard. Requires a SKILL.md at the zip's root; anything else is rejected (and the partially-extracted folder cleaned up) since that's what makes the result a real, invocable skill. */
export async function uploadSkillZip(input: UploadSkillZipInput): Promise<SkillRecord> {
  assertValidId('skill', input.id);
  const existing = await getSkill(input.id);
  if (existing) throw new SkillAlreadyExistsError(existing);

  const dir = await skillDirPath(CATALOG_SKILLS_DIR, input.id);
  await extractZip(input.zipBuffer, dir);

  const skillMdPath = path.join(dir, 'SKILL.md');
  let raw: string;
  try {
    raw = await readFile(skillMdPath, 'utf-8');
  } catch {
    await rm(dir, { recursive: true, force: true });
    throw new InvalidSkillFileError('The uploaded zip has no SKILL.md at its root');
  }

  const { attrs, body } = parseFrontmatter(raw);
  const description = getAttr(attrs, 'description');
  if (!description) {
    await rm(dir, { recursive: true, force: true });
    throw new InvalidSkillFileError('The uploaded zip\'s SKILL.md must have a "description" in its frontmatter');
  }
  await writeFile(skillMdPath, serializeFrontmatter(skillFrontmatter(input.id, description, attrs), body), 'utf-8');

  await setIndexEntry('skills', input.id, {
    name: input.name?.trim() || getAttr(attrs, 'name') || titleCaseId(input.id),
    avatar: input.avatar?.trim() || DEFAULT_SKILL_AVATAR,
    enabled: input.enabled ?? true,
    triggers: input.triggers ?? [],
  });

  return requireSkill(input.id);
}

async function requireSkill(id: string): Promise<SkillRecord> {
  const skill = await getSkill(id);
  if (!skill) throw new SkillNotFoundError();
  return skill;
}

export { InvalidIdError, CatalogPathTraversalError } from './paths.ts';
export { InvalidZipError, ZipSlipError } from './skillZip.ts';
export {
  InvalidRepoSlugError,
  SkillInstallNotFoundError,
  skillInstallRunner,
  createSkillInstallRunner,
} from './skillInstall.ts';
export type { SkillInstallEvent, SkillInstallRun, SkillInstallRunner } from './skillInstall.ts';

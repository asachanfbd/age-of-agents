import { randomUUID } from 'node:crypto';
import { projectCommandsDb } from '../db/collections.ts';
import type { ProjectCommandRecord } from '../domain/types.ts';

export class CommandNotFoundError extends Error {
  constructor() {
    super('This command no longer exists');
    this.name = 'CommandNotFoundError';
  }
}

/** See ProjectCommandRecord's doc comment — at most 3 highlighted commands per Project. */
export const MAX_HIGHLIGHTED_COMMANDS = 3;

export class CommandHighlightLimitError extends Error {
  constructor() {
    super(`This project already has ${MAX_HIGHLIGHTED_COMMANDS} highlighted commands — un-highlight one before highlighting another`);
    this.name = 'CommandHighlightLimitError';
  }
}

/** Every command defined for a Project, oldest first. */
export async function listCommands(projectId: string): Promise<ProjectCommandRecord[]> {
  const commands = await projectCommandsDb.find((c) => c.projectId === projectId);
  return commands.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getCommand(id: string): Promise<ProjectCommandRecord> {
  const command = await projectCommandsDb.get(id);
  if (!command) throw new CommandNotFoundError();
  return command;
}

/**
 * Throws CommandHighlightLimitError if `projectId` already has
 * MAX_HIGHLIGHTED_COMMANDS commands highlighted, `excludeId` (the command
 * being created/updated, if any) not counted against itself — shared by
 * `createCommand` (highlighting one at creation) and `updateCommand`
 * (highlighting one later) so the cap is enforced identically either way.
 */
async function assertCanHighlight(projectId: string, excludeId: string | null): Promise<void> {
  const existing = await listCommands(projectId);
  const highlightedCount = existing.filter((c) => c.id !== excludeId && c.highlighted).length;
  if (highlightedCount >= MAX_HIGHLIGHTED_COMMANDS) throw new CommandHighlightLimitError();
}

export async function createCommand(input: { projectId: string; name: string; command: string; highlighted?: boolean }): Promise<ProjectCommandRecord> {
  const highlighted = input.highlighted ?? false;
  if (highlighted) await assertCanHighlight(input.projectId, null);
  const now = new Date().toISOString();
  const record: ProjectCommandRecord = {
    id: randomUUID(),
    projectId: input.projectId,
    name: input.name,
    command: input.command,
    highlighted,
    createdAt: now,
    updatedAt: now,
  };
  return projectCommandsDb.insert(record);
}

export async function updateCommand(
  id: string,
  patch: Partial<Pick<ProjectCommandRecord, 'name' | 'command' | 'highlighted'>>,
): Promise<ProjectCommandRecord> {
  const existing = await getCommand(id);
  if (patch.highlighted === true && !existing.highlighted) await assertCanHighlight(existing.projectId, id);
  const updated = await projectCommandsDb.update(id, { ...patch, updatedAt: new Date().toISOString() });
  if (!updated) throw new CommandNotFoundError();
  return updated;
}

export async function deleteCommand(id: string): Promise<void> {
  await getCommand(id); // 404s if it doesn't exist
  await projectCommandsDb.delete(id);
}

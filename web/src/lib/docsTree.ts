import type { EntryKind } from './serverApi';

/**
 * Small helpers behind the Documents and Code tabs' file browsers: which file opens first, where a
 * newly created file or folder lands, and the create-then-refresh flow both tabs share.
 */

/** What a file browser's inline create form gets back: the created path, or the message to show under the field. */
export type CreateResult = { path: string } | { error: string };

/**
 * Creates an entry through `create`, then reloads the tree and, for a file, opens it by the path the
 * server actually created (which can differ from what was typed). A failure comes back as `{ error }`
 * without reloading, so the form can show it inline.
 */
export async function createAndReveal(
  kind: EntryKind,
  requested: string,
  { create, refresh, openFile }: {
    create: (path: string, kind: EntryKind) => Promise<{ path: string }>;
    refresh: () => Promise<void>;
    openFile: (path: string) => void;
  },
): Promise<CreateResult> {
  try {
    const created = await create(requested, kind);
    await refresh();
    if (kind === 'file') openFile(created.path);
    return { path: created.path };
  } catch (failure) {
    return { error: (failure as Error).message };
  }
}

/** The file to open initially: the first of `preferred` (case-insensitive) that exists, otherwise the alphabetically first file. */
export function pickInitialFile(files: string[], preferred: string[] = []): string | null {
  for (const name of preferred) {
    const match = files.find((file) => file.toLowerCase() === name.toLowerCase());
    if (match) return match;
  }
  return [...files].sort((a, b) => a.localeCompare(b))[0] ?? null;
}

/**
 * The folder a new entry is created in: the folder the user last opened if there is one, otherwise the
 * folder containing the selected file, otherwise the root ('' — no folder).
 */
export function entryParentFolder(selectedFile: string | null, activeFolder: string | null): string {
  if (activeFolder) return activeFolder;
  if (!selectedFile) return '';
  const slash = selectedFile.lastIndexOf('/');
  return slash === -1 ? '' : selectedFile.slice(0, slash);
}

/** Joins a parent folder and a typed name into a relative path, trimming stray slashes and spaces. */
export function joinEntryPath(parent: string, name: string): string {
  const cleaned = name.trim().replace(/^\/+|\/+$/g, '');
  return parent ? `${parent}/${cleaned}` : cleaned;
}

/** Every folder that has to be open for `path` to be visible (each ancestor of a nested file). */
export function ancestorFolders(path: string): string[] {
  const segments = path.split('/').slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

/** Whether a path names a markdown document (rendered as one), as opposed to plain text. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

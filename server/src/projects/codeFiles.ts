import { createEntry, entryPathSegments, InvalidEntryPathError } from './projectEntries.ts';
import type { EntryType } from './projectEntries.ts';

/**
 * Creates an empty file or folder anywhere in the project for the Code tab. Names are kept exactly
 * as typed (no extension is added). Anything inside a `.git` folder is refused, because writing there
 * could corrupt the repository; the name is compared case-insensitively since macOS and Windows
 * filesystems treat `.GIT` as the same folder. Returns the normalized path that was created.
 */
export async function createCodeEntry(projectRoot: string, relativePath: string, type: EntryType): Promise<string> {
  const segments = entryPathSegments(relativePath);
  if (segments.some((segment) => segment.toLowerCase() === '.git')) throw new InvalidEntryPathError(relativePath, 'files inside .git can\'t be created here');
  return createEntry(projectRoot, segments.join('/'), type);
}

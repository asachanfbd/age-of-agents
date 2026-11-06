import { useCallback } from 'react';
import { serverApi } from '../../lib/serverApi';
import type { EntryKind } from '../../lib/serverApi';
import type { ProjectData } from '../../types';
import { DocsBrowser } from './DocsBrowser';

/** The project's whole `.docs/` folder: browse it, read a file rendered as markdown, edit it, and add files and folders. */
export function DocumentsPanel({ project }: { project: ProjectData }) {
  const listTree = useCallback(() => serverApi.getDocsTree(project.id), [project.id]);
  const readFile = useCallback((path: string) => serverApi.getDocsFile(project.id, path), [project.id]);
  const saveFile = useCallback((path: string, content: string) => serverApi.saveDocsFile(project.id, path, content), [project.id]);
  const createEntry = useCallback((path: string, kind: EntryKind) => serverApi.createDocsEntry(project.id, path, kind), [project.id]);

  return <DocsBrowser listTree={listTree} readFile={readFile} saveFile={saveFile} createEntry={createEntry} />;
}

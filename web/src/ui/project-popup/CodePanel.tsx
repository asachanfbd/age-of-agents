import { useCallback } from 'react';
import { GitCompare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { serverApi } from '../../lib/serverApi';
import type { EntryKind } from '../../lib/serverApi';
import type { ProjectData } from '../../types';
import { mainFolderReloadKey } from '../../lib/gitSync';
import { CodeBrowser } from './CodeBrowser';

/**
 * The project's source tree: browse and preview files, and add new (empty) files and folders — existing
 * files stay read-only. "View diff" is part of the design but has no daemon support yet, so it is shown disabled.
 */
export function CodePanel({ project }: { project: ProjectData }) {
  const listTree = useCallback(() => serverApi.listProjectCodeTree(project.id), [project.id]);
  const readFile = useCallback((path: string) => serverApi.getProjectCodeFile(project.id, path), [project.id]);
  const createEntry = useCallback((path: string, kind: EntryKind) => serverApi.createCodeEntry(project.id, path, kind), [project.id]);

  return (
    <CodeBrowser
      rootLabel={project.name}
      scopeKey={project.id}
      reloadKey={mainFolderReloadKey(project.sync)}
      listTree={listTree}
      readFile={readFile}
      createEntry={createEntry}
      extraActions={(
        <Button type="button" variant="outline" size="sm" disabled title="Diff view is coming soon">
          <GitCompare /> View diff
        </Button>
      )}
    />
  );
}

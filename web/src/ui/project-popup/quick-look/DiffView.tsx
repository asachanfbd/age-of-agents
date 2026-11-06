import { useCallback, useEffect, useState } from 'react';
import { classifyDiffLine, diffBadge, diffCompareLabel, diffEmptyMessage, diffLiveNote, diffSourceNote, diffTotals, isWorkingCopyRemoved } from '../../../lib/quickLook';
import type { DiffLineKind } from '../../../lib/quickLook';
import { serverApi } from '../../../lib/serverApi';
import type { ChangedFile, ChangedFileStatus, QuickLookDiff, QuickLookFileDiff } from '../../../lib/serverApi';
import { LocationChip } from '../LocationChip';
import { useFileSelection } from '../useFileSelection';
import { SourceStrip, WorkingCopyRemoved } from './QuickLookParts';

type DiffLoad = { diff: QuickLookDiff } | { removed: true } | { error: string } | null;

const BADGE_STYLES: Record<ChangedFileStatus, string> = {
  added: 'bg-success/15 text-success-foreground',
  modified: 'bg-warning/15 text-warning-foreground',
  deleted: 'bg-destructive/15 text-destructive',
  renamed: 'bg-info/15 text-info-foreground',
};

const LINE_STYLES: Record<DiffLineKind, string> = {
  meta: 'text-muted-foreground',
  hunk: 'bg-info/10 text-muted-foreground',
  add: 'bg-success/15',
  del: 'bg-destructive/15',
  context: '',
};

/**
 * The Diff Quick look: the changed files (status badge and +/− counts) beside the selected file's
 * unified diff, first file selected. While the worktree exists it is the branch's changes since its
 * base, uncommitted work included; after it's removed, the kept branch; for a run without its own
 * branch, the project folder's uncommitted changes against HEAD.
 */
export function DiffView({ runId, roundNumber, onRefresh }: { runId: string; roundNumber: number; onRefresh: () => void }) {
  const [load, setLoad] = useState<DiffLoad>(null);
  const readFile = useCallback((path: string) => serverApi.getQuickLookDiffFile(runId, path), [runId]);
  const { path, load: fileLoad, open } = useFileSelection<QuickLookFileDiff>(readFile);

  useEffect(() => {
    let active = true;
    serverApi.getQuickLookDiff(runId).then((diff) => {
      if (!active) return;
      setLoad({ diff });
      if (diff.files[0]) void open(diff.files[0].path);
    }).catch((error: unknown) => {
      if (active) setLoad(isWorkingCopyRemoved(error) ? { removed: true } : { error: (error as Error).message });
    });
    return () => { active = false; };
  }, [runId, open]);

  if (!load) return <p className="p-4 pt-12 text-sm italic text-muted-foreground sm:p-6 sm:pt-12">Loading…</p>;
  if ('removed' in load) return <WorkingCopyRemoved branch={null} detail="Its branch can't be read either, so there's no diff to show." />;
  if ('error' in load) return <p role="alert" className="p-4 pt-12 text-sm font-medium text-destructive sm:p-6 sm:pt-12">{load.error}</p>;

  const { diff } = load;
  const totals = diffTotals(diff.files);
  const sourceNote = diffSourceNote(diff);
  const selected = diff.files.find((file) => file.path === path);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SourceStrip onRefresh={onRefresh} note={diffLiveNote(diff, roundNumber)}>
        <LocationChip kind={diff.source === 'project-folder' ? 'folder' : 'task'} label={diffCompareLabel(diff)} />
        {sourceNote && <span>{sourceNote}</span>}
      </SourceStrip>
      {diff.files.length === 0
        ? <p className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">{diffEmptyMessage(diff)}</p>
        : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <aside className="flex max-h-56 shrink-0 flex-col border-b md:max-h-none md:w-72 md:border-r md:border-b-0">
              <p className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
                {totals.files} {totals.files === 1 ? 'file' : 'files'} changed · <span className="text-success-foreground">+{totals.additions}</span> <span className="text-destructive">−{totals.deletions}</span>
              </p>
              <ul className="min-h-0 flex-1 overflow-y-auto py-1" aria-label="Changed files">
                {diff.files.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      aria-current={file.path === path ? 'true' : undefined}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent ${file.path === path ? 'bg-accent' : ''}`}
                      onClick={() => void open(file.path)}
                    >
                      <StatusBadge status={file.status} />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>{file.path}</span>
                      <FileCounts file={file} />
                    </button>
                  </li>
                ))}
              </ul>
            </aside>
            <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="File diff">
              {selected && (
                <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs">
                  <StatusBadge status={selected.status} />
                  <code className="truncate">{selected.oldPath ? `${selected.oldPath} → ${selected.path}` : selected.path}</code>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-auto">
                <FileDiffBody load={fileLoad} />
              </div>
            </section>
          </div>
        )}
    </div>
  );
}

function StatusBadge({ status }: { status: ChangedFileStatus }) {
  const badge = diffBadge(status);
  return (
    <span title={badge.label} aria-label={badge.label} className={`inline-grid size-4 shrink-0 place-items-center rounded font-mono text-[10px] font-semibold ${BADGE_STYLES[status]}`}>
      {badge.letter}
    </span>
  );
}

function FileCounts({ file }: { file: ChangedFile }) {
  if (file.binary) return <span className="shrink-0 text-[11px] text-muted-foreground">binary</span>;
  return (
    <span className="shrink-0 font-mono text-[11px]">
      {!!file.additions && <span className="text-success-foreground">+{file.additions}</span>}
      {!!file.additions && !!file.deletions && ' '}
      {!!file.deletions && <span className="text-destructive">−{file.deletions}</span>}
    </span>
  );
}

function FileDiffBody({ load }: { load: ReturnType<typeof useFileSelection<QuickLookFileDiff>>['load'] }) {
  if (!load) return <p className="p-4 text-sm italic text-muted-foreground">Loading…</p>;
  if (load.error !== undefined) return <p role="alert" className="p-4 text-sm font-medium text-destructive">{load.error}</p>;
  const file = load.value;
  if (file.kind === 'binary') return <p className="p-4 text-sm italic text-muted-foreground">Binary file changed.</p>;
  if (file.kind === 'too-large') return <p className="p-4 text-sm italic text-muted-foreground">This file's diff is too large to show.</p>;
  if (!file.diff) return <p className="p-4 text-sm italic text-muted-foreground">No line changes (only the file's mode or name changed).</p>;
  return (
    <div className="py-2 font-mono text-xs leading-5" role="region" aria-label={`${file.path} diff`}>
      {file.diff.split('\n').map((line, index) => (
        <div key={index} className={`whitespace-pre-wrap break-words px-4 [overflow-wrap:anywhere] ${LINE_STYLES[classifyDiffLine(line)]}`}>{line || ' '}</div>
      ))}
    </div>
  );
}

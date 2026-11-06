import { useEffect, useMemo, useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createAndReveal, isMarkdown, pickInitialFile } from '../../lib/docsTree';
import type { CreateResult } from '../../lib/docsTree';
import { buildFileTree } from '../../lib/fileTree';
import type { DocsFileContent, EntryKind, FileListing } from '../../lib/serverApi';
import { CopyButton } from '../CopyButton';
import { MarkdownDocument } from '../MarkdownDocument';
import { FileBrowser } from './FileBrowser';
import { useFileSelection } from './useFileSelection';

/**
 * A `.docs/` folder to browse and read, rendered as markdown: the Documents tab over the project's
 * folder, or a read-only Quick look over a WorkflowRun's working copy. `saveFile` adds Edit and
 * `createEntry` adds New file / New folder; without them it's read-only. `listTree` and `readFile`
 * should be stable (memoized) — a new one reloads the tree.
 */
export function DocsBrowser({
  listTree,
  readFile,
  saveFile,
  createEntry,
  onTreeError,
}: {
  listTree: () => Promise<FileListing>;
  readFile: (path: string) => Promise<DocsFileContent>;
  saveFile?: (path: string, content: string) => Promise<unknown>;
  createEntry?: (path: string, kind: EntryKind) => Promise<{ path: string }>;
  /** Called when the tree can't be loaded; the tree then shows as empty. */
  onTreeError?: (error: unknown) => void;
}) {
  const [tree, setTree] = useState<FileListing | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const { path, load, open, replace } = useFileSelection<DocsFileContent>(readFile);

  useEffect(() => {
    let active = true;
    void listTree().then((next) => {
      if (!active) return;
      setTree(next);
      const initial = pickInitialFile(next.files, ['README.md', 'blueprint.md']);
      if (initial) void open(initial);
    }).catch((error: unknown) => {
      if (!active) return;
      setTree({ files: [], folders: [] });
      onTreeError?.(error);
    });
    return () => { active = false; };
  }, [listTree, open, onTreeError]);

  const fileTree = useMemo(() => buildFileTree(tree?.files ?? [], tree?.folders ?? []), [tree]);
  const loaded = load && load.error === undefined ? load.value : undefined;
  const readable = loaded?.kind === 'text';

  function select(next: string) {
    setEditing(false);
    setSaveError('');
    void open(next);
  }

  function create(kind: EntryKind, requested: string): Promise<CreateResult> {
    return createAndReveal(kind, requested, {
      create: (entryPath, entryKind) => createEntry!(entryPath, entryKind),
      refresh: async () => setTree(await listTree()),
      openFile: select,
    });
  }

  async function save() {
    if (!path || !saveFile) return;
    setSaving(true);
    setSaveError('');
    try {
      await saveFile(path, draft);
      replace({ kind: 'text', content: draft });
      setEditing(false);
    } catch (failure) {
      setSaveError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function renderContent() {
    if (!path) return <p className="text-sm italic text-muted-foreground">Select a file from the tree to read it.</p>;
    if (!load) return <p className="text-sm italic text-muted-foreground">Loading…</p>;
    if (load.error !== undefined) return <p role="alert" className="text-sm font-medium text-destructive">{load.error}</p>;
    const content = load.value;
    if (content.kind === 'binary') return <p className="text-sm italic text-muted-foreground">Binary file — can’t preview its contents.</p>;
    if (content.kind === 'too-large') return <p className="text-sm italic text-muted-foreground">File too large to preview ({Math.round(content.size / 1024)} KB).</p>;
    if (editing) {
      return (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={saving}
          spellCheck={false}
          autoFocus
          aria-label={`Edit ${path}`}
          className="mx-auto min-h-96 w-full max-w-3xl flex-1 resize-none rounded-md border bg-transparent p-4 font-mono text-sm leading-6 shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      );
    }
    if (isMarkdown(path)) return <MarkdownDocument content={content.content} className="doc-content mx-auto w-full max-w-3xl shrink-0" />;
    return <pre className="mx-auto w-full max-w-3xl shrink-0 overflow-x-auto whitespace-pre rounded-lg border bg-muted/50 p-4 font-mono text-[0.8125rem] leading-6">{content.content}</pre>;
  }

  const actions = !readable ? null : editing ? (
    <>
      <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => { setEditing(false); setSaveError(''); }}><X /> Cancel</Button>
      <Button type="button" size="sm" disabled={saving} onClick={() => void save()}><Check /> {saving ? 'Saving…' : 'Save'}</Button>
    </>
  ) : (
    <>
      <CopyButton text={loaded.content} label="Copy file" variant="outline" size="sm">Copy</CopyButton>
      {saveFile && <Button type="button" variant="outline" size="sm" onClick={() => { setDraft(loaded.content); setEditing(true); }}><Pencil /> Edit</Button>}
    </>
  );

  return (
    <FileBrowser
      rootLabel=".docs"
      tree={fileTree}
      loading={tree === undefined}
      selected={path}
      onSelect={select}
      onCreate={createEntry ? create : undefined}
      actions={actions}
      emptyMessage="This project has no docs yet."
    >
      {saveError && <p role="alert" className="mx-auto mb-3 w-full max-w-3xl text-sm font-medium text-destructive">{saveError}</p>}
      {renderContent()}
    </FileBrowser>
  );
}

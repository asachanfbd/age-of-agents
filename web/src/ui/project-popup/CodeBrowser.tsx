import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { BookOpen, Code2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createAndReveal, isMarkdown, pickInitialFile } from '../../lib/docsTree';
import type { CreateResult } from '../../lib/docsTree';
import { buildFileTree } from '../../lib/fileTree';
import { highlightedLines, languageForPath } from '../../lib/syntaxHighlight';
import type { CodeFileContent, EntryKind, FileListing } from '../../lib/serverApi';
import { CopyButton } from '../CopyButton';
import { MarkdownDocument } from '../MarkdownDocument';
import { FileBrowser } from './FileBrowser';
import { useFileSelection } from './useFileSelection';

/**
 * A source tree to browse and preview, read-only: the Code tab over the project's folder, or a
 * Quick look over a WorkflowRun's working copy. `createEntry` adds the Code tab's New file / New
 * folder; `extraActions` sits after the file toolbar's own actions. `scopeKey` keeps a Raw markdown
 * choice from leaking into another tree's same-named file. `listTree` and `readFile` should be
 * stable (memoized) — a new one reloads the tree.
 */
export function CodeBrowser({
  rootLabel,
  scopeKey,
  reloadKey,
  listTree,
  readFile,
  createEntry,
  extraActions,
  onTreeError,
}: {
  rootLabel: string;
  scopeKey: string;
  /** Changing it reloads the tree and the opened file, e.g. after an automatic pull changed the folder. */
  reloadKey?: string;
  listTree: () => Promise<FileListing>;
  readFile: (path: string) => Promise<CodeFileContent>;
  createEntry?: (path: string, kind: EntryKind) => Promise<{ path: string }>;
  extraActions?: ReactNode;
  /** Called when the tree can't be loaded; the tree then shows as empty. */
  onTreeError?: (error: unknown) => void;
}) {
  const [listing, setListing] = useState<FileListing | undefined>(undefined);
  const [rawMarkdownFile, setRawMarkdownFile] = useState<string | null>(null);
  const { path, load, open } = useFileSelection<CodeFileContent>(readFile);

  useEffect(() => {
    let active = true;
    void listTree().then((res) => {
      if (!active) return;
      setListing(res);
      const initial = pickInitialFile(res.files, ['package.json', 'README.md']);
      if (initial) void open(initial);
    }).catch((error: unknown) => {
      if (!active) return;
      setListing({ files: [], folders: [] });
      onTreeError?.(error);
    });
    return () => { active = false; };
  }, [listTree, open, onTreeError, reloadKey]);

  const tree = useMemo(() => buildFileTree(listing?.files ?? [], listing?.folders ?? []), [listing]);
  const selectedFileKey = path ? `${scopeKey}:${path}` : null;
  const markdownView = rawMarkdownFile === selectedFileKey ? 'raw' : 'markdown';

  function create(kind: EntryKind, requested: string): Promise<CreateResult> {
    return createAndReveal(kind, requested, {
      create: (entryPath, entryKind) => createEntry!(entryPath, entryKind),
      refresh: async () => setListing(await listTree()),
      openFile: (next) => void open(next),
    });
  }

  function renderContent() {
    if (!path) return <p className="text-sm italic text-muted-foreground">Select a file from the tree to preview it.</p>;
    if (!load) return <p className="text-sm italic text-muted-foreground">Loading…</p>;
    if (load.error !== undefined) return <p role="alert" className="text-sm font-medium text-destructive">{load.error}</p>;
    const content = load.value;
    if (content.kind === 'binary') return <p className="text-sm italic text-muted-foreground">Binary file — can’t preview its contents.</p>;
    if (content.kind === 'too-large') return <p className="text-sm italic text-muted-foreground">File too large to preview ({Math.round(content.size / 1024)} KB).</p>;
    if (content.content === '') return <p className="text-sm italic text-muted-foreground">This file is empty.</p>;
    if (isMarkdown(path) && markdownView === 'markdown') {
      return <MarkdownDocument content={content.content} className="doc-content code-markdown w-full px-5 py-6 sm:px-8" />;
    }
    return <CodeView content={content.content} path={path} />;
  }

  const viewingMarkdown = !!path && isMarkdown(path);
  const loadedText = load?.error === undefined && load?.value.kind === 'text' ? load.value.content : undefined;
  const actions = (
    <>
      {viewingMarkdown && (
        <div className="flex h-8 items-center rounded-md border bg-muted/50 p-0.5" role="group" aria-label="Markdown view">
          <Button type="button" variant={markdownView === 'markdown' ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2.5 shadow-none" aria-pressed={markdownView === 'markdown'} onClick={() => setRawMarkdownFile(null)}>
            <BookOpen aria-hidden="true" /> Markdown
          </Button>
          <Button type="button" variant={markdownView === 'raw' ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2.5 shadow-none" aria-pressed={markdownView === 'raw'} onClick={() => setRawMarkdownFile(selectedFileKey)}>
            <Code2 aria-hidden="true" /> Raw
          </Button>
        </div>
      )}
      {loadedText !== undefined && <CopyButton text={loadedText} label="Copy file" variant="outline" size="sm">Copy</CopyButton>}
      {extraActions}
    </>
  );

  return (
    <FileBrowser
      rootLabel={rootLabel}
      tree={tree}
      loading={listing === undefined}
      selected={path}
      onSelect={(next) => void open(next)}
      onCreate={createEntry ? create : undefined}
      filePlaceholder="file-name.ext"
      actions={actions}
      contentClassName="p-0 sm:p-0"
    >
      {renderContent()}
    </FileBrowser>
  );
}

/** Read-only, syntax-highlighted source with line numbers and viewport-safe wrapping. */
function CodeView({ content, path }: { content: string; path: string }) {
  const language = languageForPath(path);
  const lines = useMemo(() => highlightedLines(content, language), [content, language]);
  return (
    <div className="syntax-code w-full flex-1 bg-muted/20 py-3 font-mono text-[0.8125rem] leading-6" role="region" aria-label={`${path} source code`}>
      {lines.map((line, index) => (
        <div key={index} className="flex min-w-0">
          <span className="w-14 shrink-0 border-r pr-3 text-right text-muted-foreground/55 select-none" aria-hidden="true">{index + 1}</span>
          <code
            className="min-w-0 flex-1 whitespace-pre-wrap break-words px-4 [overflow-wrap:anywhere]"
            style={{ tabSize: 2 }}
            dangerouslySetInnerHTML={{ __html: line || '&nbsp;' }}
          />
        </div>
      ))}
    </div>
  );
}

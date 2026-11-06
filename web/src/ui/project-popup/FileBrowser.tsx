import { useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { ChevronRight, FilePlus, FileText, Folder, FolderOpen, FolderPlus, FolderTree } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ancestorFolders, entryParentFolder, joinEntryPath } from '../../lib/docsTree';
import type { CreateResult } from '../../lib/docsTree';
import type { FileTreeNode } from '../../lib/fileTree';
import type { EntryKind } from '../../lib/serverApi';

const TREE_ITEM = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';

/**
 * The Documents and Code tabs' shared layout: a folder tree on the left (folders collapsed until
 * opened) under a header with small right-aligned new file / new folder icons, and on the right a
 * breadcrumb + actions bar above whatever `children` renders for the selected file. The icons open
 * an inline name field that creates the entry through the owning tab's `onCreate`; without
 * `onCreate` (a read-only Quick look) there are no create icons.
 */
export function FileBrowser({
  rootLabel,
  tree,
  loading,
  selected,
  onSelect,
  actions,
  contentClassName,
  pathOverride,
  onCreate,
  filePlaceholder = 'name.md',
  emptyMessage = 'No files found.',
  children,
}: {
  rootLabel: string;
  tree: FileTreeNode[];
  loading: boolean;
  selected: string | null;
  onSelect: (path: string) => void;
  actions?: ReactNode;
  /** Optional layout overrides for the right-hand content viewport. */
  contentClassName?: string;
  /** Replaces the breadcrumb, e.g. the Code tab's diff summary. */
  pathOverride?: ReactNode;
  onCreate?: (kind: EntryKind, path: string) => Promise<CreateResult>;
  /** Hint shown in the new-file name field. */
  filePlaceholder?: string;
  emptyMessage?: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState<EntryKind | null>(null);

  function toggleFolder(path: string) {
    setActiveFolder(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /** Expands the new entry's ancestors; a new folder is also opened and becomes where the next entry is created. */
  function reveal(path: string, kind: EntryKind) {
    setExpanded((prev) => new Set([...prev, ...ancestorFolders(path), ...(kind === 'folder' ? [path] : [])]));
    if (kind === 'folder') setActiveFolder(path);
  }

  const parent = entryParentFolder(selected, activeFolder);

  return (
    <section className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex max-h-56 shrink-0 flex-col gap-2 border-b bg-muted/30 p-3 md:max-h-none md:w-64 md:border-r md:border-b-0">
        <div className="flex items-center justify-between pl-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <FolderTree className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{rootLabel}</span>
          </span>
          {onCreate && (
            <div className="flex shrink-0 items-center">
              <CreateIcon icon={FilePlus} label="New file" onClick={() => setCreating('file')} />
              <CreateIcon icon={FolderPlus} label="New folder" onClick={() => setCreating('folder')} />
            </div>
          )}
        </div>

        {creating && onCreate && (
          <NewEntryForm
            kind={creating}
            parent={parent}
            filePlaceholder={filePlaceholder}
            onCreate={onCreate}
            onCreated={(path) => { reveal(path, creating); setCreating(null); }}
            onCancel={() => setCreating(null)}
          />
        )}

        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto" role="tree" aria-label={rootLabel}>
          {loading ? (
            <li className="px-2 text-sm italic text-muted-foreground">Loading…</li>
          ) : tree.length === 0 ? (
            <li className="px-2 text-sm italic text-muted-foreground">{emptyMessage}</li>
          ) : (
            <TreeNodes nodes={tree} depth={0} expanded={expanded} selected={selected} onToggle={toggleFolder} onSelect={(path) => { setActiveFolder(null); onSelect(path); }} />
          )}
        </ul>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-4 border-b px-4 py-2.5 sm:px-6">
          <nav className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground" aria-label="File path">
            {pathOverride ?? (selected ? <Breadcrumb root={rootLabel} path={selected} /> : <span>Select a file</span>)}
          </nav>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </div>
        <div className={cn('flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-4 py-6 sm:px-8', contentClassName)}>{children}</div>
      </div>
    </section>
  );
}

function CreateIcon({ icon: Icon, label, onClick }: { icon: typeof FilePlus; label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="size-6 text-muted-foreground [&_svg]:!size-3.5"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}

function Breadcrumb({ root, path }: { root: string; path: string }) {
  const segments = [root, ...path.split('/')];
  return (
    <>
      {segments.map((segment, index) =>
        index === segments.length - 1 ? (
          <span key={index} className="truncate font-medium text-foreground">{segment}</span>
        ) : (
          <span key={index} className="flex min-w-0 items-center gap-1">
            <span className="truncate">{segment}</span>
            <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
          </span>
        ),
      )}
    </>
  );
}

function TreeNodes({
  nodes,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  nodes: FileTreeNode[];
  depth: number;
  expanded: ReadonlySet<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const indent = { paddingLeft: 8 + depth * 16 };
        if (node.type === 'file') {
          const active = node.path === selected;
          return (
            <li key={node.path} role="none">
              <button type="button" role="treeitem" aria-selected={active} className={`${TREE_ITEM} ${active ? 'bg-accent font-medium' : ''}`} style={indent} onClick={() => onSelect(node.path)}>
                <FileText aria-hidden="true" />
                <span className="truncate">{node.name}</span>
              </button>
            </li>
          );
        }
        const open = expanded.has(node.path);
        return (
          <li key={node.path} role="none">
            <button type="button" role="treeitem" aria-expanded={open} className={TREE_ITEM} style={indent} onClick={() => onToggle(node.path)}>
              <ChevronRight className={`!size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
              {open ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
              <span className="truncate">{node.name}</span>
            </button>
            {open && (
              <ul role="group" className="mt-0.5 space-y-0.5">
                <TreeNodes nodes={node.children ?? []} depth={depth + 1} expanded={expanded} selected={selected} onToggle={onToggle} onSelect={onSelect} />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

/** Inline name field for a new file or folder — Enter creates it inside `parent`, Escape cancels. */
function NewEntryForm({
  kind,
  parent,
  filePlaceholder,
  onCreate,
  onCreated,
  onCancel,
}: {
  kind: EntryKind;
  parent: string;
  filePlaceholder: string;
  onCreate: (kind: EntryKind, path: string) => Promise<CreateResult>;
  onCreated: (path: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    setError('');
    const result = await onCreate(kind, joinEntryPath(parent, name));
    setPending(false);
    if ('error' in result) setError(result.error);
    else onCreated(result.path);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <Input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={kind === 'file' ? filePlaceholder : 'folder-name'}
        aria-label={kind === 'file' ? 'New file name' : 'New folder name'}
        disabled={pending}
        className="h-8 text-sm"
      />
      <p className="px-1 text-xs text-muted-foreground">{parent ? `In ${parent}/` : 'At the top level'}. Enter to create, Esc to cancel.</p>
      {error && <p role="alert" className="px-1 text-xs text-destructive">{error}</p>}
    </form>
  );
}

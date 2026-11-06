/**
 * Builds a nested, sorted tree from a flat list of '/'-separated relative file paths — shared by
 * the Documents tab (the project's `.docs/` folder, from GET .../docs/tree) and the Code tab (the
 * project's real file list from GET .../code/tree), so both render through the same tree component
 * instead of two parallel implementations.
 */

export interface FileTreeNode {
  name: string;
  /** Full '/'-separated path from the tree's root — unique, and what selecting a leaf reports back. */
  path: string;
  type: 'file' | 'dir';
  /** Present (possibly empty) only for a 'dir' node; sorted the same way as the root list. */
  children?: FileTreeNode[];
}

/** Directories first (alphabetical among themselves), then files (alphabetical) — the conventional file-explorer ordering. */
function compareNodes(a: FileTreeNode, b: FileTreeNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
  nodes.sort(compareNodes);
  for (const node of nodes) if (node.children) sortTree(node.children);
  return nodes;
}

/**
 * `folders` lists directories that must appear even when they hold no files (an empty folder just
 * created in the Documents tab); directories implied by a file's path are built either way.
 */
export function buildFileTree(paths: string[], folders: string[] = []): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const dirsByPath = new Map<string, FileTreeNode>();
  const seenFiles = new Set<string>();

  function ensureDir(parentChildren: FileTreeNode[], parentPath: string, name: string): FileTreeNode {
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    let dir = dirsByPath.get(fullPath);
    if (!dir) {
      dir = { name, path: fullPath, type: 'dir', children: [] };
      dirsByPath.set(fullPath, dir);
      parentChildren.push(dir);
    }
    return dir;
  }

  for (const raw of folders) {
    let children = root;
    let parentPath = '';
    for (const segment of raw.split('/').filter(Boolean)) {
      const dir = ensureDir(children, parentPath, segment);
      children = dir.children!;
      parentPath = dir.path;
    }
  }

  for (const raw of paths) {
    const segments = raw.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    let children = root;
    let parentPath = '';
    for (const segment of segments.slice(0, -1)) {
      const dir = ensureDir(children, parentPath, segment);
      children = dir.children!;
      parentPath = dir.path;
    }

    const name = segments[segments.length - 1]!;
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    if (seenFiles.has(fullPath) || dirsByPath.has(fullPath)) continue; // a duplicate path, or one that collides with a directory already built from another entry
    seenFiles.add(fullPath);
    children.push({ name, path: fullPath, type: 'file' });
  }

  return sortTree(root);
}

/** Every 'file' node in a tree, depth-first — used to validate/locate a selection without re-walking the raw path list. */
export function flattenFiles(nodes: FileTreeNode[]): FileTreeNode[] {
  const files: FileTreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') files.push(node);
    else if (node.children) files.push(...flattenFiles(node.children));
  }
  return files;
}

/**
 * Reads and writes the `---\nkey: value\n...\n---\n<body>` frontmatter block
 * every agent markdown file and SKILL.md in this repo's real `.claude/` uses
 * — the exact shape Claude Code itself reads. Only simple single-line scalar
 * values are supported (every real frontmatter value in this repo's agents
 * and skills is one line, even the long `description` ones — see the
 * server-daemon-architect task brief that confirmed this format), not
 * multi-line YAML block scalars or nested structures.
 *
 * Attributes are kept as an ordered `[key, value][]`, not a plain object, so
 * a round-trip through `parseFrontmatter` → `serializeFrontmatter` preserves
 * both the order and any keys this module doesn't know about (e.g.
 * `disable-model-invocation` on roadmap-runner's SKILL.md) instead of
 * silently reformatting or dropping them.
 */

export type FrontmatterAttrs = [key: string, value: string][];

export interface ParsedMarkdown {
  attrs: FrontmatterAttrs;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): ParsedMarkdown {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { attrs: [], body: raw.trim() };
  const [, block, rest] = match;
  const attrs: FrontmatterAttrs = [];
  for (const line of (block ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    attrs.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return { attrs, body: (rest ?? '').trim() };
}

export function serializeFrontmatter(attrs: FrontmatterAttrs, body: string): string {
  const block = attrs.map(([key, value]) => `${key}: ${value}`).join('\n');
  return `---\n${block}\n---\n\n${body.trim()}\n`;
}

export function getAttr(attrs: FrontmatterAttrs, key: string): string | undefined {
  return attrs.find(([k]) => k === key)?.[1];
}

/** Sets `key` to `value` in place semantics (returns a new array): updates it where it already is if present, otherwise appends it. */
export function setAttr(attrs: FrontmatterAttrs, key: string, value: string): FrontmatterAttrs {
  const idx = attrs.findIndex(([k]) => k === key);
  if (idx === -1) return [...attrs, [key, value]];
  const next: FrontmatterAttrs = [...attrs];
  next[idx] = [key, value];
  return next;
}

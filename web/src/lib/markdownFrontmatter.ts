/**
 * Splits a leading YAML frontmatter block (`---` … `---`) off a markdown document and parses it into
 * a small display tree, so the viewer can show it as a readable key/value table instead of letting
 * the markdown renderer collapse it into one run-on paragraph.
 *
 * This is deliberately a display-oriented subset of YAML — `key: value` pairs, nested maps, `- item`
 * and `[a, b]` lists, `|`/`>` block scalars, quotes and comments. Anything it can't read as keys is
 * left in the body untouched, so ordinary content that happens to start with `---` renders as before.
 */

export type FrontmatterValue =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: FrontmatterValue[] }
  | { kind: 'map'; entries: FrontmatterEntry[] };

export interface FrontmatterEntry {
  key: string;
  value: FrontmatterValue;
}

export interface SplitMarkdown {
  frontmatter: FrontmatterEntry[] | null;
  body: string;
}

const FRONTMATTER_BLOCK = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const KEY_LINE = /^("[^"]*"|'[^']*'|[^\s#\-:][^:]*?):(?:[ \t]+(.*))?$/;
const LIST_ITEM = /^-(?:[ \t]+(.*))?$/;

export function splitFrontmatter(content: string): SplitMarkdown {
  const match = FRONTMATTER_BLOCK.exec(content);
  const entries = match?.[1] ? parseEntries(match[1].split(/\r?\n/)) : null;
  if (!match || !entries?.length) return { frontmatter: null, body: content };
  return { frontmatter: entries, body: content.slice(match[0].length) };
}

function parseEntries(lines: string[]): FrontmatterEntry[] | null {
  const entries: FrontmatterEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isIgnorable(lines[i])) { i++; continue; }
    const match = KEY_LINE.exec(lines[i]);
    if (!match) return null;
    const children = takeChildren(lines, i + 1, true);
    entries.push({ key: unquote(match[1]), value: parseValue(match[2] ?? '', dedent(children)) });
    i += 1 + children.length;
  }
  return entries;
}

/** Lines after `start` that belong to the line before it: blanks, indented lines, and (for keys) same-level `- ` items. */
function takeChildren(lines: string[], start: number, allowFlushListItems: boolean): string[] {
  let end = start;
  while (end < lines.length && belongsToParent(lines[end], allowFlushListItems)) end++;
  return lines.slice(start, end);
}

function belongsToParent(line: string, allowFlushListItems: boolean): boolean {
  return line.trim() === '' || /^[ \t]/.test(line) || (allowFlushListItems && LIST_ITEM.test(line));
}

function parseValue(inline: string, children: string[]): FrontmatterValue {
  const scalar = stripComment(inline).trim();
  const content = children.filter((line) => !isIgnorable(line));

  if (/^[|>][+-]?\d*$/.test(scalar)) return text(blockScalar(scalar[0] === '|', children));
  if (scalar.startsWith('[') && scalar.endsWith(']')) return { kind: 'list', items: inlineList(scalar.slice(1, -1)) };
  if (scalar) return text(unquote([scalar, ...content.map((line) => line.trim())].join(' ')));
  if (!content.length) return text('');
  if (LIST_ITEM.test(content[0])) return parseList(children) ?? text(content.join('\n'));
  const entries = parseEntries(children);
  return entries ? { kind: 'map', entries } : text(content.map((line) => line.trim()).join(' '));
}

function parseList(lines: string[]): FrontmatterValue | null {
  const items: FrontmatterValue[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isIgnorable(lines[i])) { i++; continue; }
    const match = LIST_ITEM.exec(lines[i]);
    if (!match) return null;
    const children = takeChildren(lines, i + 1, false);
    items.push(parseListItem(match[1] ?? '', dedent(children)));
    i += 1 + children.length;
  }
  return { kind: 'list', items };
}

/** `- name: x` followed by `  role: y` is a map item; anything else is a plain value. */
function parseListItem(inline: string, children: string[]): FrontmatterValue {
  if (KEY_LINE.test(inline)) {
    const entries = parseEntries([inline, ...children]);
    if (entries) return { kind: 'map', entries };
  }
  return parseValue(inline, children);
}

function blockScalar(literal: boolean, lines: string[]): string {
  const body = dedent(lines);
  if (literal) return body.join('\n').trimEnd();
  return body.map((line) => line.trim()).join('\n').trim().split(/\n{2,}/).map((para) => para.replace(/\n/g, ' ')).join('\n');
}

function inlineList(inner: string): FrontmatterValue[] {
  return inner.split(',').map((item) => item.trim()).filter(Boolean).map((item) => text(unquote(item)));
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut));
}

function stripComment(value: string): string {
  return /^["']/.test(value.trim()) ? value : value.replace(/(^|\s)#.*$/, '');
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$/s.exec(value) ?? /^'(.*)'$/s.exec(value);
  if (!quoted) return value;
  return value[0] === '"' ? quoted[1].replace(/\\"/g, '"') : quoted[1].replace(/''/g, "'");
}

function isIgnorable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

function text(value: string): FrontmatterValue {
  return { kind: 'text', text: value };
}

/**
 * The text a "copy value" button puts on the clipboard: plain values as-is, lists and maps as YAML
 * so a copied block pastes back into a frontmatter unchanged in meaning.
 */
export function frontmatterValueText(value: FrontmatterValue): string {
  if (value.kind === 'text') return value.text;
  return yamlLines(value).join('\n');
}

function yamlLines(value: FrontmatterValue): string[] {
  if (value.kind === 'text') return value.text.split('\n');
  if (value.kind === 'list') return value.items.flatMap((item) => nestUnder('- ', yamlLines(item)));
  return value.entries.flatMap(({ key, value: child }) => {
    const lines = yamlLines(child);
    if (child.kind === 'text' && lines.length === 1) return [`${key}: ${lines[0]}`.trimEnd()];
    if (child.kind === 'text') return [`${key}: |`, ...indent(lines)];
    if (!lines.length) return [`${key}: ${child.kind === 'list' ? '[]' : '{}'}`];
    return [`${key}:`, ...indent(lines)];
  });
}

/** Prefixes the first line (`- `) and aligns the rest beneath it, the way YAML nests a list item. */
function nestUnder(prefix: string, lines: string[]): string[] {
  if (!lines.length) return [prefix.trimEnd()];
  return lines.map((line, index) => (index === 0 ? `${prefix}${line}` : `  ${line}`).trimEnd());
}

function indent(lines: string[]): string[] {
  return lines.map((line) => (line ? `  ${line}` : line));
}

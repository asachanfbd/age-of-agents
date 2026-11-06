import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Agent summaries and reports follow a house style (TL;DR, `###` sections, tables, blockquotes,
// task lists). These tests render a sample through the same react-markdown + GFM setup
// MarkdownDocument uses, and pin the `.doc-content` styles that keep it readable in the run view's
// narrow Summary column.

const css = await readFile(new URL('../src/styles/shadcn.css', import.meta.url), 'utf8');
const markdownDocument = await readFile(new URL('../src/ui/MarkdownDocument.tsx', import.meta.url), 'utf8');

const SAMPLE_SUMMARY = [
  '**TL;DR:** Issues. Export works, but two problems block merging.',
  '',
  '### Issues',
  '',
  '| Severity | Where | Fix |',
  '| --- | --- | --- |',
  '| major | `web/src/lib/a-very-long-file-name-that-would-not-fit.ts:42` | Guard the null row |',
  '| minor | `export.ts:7` | Rename `buildCsv` |',
  '',
  '> Large exports are not paginated yet.',
  '',
  '### Next steps',
  '',
  '- [ ] Add the null guard',
  '- [x] Rename the helper',
].join('\n');

const render = (content) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, content));

/** The body of one CSS rule, e.g. `.doc-content table` — its `@apply` list and declarations. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped} \\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule ${selector}`);
  return match[1];
}

test('MarkdownDocument renders through react-markdown with the GFM plugin, the setup these tests reproduce', () => {
  assert.match(markdownDocument, /<Markdown remarkPlugins=\{\[remarkGfm\]\}>\{body\}<\/Markdown>/);
});

test('a house-style summary renders its heading, table, blockquote and task list as real elements', () => {
  const html = render(SAMPLE_SUMMARY);
  assert.match(html, /<p><strong>TL;DR:<\/strong> Issues\./);
  assert.match(html, /<h3>Issues<\/h3>/);
  assert.match(html, /<table>\s*<thead>\s*<tr>\s*<th>Severity<\/th>\s*<th>Where<\/th>\s*<th>Fix<\/th>/);
  assert.equal(html.match(/<tr>/g)?.length, 3, 'header row plus both issue rows');
  assert.match(html, /<td><code>web\/src\/lib\/a-very-long-file-name-that-would-not-fit\.ts:42<\/code><\/td>/);
  assert.match(html, /<blockquote>\s*<p>Large exports are not paginated yet\.<\/p>\s*<\/blockquote>/);
  assert.match(html, /<ul class="contains-task-list">/);
  assert.match(html, /<li class="task-list-item"><input type="checkbox" disabled=""\/> Add the null guard<\/li>/);
  assert.match(html, /<input type="checkbox" disabled="" checked=""\/> Rename the helper/);
});

test('a table in the Summary column wraps or scrolls inside itself instead of overflowing the column', () => {
  assert.match(rule('.doc-content'), /min-w-0/);
  assert.match(rule('.doc-content'), /break-words/);
  const table = rule('.doc-content table');
  assert.match(table, /\bblock\b/, 'a block table shrinks to fit its column');
  assert.match(table, /max-w-full/);
  assert.match(table, /overflow-x-auto/);
  assert.doesNotMatch(table, /(^|\s)w-full/, 'no forced width that would stretch narrow tables');
  assert.match(rule('.doc-content :is(th, td) code'), /overflow-wrap: anywhere/, 'long paths in cells can wrap');
  assert.match(rule('.doc-content th'), /align-top/);
  assert.match(rule('.doc-content td'), /align-top/);
});

test('the Code tab keeps its full-width fixed-layout table, never a nested horizontal scroller', () => {
  const codeTable = rule('.code-markdown table');
  assert.match(codeTable, /@apply table w-full overflow-visible/);
  assert.match(codeTable, /table-layout: fixed/);
});

test('a blockquote stands out as a must-not-miss callout, not dimmed italic text', () => {
  const blockquote = rule('.doc-content blockquote');
  assert.match(blockquote, /border-l-4 border-primary/);
  assert.match(blockquote, /bg-muted\/50/);
  assert.match(blockquote, /text-foreground/);
  assert.doesNotMatch(blockquote, /italic|text-muted-foreground/);
  assert.match(rule('.doc-content blockquote > :last-child'), /mb-0/);
});

test('task lists show checkboxes instead of bullets, and h4 (a step section nested in the fallback report) has a style', () => {
  assert.match(rule('.doc-content ul.contains-task-list'), /list-none/);
  assert.match(rule(".doc-content .task-list-item input[type='checkbox']"), /mr-2/);
  assert.match(rule('.doc-content h4'), /font-semibold/);
});

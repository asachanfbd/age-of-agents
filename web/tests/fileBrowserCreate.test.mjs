import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// The web package has no DOM test harness, so these guard the wiring by reading the panels' source.
const read = (name) => readFile(new URL(`../src/ui/project-popup/${name}`, import.meta.url), 'utf8');
const [browser, codePanel, docsPanel, codeBrowser, docsBrowser] = await Promise.all(
  ['FileBrowser.tsx', 'CodePanel.tsx', 'DocumentsPanel.tsx', 'CodeBrowser.tsx', 'DocsBrowser.tsx'].map(read),
);

test('FileBrowser shows New file / New folder only with onCreate, and never as disabled icons', () => {
  assert.match(browser, /onCreate\?: \(kind: EntryKind, path: string\) => Promise<CreateResult>;/);
  assert.match(browser, /\{onCreate && \(\s*<div className="flex shrink-0 items-center">\s*<CreateIcon icon=\{FilePlus\}/);
  assert.match(browser, /\{creating && onCreate && \(/);
  assert.doesNotMatch(browser, /coming soon/);
  assert.doesNotMatch(browser, /disabled=\{!enabled\}/);
});

test('FileBrowser defaults the new-file placeholder to name.md and passes it to the form', () => {
  assert.match(browser, /filePlaceholder = 'name\.md'/);
  assert.match(browser, /placeholder=\{kind === 'file' \? filePlaceholder : 'folder-name'\}/);
});

test('FileBrowser makes a newly created folder the active folder for the next create', () => {
  assert.match(browser, /if \(kind === 'folder'\) setActiveFolder\(path\);/);
});

test('CodePanel creates entries through createCodeEntry and keeps its disabled View diff; CodeBrowser refreshes the tree and uses a code-file placeholder', () => {
  assert.match(codePanel, /serverApi\.createCodeEntry\(project\.id, path, kind\)/);
  assert.match(codePanel, /createEntry=\{createEntry\}/);
  assert.match(codePanel, /disabled title="Diff view is coming soon"/);
  assert.match(codeBrowser, /onCreate=\{createEntry \? create : undefined\}/);
  assert.match(codeBrowser, /filePlaceholder="file-name\.ext"/);
  assert.match(codeBrowser, /refresh: async \(\) => setListing\(await listTree\(\)\)/);
  assert.match(codeBrowser, /buildFileTree\(listing\?\.files \?\? \[\], listing\?\.folders \?\? \[\]\)/);
});

test('CodeBrowser shows an empty file as "This file is empty." instead of a blank numbered line', () => {
  assert.match(codeBrowser, /if \(content\.content === ''\) return <p[^>]*>This file is empty\.<\/p>;/);
});

test('DocumentsPanel still creates through createDocsEntry and saves; DocsBrowser keeps the default placeholder and offers Edit only with saveFile', () => {
  assert.match(docsPanel, /serverApi\.createDocsEntry\(project\.id, path, kind\)/);
  assert.match(docsPanel, /serverApi\.saveDocsFile\(project\.id, path, content\)/);
  assert.match(docsPanel, /<DocsBrowser listTree=\{listTree\} readFile=\{readFile\} saveFile=\{saveFile\} createEntry=\{createEntry\} \/>/);
  assert.match(docsBrowser, /onCreate=\{createEntry \? create : undefined\}/);
  assert.match(docsBrowser, /\{saveFile && <Button[^>]*>.*Edit<\/Button>\}/);
  assert.doesNotMatch(docsBrowser, /filePlaceholder=/);
});

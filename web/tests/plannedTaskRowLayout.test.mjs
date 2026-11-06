import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Planning-session rows render through the shared TaskRow shell, so the layout guarantees are checked
// there. (The Tasks tab is a board of cards now — see taskBoard.test.mjs.) Archive availability is
// behaviour, and is covered against the view-model in projectTasks.test.mjs.
const rowShell = await readFile(new URL('../src/ui/project-popup/TaskRow.tsx', import.meta.url), 'utf8');
const rowViews = await readFile(new URL('../src/ui/project-popup/TaskRows.tsx', import.meta.url), 'utf8');

test('task rows constrain long titles inside the available width', () => {
  assert.match(rowShell, /<li[^>]+className="[^"]*group[^"]*flex[^"]*"/);
  assert.match(rowShell, /<div className="[^"]*min-w-0[^"]*flex-1[^"]*"/, 'the text column can shrink below its content width');
  assert.match(rowShell, /<p className="[^"]*truncate[^"]*"[^>]*>\{title\}<\/p>/, 'the title truncates rather than wrapping');
});

test('task row titles and controls never add an underline on hover', () => {
  assert.doesNotMatch(rowShell, /hover:underline/);
  assert.doesNotMatch(rowViews, /hover:underline/);
});

test('a row shows a faded summary when collapsed and swaps to the description and tags on hover or focus', () => {
  assert.match(rowShell, /group-hover:grid-rows-\[0fr\][^"]*group-hover:opacity-0|group-hover:opacity-0/, 'the summary fades out');
  assert.match(rowShell, /group-hover:grid-rows-\[1fr\]/, 'the details open');
  assert.match(rowShell, /group-focus-within:grid-rows-\[1fr\]/, 'keyboard focus opens them too');
});

test('a row that needs the user shows its attention badge beside the title, visible while collapsed', () => {
  assert.match(rowShell, /\{attention && <AttentionTag attention=\{attention\} \/>\}/);
});

test('a row description shows one line with a chevron that expands it to the full wrapped text in place', () => {
  assert.match(rowShell, /<TaskDescription text=\{description\} expanded=\{expanded\} onToggle=\{\(\) => setExpanded\(\(open\) => !open\)\} \/>/);
  assert.match(rowShell, /expanded \? 'break-words whitespace-pre-wrap' : 'truncate'/, 'collapsed truncates; expanded wraps and keeps line breaks');
  assert.match(rowShell, /aria-expanded=\{expanded\}/, 'the toggle announces its state');
  assert.match(rowShell, /<ChevronDown className=\{`[^`]*\$\{expanded \? 'rotate-180' : ''\}`\} \/>/, 'the chevron flips when open');
});

test('an expanded row keeps its details open after the pointer leaves', () => {
  assert.match(rowShell, /data-expanded=\{expanded\}/);
  assert.match(rowShell, /group-data-\[expanded=true\]:grid-rows-\[0fr\] group-data-\[expanded=true\]:opacity-0/, 'the summary stays hidden');
  assert.match(rowShell, /group-data-\[expanded=true\]:grid-rows-\[1fr\] group-data-\[expanded=true\]:opacity-100/, 'the details stay shown');
});

test('the session details offer no Interim commit (a card still offers it from its ⋮ menu — see taskBoard.test.mjs)', async () => {
  const detailsView = await readFile(new URL('../src/ui/project-popup/TaskDetailsView.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(detailsView, /InterimCommit|interimCommit|canInterimCommit/);
});

test('a planning row deletes through the panel once idle — no longer "coming soon"', () => {
  assert.match(rowViews, /<IconAction icon=\{Trash2\} label="Delete" disabled=\{!row\.canArchive\} onClick=\{\(\) => onDelete\(row\.id\)\}/);
  assert.doesNotMatch(rowViews, /coming soon/);
});

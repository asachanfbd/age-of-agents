import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Let Node's built-in TypeScript stripping resolve the app's extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  QUICK_LOOK_OPTIONS,
  commandsWhereLabel,
  QUICK_LOOK_VIEW_LABELS,
  quickLookViewFor,
  hasQuickLookCommands,
  runLocationLabel,
  liveNote,
  isWorkingCopyRemoved,
  workingCopyRemovedDetail,
  commandLocationLabel,
  canRerunCommandRun,
  orderedCommands,
  commandMenuState,
  minimizedTaskRuns,
  diffBadge,
  diffTotals,
  classifyDiffLine,
  diffCompareLabel,
  diffSourceNote,
  diffEmptyMessage,
  diffLiveNote,
} = await import('../src/lib/quickLook.ts');

// A step's Quick look (task 5.008). Behaviour is tested against the pure helpers in lib/quickLook.ts;
// the components' wiring is pinned against their source, as the other web tests do (no DOM harness).
const read = (file) => readFile(new URL(`../src/ui/${file}`, import.meta.url), 'utf8');
const [runView, pane, parts, diffView, commandsMenu, logPopup, commandsPanel, header, catalog, dialogs, chip] = await Promise.all([
  'project-popup/WorkflowRunView.tsx',
  'project-popup/quick-look/QuickLookPane.tsx',
  'project-popup/quick-look/QuickLookParts.tsx',
  'project-popup/quick-look/DiffView.tsx',
  'project-popup/quick-look/QuickLookCommands.tsx',
  'project-popup/commands/CommandLogPopup.tsx',
  'project-popup/commands/CommandsPanel.tsx',
  'project-popup/HeaderCommands.tsx',
  'CatalogModal.tsx',
  'project-popup/commands/CommandDialogs.tsx',
  'project-popup/LocationChip.tsx',
].map(read));

const run = (overrides = {}) => ({ id: 'r', projectId: 'p', commandId: 'c', commandName: 'Test', commandText: 'npm test', origin: 'saved', status: 'running', exitCode: null, output: '', startedAt: '2026-01-01T00:00:00Z', completedAt: null, ...overrides });
const taskLocation = (workflowRunId = 'wr-1') => ({ kind: 'task', workflowRunId, planItemId: 'item', branch: 'task/5-008', taskRef: '5.008' });

// ---- Which quick look a step offers ----

test('None or absent offers no view and no commands, so the step keeps today\'s Summary/Session toggle', () => {
  for (const step of [{}, { quickLook: 'none' }, { quickLook: null }, null, undefined]) {
    assert.equal(quickLookViewFor(step), null);
    assert.equal(hasQuickLookCommands(step), false);
  }
});

test('Code, Diff and Documents are a third view labelled Code / Diff / Docs; Commands is a menu, not a view', () => {
  assert.equal(quickLookViewFor({ quickLook: 'code' }), 'code');
  assert.equal(quickLookViewFor({ quickLook: 'diff' }), 'diff');
  assert.equal(quickLookViewFor({ quickLook: 'documents' }), 'documents');
  assert.deepEqual(QUICK_LOOK_VIEW_LABELS, { code: 'Code', diff: 'Diff', documents: 'Docs' });
  assert.equal(quickLookViewFor({ quickLook: 'commands' }), null);
  assert.equal(hasQuickLookCommands({ quickLook: 'commands' }), true);
});

test('the run view offers the quick look on every round: the switch depends on the step, and the pane reads the run, never a round', () => {
  assert.match(runView, /const view = earlier \? null : quickLookViewFor\(stage\.step\);/, 'only a round of this run has a working copy to look at');
  assert.match(runView, /const withCommands = !earlier && hasQuickLookCommands\(stage\.step\);/);
  assert.match(runView, /<QuickLookPane run=\{run\} view=\{view\} roundNumber=\{round\.round\} \/>/);
  assert.match(runView, /<StepViewSwitch mode=\{shownMode\} view=\{view\} hasSession=\{!!round\.taskId\} onChange=\{chooseMode\} \/>/);
  assert.match(runView, /\{withCommands && <QuickLookCommands run=\{run\} compact=\{shownMode === 'session'\} \/>\}/);
  assert.match(runView, /const hasControls = !!\(view \|\| withCommands \|\| round\.taskId\);/, 'a skipped round (no session) still gets the quick look');
  assert.doesNotMatch(pane, /round\.id|stepRun/);
});

test('the step view switch is a labelled group of pressed-state segments, icons only over the session, and leaves Session out without one', () => {
  assert.match(runView, /role="group" aria-label="Step view"/);
  assert.match(runView, /\.\.\.\(hasSession \? \[\{ key: 'session' as const, label: 'Session', Icon: SquareTerminal \}\] : \[\]\)/);
  assert.match(runView, /aria-pressed=\{mode === key\}\s*aria-label=\{label\}\s*title=\{label\}/);
  assert.match(runView, /\{!compact && label\}/);
  assert.match(runView, /const compact = mode === 'session';/);
});

// ---- Source strip, location and removed states ----

test('the location chip names the task working copy or the project folder', () => {
  assert.equal(runLocationLabel({ kind: 'worktree', branch: 'task/x', baseBranch: 'main' }), 'Task working copy');
  assert.equal(runLocationLabel({ kind: 'project-folder', branch: 'main', baseBranch: null }), 'Project folder');
  assert.equal(runLocationLabel({ kind: 'removed', branch: 'task/x', baseBranch: 'main' }), 'Working copy removed');
  assert.match(pane, /`\$\{runLocationLabel\(location\)\} · \$\{location\.branch\}`/);
});

test('the live note says it is the current state, not the round\'s snapshot', () => {
  assert.equal(liveNote({ kind: 'worktree' }, 2), 'Live: current state, not a snapshot of Round 2');
  assert.equal(liveNote({ kind: 'project-folder' }, 1), 'Live: this run works directly in the project folder');
  assert.match(parts, /aria-label="Refresh" title="Refresh" onClick=\{onRefresh\}/);
  assert.match(pane, /const refresh = useCallback\(\(\) => setRefreshKey\(\(key\) => key \+ 1\), \[\]\);/);
});

test('a 410 means the working copy was removed; the removed state names the kept branch', () => {
  assert.equal(isWorkingCopyRemoved({ status: 410 }), true);
  assert.equal(isWorkingCopyRemoved({ status: 404 }), false);
  assert.equal(isWorkingCopyRemoved(new Error('x')), false);
  assert.equal(isWorkingCopyRemoved(null), false);
  assert.equal(workingCopyRemovedDetail('task/x'), 'It was cleaned up when the run completed. The branch task/x is kept.');
  assert.match(parts, /\{WORKING_COPY_REMOVED_TITLE\}/);
  assert.match(pane, /if \(location\.kind === 'removed' \|\| removed\) return <WorkingCopyRemoved branch=/);
  assert.match(pane, /if \(isWorkingCopyRemoved\(error\)\) setRemovedKey\(loadKey\)/, 'a read answering 410 later switches to the removed state');
});

test('Code and Docs quick looks reuse the tabs\' browsers, read-only: no create, edit or View diff', () => {
  assert.match(pane, /<CodeBrowser rootLabel=\{rootLabel\} scopeKey=\{`quick-look:\$\{runId\}`\} listTree=\{listTree\} readFile=\{readFile\} onTreeError=\{onTreeError\} \/>/);
  assert.match(pane, /<DocsBrowser listTree=\{listTree\} readFile=\{readFile\} onTreeError=\{onTreeError\} \/>/);
  assert.doesNotMatch(pane, /createEntry|saveFile|View diff/);
  assert.match(pane, /serverApi\.listQuickLookCodeTree\(runId\)/);
  assert.match(pane, /serverApi\.getQuickLookDocsFile\(runId, path\)/);
});

test('the pane reloads its location when the run\'s status changes, since completing removes the worktree', () => {
  assert.match(pane, /const loadKey = `\$\{run\.id\}:\$\{run\.status\}:\$\{refreshKey\}`;/);
  assert.match(pane, /if \(!load\) return <PaneMessage>Loading…<\/PaneMessage>;/);
  assert.match(pane, /if \('error' in load\) return <PaneMessage alert>\{load\.error\}<\/PaneMessage>;/);
});

// ---- Diff ----

test('diffBadge maps each status to its letter and full word', () => {
  assert.deepEqual(diffBadge('added'), { letter: 'A', label: 'Added' });
  assert.deepEqual(diffBadge('modified'), { letter: 'M', label: 'Modified' });
  assert.deepEqual(diffBadge('deleted'), { letter: 'D', label: 'Deleted' });
  assert.deepEqual(diffBadge('renamed'), { letter: 'R', label: 'Renamed' });
});

test('diffTotals sums lines, counting binary files as files but not lines', () => {
  assert.deepEqual(diffTotals([{ additions: 3, deletions: 1 }, { additions: null, deletions: null }, { additions: 0, deletions: 4 }]), { files: 3, additions: 3, deletions: 5 });
  assert.deepEqual(diffTotals([]), { files: 0, additions: 0, deletions: 0 });
});

test('classifyDiffLine: hunks, additions, deletions and context; file headers are never additions or deletions', () => {
  assert.equal(classifyDiffLine('@@ -1,2 +1,3 @@'), 'hunk');
  assert.equal(classifyDiffLine('+added'), 'add');
  assert.equal(classifyDiffLine('-removed'), 'del');
  assert.equal(classifyDiffLine(' same'), 'context');
  assert.equal(classifyDiffLine(''), 'context');
  for (const header of ['--- a/x.ts', '+++ b/x.ts', 'diff --git a/x b/x', 'index 1..2 100644', 'new file', 'rename from a', '\\ No newline at end of file']) {
    assert.equal(classifyDiffLine(header), 'meta', header);
  }
});

test('the diff strip compares the branch with its base, says when it reads the kept branch, and has empty states', () => {
  assert.equal(diffCompareLabel({ source: 'worktree', base: 'main', branch: 'task/x' }), 'task/x vs main');
  assert.equal(diffCompareLabel({ source: 'project-folder', base: null, branch: 'main' }), 'Project folder vs HEAD');
  assert.equal(diffSourceNote({ source: 'branch' }), 'From the branch (working copy removed)');
  assert.equal(diffSourceNote({ source: 'worktree' }), null);
  assert.equal(diffEmptyMessage({ source: 'worktree', base: 'main' }), 'No changes against main yet.');
  assert.equal(diffEmptyMessage({ source: 'project-folder', base: null }), 'No uncommitted changes in the project folder.');
  assert.equal(diffLiveNote({ source: 'branch' }, 3), 'Live: the branch as it is now, not a snapshot of Round 3');
  assert.equal(diffLiveNote({ source: 'worktree' }, 1), 'Live: current state, not a snapshot of Round 1');
});

test('the diff view selects the first file, fetches a file\'s diff on selection, and shows binary and removed states', () => {
  assert.match(diffView, /if \(diff\.files\[0\]\) void open\(diff\.files\[0\]\.path\);/);
  assert.match(diffView, /onClick=\{\(\) => void open\(file\.path\)\}/);
  assert.match(diffView, /serverApi\.getQuickLookDiffFile\(runId, path\)/);
  assert.match(diffView, /Binary file changed\./);
  assert.match(diffView, /isWorkingCopyRemoved\(error\) \? \{ removed: true \}/);
  assert.match(diffView, /<WorkingCopyRemoved branch=\{null\} detail="Its branch can't be read either, so there's no diff to show\." \/>/);
  assert.match(diffView, /\{diffEmptyMessage\(diff\)\}/);
});

// ---- Commands ----

test('command locations read as Main checkout (also for older runs) or the task and its branch', () => {
  assert.equal(commandLocationLabel(undefined), 'Main checkout');
  assert.equal(commandLocationLabel({ kind: 'main' }), 'Main checkout');
  assert.equal(commandLocationLabel(taskLocation()), 'Task 5.008 · task/5-008');
  assert.equal(commandLocationLabel({ ...taskLocation(), taskRef: null, branch: null }), 'Task');
});

test('only a task-located run hides Re-run; main-checkout and older runs keep it', () => {
  assert.equal(canRerunCommandRun(run({ location: taskLocation() })), false);
  assert.equal(canRerunCommandRun(run({ location: { kind: 'main' } })), true);
  assert.equal(canRerunCommandRun(run()), true);
  assert.match(logPopup, /\{canRerunCommandRun\(run\) && \(/);
  assert.match(logPopup, /<CommandLocationChip location=\{run\.location\} \/>/);
});

test('History shows each run\'s location', () => {
  assert.match(commandsPanel, /<CommandLocationChip location=\{run\.location\} \/>\s*\{runBadge\(run\)\}/);
  assert.match(chip, /kind=\{location\?\.kind === 'task' \? 'task' : 'main'\} label=\{commandLocationLabel\(location\)\}/);
});

test('the menu lists header commands first, then the rest, each in saved order', () => {
  const commands = [{ id: 'a', highlighted: false }, { id: 'b', highlighted: true }, { id: 'c', highlighted: false }, { id: 'd', highlighted: true }];
  const { highlighted, rest } = orderedCommands(commands);
  assert.deepEqual(highlighted.map((c) => c.id), ['b', 'd']);
  assert.deepEqual(rest.map((c) => c.id), ['a', 'c']);
  assert.match(header, /const \{ highlighted, rest \} = orderedCommands\(commands \?\? \[\]\);/);
  assert.match(commandsMenu, /const \{ highlighted, rest \} = orderedCommands\(commands \?\? \[\]\);/);
});

test('commandMenuState: idle, running here with its log minimized, or running elsewhere with where', () => {
  assert.deepEqual(commandMenuState(undefined, 'wr-1'), { kind: 'idle' });
  assert.deepEqual(commandMenuState(run({ id: 'x', location: taskLocation('wr-1') }), 'wr-1'), { kind: 'minimized', runId: 'x' });
  assert.deepEqual(commandMenuState(run({ id: 'y', location: { kind: 'main' } }), 'wr-1'), { kind: 'running-elsewhere', runId: 'y', where: 'Main checkout' });
  assert.deepEqual(commandMenuState(run({ id: 'z' }), 'wr-1'), { kind: 'running-elsewhere', runId: 'z', where: 'Main checkout' });
  assert.deepEqual(commandMenuState(run({ id: 'w', location: taskLocation('wr-2') }), 'wr-1'), { kind: 'running-elsewhere', runId: 'w', where: 'Task 5.008 · task/5-008' });
});

test('minimizedTaskRuns lists this task\'s running runs whose log is closed, oldest first', () => {
  const runs = {
    a: run({ id: 'a', location: taskLocation('wr-1'), startedAt: '2026-01-01T00:00:02Z' }),
    b: run({ id: 'b', location: taskLocation('wr-1'), startedAt: '2026-01-01T00:00:01Z', origin: 'adhoc' }),
    c: run({ id: 'c', location: taskLocation('wr-1'), status: 'success' }),
    d: run({ id: 'd', location: taskLocation('wr-2') }),
    e: run({ id: 'e', location: { kind: 'main' } }),
    f: run({ id: 'f', location: taskLocation('wr-1') }),
  };
  assert.deepEqual(minimizedTaskRuns(runs, 'wr-1', 'f').map((r) => r.id), ['b', 'a']);
});

test('choosing a command runs it in this task\'s working copy, or opens the run already going anywhere; a race opens the winner', () => {
  assert.match(commandsMenu, /const state = commandMenuState\(findRunningRun\(commandRunsById, command\.id\), run\.id\);\s*if \(state\.kind !== 'idle'\) \{\s*setOpenRunId\(state\.runId\);\s*return;/);
  assert.match(commandsMenu, /const started = await runCommand\(command\.id, run\.id\);/);
  assert.match(commandsMenu, /await loadActiveCommandRuns\(run\.projectId\);\s*const raced = findRunningRun\(useWorldStore\.getState\(\)\.commandRunsById, command\.id\);\s*if \(raced\) setOpenRunId\(raced\.id\);/);
  assert.match(commandsMenu, /await runAdHocCommand\(run\.projectId, command, run\.id\)/);
  assert.match(commandsMenu, /<CommandLogPopup key=\{openRunId\} runId=\{openRunId\}/);
});

test('the Commands group names where it runs, shows running dots, and is disabled once the working copy is removed', () => {
  assert.match(commandsMenu, /const where = commandsWhereLabel\(location\);/);
  assert.match(commandsMenu, /<DropdownMenuLabel[^>]*>\{where\}<\/DropdownMenuLabel>/);
  assert.match(commandsMenu, /<DropdownMenuTrigger asChild disabled=\{removed\}>/);
  assert.match(commandsMenu, /title=\{removed \? WORKING_COPY_REMOVED_TITLE : where\}/);
  assert.match(commandsMenu, /<RunningDot tone="minimized" label="Running here, log minimized" \/>/);
  assert.match(commandsMenu, /running in \{state\.where\}/);
  assert.match(commandsMenu, /onClick=\{\(\) => setOpenRunId\(minimizedRun\.id\)\}/);
  assert.match(commandsMenu, /<RunCustomCommandDialog\s*where=\{where\}/);
  assert.match(dialogs, /\{where \?\? 'Runs once from this project\\'s own root directory'\}/);
});

test('commandsWhereLabel names the task working copy and branch, the project folder, and assumes the working copy while loading', () => {
  assert.equal(commandsWhereLabel({ kind: 'worktree', branch: 'task/x' }), "Runs in this task's working copy · task/x");
  assert.equal(commandsWhereLabel({ kind: 'worktree', branch: null }), "Runs in this task's working copy");
  assert.equal(commandsWhereLabel(null), "Runs in this task's working copy");
  assert.equal(commandsWhereLabel({ kind: 'project-folder', branch: 'main' }), 'Runs in the project folder (this task has no separate branch)');
});

test('header commands still run in the main checkout, and show a running dot for a run anywhere', () => {
  assert.match(header, /const started = await runCommand\(commandId\);/);
  assert.doesNotMatch(header, /workflowRunId/);
  assert.match(header, /\{active && <RunningDot label="Running" \/>\}/);
});

// ---- Catalog ----

test('the Catalog step editor offers the five Quick look options with hints, saying it applies to new runs', () => {
  assert.deepEqual(QUICK_LOOK_OPTIONS.map((option) => option.value), ['none', 'code', 'diff', 'documents', 'commands']);
  assert.ok(QUICK_LOOK_OPTIONS.every((option) => option.label && option.hint));
  assert.match(catalog, /<Label htmlFor=\{`\$\{idPrefix\}-quick-look`\}>Quick look<\/Label>/);
  assert.match(catalog, /onValueChange=\{\(quickLook\) => onChange\(\{ \.\.\.step, quickLook: quickLook as QuickLookKind \}\)\}/);
  assert.match(catalog, /Applies to runs started after you save\./);
});

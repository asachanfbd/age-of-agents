import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Pins the unified Planning column's two entry points and the guarded start flow. The dialogs' pre-fill rules are covered
// against lib/executorAvailability.ts and lib/workflowSettings.ts; the drop arithmetic in taskBoard.test.mjs.
const read = (file) => readFile(new URL(`../src/ui/${file}`, import.meta.url), 'utf8');
const [modal, tasksPanel, planAndBugsPrompt, taskPrompt, promptBar, dialogs, actions, codingAgentPicker] = await Promise.all([
  read('ProjectWorkspaceModal.tsx'),
  read('project-popup/TasksPanel.tsx'),
  read('project-popup/PlanAndBugsPrompt.tsx'),
  read('project-popup/TaskPrompt.tsx'),
  read('project-popup/PromptBar.tsx'),
  read('project-popup/TaskDialogs.tsx'),
  read('project-popup/useTaskActions.ts'),
  read('CodingAgentPicker.tsx'),
]);
const worldStore = await readFile(new URL('../src/store/worldStore.ts', import.meta.url), 'utf8');

test('the workspace defaults to Tasks and has no Planning tab', () => {
  // `topTab` is store state (`workspaceTab`) now, not local — see ProjectWorkspaceModal.tsx's own
  // doc comment — so its 'tasks' default lives in worldStore.ts instead.
  assert.match(worldStore, /workspaceTab: 'tasks'/);
  assert.doesNotMatch(modal, /key: 'planning'|<PlanningPanel/);
  assert.match(modal, /tasks: <TasksPanel project=\{project\}/);
});

test('Completed starts collapsed again whenever the board remounts (task 5.018): closing the workspace or switching tabs away both unmount TasksPanel', () => {
  assert.match(modal, /if \(!workspaceProjectId\) return null;/, 'closing clears workspaceProjectId, dropping WorkspaceContent — and TasksPanel inside it — from the tree entirely');
  assert.match(modal, /<WorkspaceContent key=\{workspaceProjectId\} projectId=\{workspaceProjectId\} \/>/, 'reopening mounts a fresh WorkspaceContent');
  assert.match(modal, /<WorkspaceBody project=\{project\} tab=\{topTab\} panels=\{\{\s*tasks: <TasksPanel project=\{project\} initialRunId=\{tasksRunId\} taskPanelSwap=\{taskPanelSwap\} \/>,/, 'switching away from Tasks unmounts TasksPanel; switching back remounts a fresh one, so local state (like the collapsed flag) never carries over between tabs either');
  assert.match(tasksPanel, /const \[completedCollapsed, setCompletedCollapsed\] = useState\(true\);/, 'a fresh mount always starts collapsed — nothing is lifted to the store or persisted to carry a prior value over');
});

test('the Tasks board starts with the unified Planning column', () => {
  assert.match(tasksPanel, /planning: \{ label: 'Planning'/);
  assert.match(tasksPanel, /buildPlanningQueue/);
  assert.match(tasksPanel, /<PlanningSessionCard/);
  assert.match(tasksPanel, /<PlanAndBugsPromptDialog/);
});

test('the Plan & bugs prompt only starts Plan & bugs sessions, with a coding agent picker', () => {
  assert.match(planAndBugsPrompt, /startPlanAndBugsSession\(project\.id, trimmed, executorId \|\| undefined\)/);
  assert.match(planAndBugsPrompt, /<CodingAgentPicker[\s\S]*<PromptBar/);
  assert.doesNotMatch(planAndBugsPrompt, /createPlanItem|taskDraft|Unassigned|sendChatMessage/);
});

test('the Plan & bugs prompt keeps an unsent request as its own per-project draft, separate from the task draft', () => {
  assert.match(planAndBugsPrompt, /readPlanAndBugsDraft\(project\.id\)/);
  assert.match(planAndBugsPrompt, /savePlanAndBugsDraft\(project\.id, next\)/);
  assert.match(planAndBugsPrompt, /clearPlanAndBugsDraft\(project\.id\);\s*setMessage\(''\);\s*onSessionStarted\(taskId\);/, 'the draft clears only after the send resolves, so a rejection leaves it in place');
  assert.doesNotMatch(planAndBugsPrompt, /readTaskDraft|saveTaskDraft|clearTaskDraft/, 'the draft never reuses the task draft\'s functions');
  assert.equal(planAndBugsPrompt.match(/PlanAndBugsDraft\(/g)?.length, 3, 'the draft functions are called exactly once each: read on init, save on change, clear on a successful send');
});

test('both prompts share one PromptBar: Enter to send, send disabled until there is text, errors shown', () => {
  assert.match(promptBar, /event\.key === 'Enter' && !event\.shiftKey && !event\.nativeEvent\.isComposing/);
  assert.match(promptBar, /disabled=\{!trimmed \|\| !canCompose\}/);
  assert.match(promptBar, /const canCompose = !pending && !unavailable;/);
  assert.match(promptBar, /catch \(failure\) \{\s*setError\(\(failure as Error\)\.message\);/);
  assert.match(promptBar, /\{error && <p role="alert"/);
  assert.doesNotMatch(promptBar, /useWorldStore|serverApi/, 'the bar holds no task or planning logic');
});

test('the Planning column header has a Plan & bugs button and a Task button', () => {
  assert.match(tasksPanel, /if \(column === 'planning'\)[\s\S]*kind: 'plan-and-bugs'[\s\S]*Plan &amp; bugs<\/span><\/Button>[\s\S]*kind: 'add'[\s\S]*>Task<\/span><\/Button>/);
  assert.match(tasksPanel, /\{dialog\?\.kind === 'add' && <TaskPromptDialog project=\{project\} onClose=\{\(\) => setDialog\(null\)\} \/>\}/);
  assert.doesNotMatch(tasksPanel + dialogs + actions, /AddTaskDialog|actions\.add\b|add: async/, 'the one-off add dialog is gone');
});

test('the task prompt dialog is self-contained: a Dialog hosting the task prompt that closes once created', () => {
  assert.match(taskPrompt, /export function TaskPromptDialog\(\{ project, onClose \}: \{ project: ProjectData; onClose: \(\) => void \}\)/);
  assert.match(taskPrompt, /<Dialog open onOpenChange=\{\(open\) => \{ if \(!open\) onClose\(\); \}\}>/);
  assert.match(taskPrompt, /<TaskPrompt project=\{project\} onCreated=\{onClose\} \/>/);
});

test('the task prompt creates an open task from its description only, with no agent picker — the coding agent is chosen only when the task starts', () => {
  assert.match(taskPrompt, /createPlanItem\(project\.id, \{ description: trimmed \}\);\s*if \(!itemId\) return;\s*clearTaskDraft\(project\.id\);/);
  assert.doesNotMatch(taskPrompt, /executorId|mostRemainingExecutorId|availableExecutors|pickerLabel|selectedId|selectedLabel|Unassigned|updatePlanItem/i);
  assert.doesNotMatch(taskPrompt, /<PromptBar[\s\S]*options=/, 'no picker is passed, so PromptBar renders none');
});

test('the task prompt keeps an unsent description as a per-project draft, cleared only once created', () => {
  assert.match(taskPrompt, /useState\(\(\) => readTaskDraft\(project\.id\)\)/);
  assert.match(taskPrompt, /saveTaskDraft\(project\.id, next\)/);
  assert.match(taskPrompt, /if \(!itemId\) return;[\s\S]*clearTaskDraft\(project\.id\);\s*onCreated\(\);/, 'a failed create keeps the draft and the dialog open');
});

test('a drop onto Running and task detail both use the guarded start options', () => {
  assert.match(tasksPanel, /if \(drop\.kind === 'reorder'\)[\s\S]*reorderPlanningQueue[\s\S]*else setDialog\(\{ kind: 'start', row: drop\.card as OpenTaskRow \}\);/);
  assert.match(tasksPanel, /onStart: \(row\) => setDialog\(\{ kind: 'start', row \}\),/);
  assert.match(actions, /start: async \(row: Pick<OpenTaskRow, 'id' \| 'title'>, options: ExecutePlanItemOptions\): Promise<string> => \{\s*(?:\/\/[^\n]*\n\s*)?const runId = await startPlanItem\(project\.id, row\.id, options\);/);
  assert.doesNotMatch(actions, /row\.dependsOn/, 'the route is chosen from the stored plan item, never from what the caller put in the row');
});

test('the start options open pre-filled and start only on confirm, closing only once the daemon accepts', () => {
  // The agent is the shared picker's own preselection (the default agent) — never `dialog.row.workerId`
  // (a prior assignment is ignored for pre-selection; see task 5.016).
  assert.doesNotMatch(tasksPanel, /initialExecutorId|selectableExecutors|dialog\.row\.workerId/, 'the start dialog never pre-selects from a row\'s assigned worker');
  assert.match(tasksPanel, /workflows=\{workflows\}\s*\{\.\.\.startDialogChoice\(dialog\.row\.id\)\}/);
  assert.match(tasksPanel, /const workflows = enabledWorkflows\(catalogWorkflows\);/, 'only enabled workflows are offered');
  assert.match(tasksPanel, /hasRepository=\{!!project\.repositoryUrl\}/);
  assert.match(tasksPanel, /onStart=\{async \(options\) => \{\s*await actions\.start\(dialog\.row, options\);\s*setDialog\(null\);/, 'a refusal rejects before the dialog closes');
  assert.match(tasksPanel, /onCancel=\{\(\) => setDialog\(null\)\}/, 'cancelling leaves the task where it was');
});

test('the start dialog asks for the coding agent, workflow and branch — no approvals option — and shows refusals', () => {
  assert.match(dialogs, /export function StartTaskDialog/);
  assert.match(dialogs, /<CodingAgentPicker executors=\{executors\} value=\{executorId\} onChange=\{choose\} id="start-agent" \/>/);
  assert.match(dialogs, /<Select value=\{workflowId\} onValueChange=\{changeWorkflow\}>/);
  assert.match(dialogs, /\{workflows\.map\(\(workflow\) => <SelectItem key=\{workflow\.id\} value=\{workflow\.id\}>\{workflow\.name\}<\/SelectItem>\)\}/);
  assert.match(dialogs, /useState\(hasRepository\)/, 'a separate branch is the default when there is a repository');
  assert.match(dialogs, /\{hasRepository && \([\s\S]*Create a separate branch[\s\S]*Off runs it in the project folder, on the current branch\./, 'hidden without a repository');
  assert.doesNotMatch(dialogs.slice(dialogs.indexOf('export function StartTaskDialog')), /approval|Autonomy|autonomy/i);
  assert.match(dialogs, /catch \(failure\) \{\s*const refused = taskConflictOf\(failure\);\s*if \(refused\) setConflict\(refused\);\s*else setError\(\(failure as Error\)\.message\);/, 'a limit refusal is its own message; any other refusal stays plain text');
  assert.match(dialogs, /\{conflict && <TaskConflictAlert conflict=\{conflict\}/, 'the limit message shows in the dialog itself');
  assert.match(dialogs, /<Alert variant="destructive" role="alert">\s*<AlertDescription>\{error\}<\/AlertDescription>/);
  assert.match(dialogs, /disabled=\{!executorId \|\| needsWorkflow \|\| noStepSelected \|\| starting\}/);
});

test('the Start task dialog uses the shared coding-agent picker — Assign worker is gone', () => {
  assert.equal(dialogs.match(/<CodingAgentPicker /g)?.length, 1);
  // The picker itself is shared with every other surface that starts agent work, so it lives in its own file.
  assert.match(codingAgentPicker, /if \(executors\.length === 0\) return <p className="text-sm text-muted-foreground">No coding agent is configured<\/p>;/);
  assert.doesNotMatch(dialogs, /AssignWorkerDialog|Assign worker/);
  assert.doesNotMatch(tasksPanel, /kind: 'assign'|AssignWorkerDialog/);
  assert.doesNotMatch(actions, /\bassign:\s*\(/);
});

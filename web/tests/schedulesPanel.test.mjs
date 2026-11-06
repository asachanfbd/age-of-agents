import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
/** Source-level checks of the Schedules components: the web has no DOM harness, so these pin how the pieces are wired. */
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const panel = src('ui/schedules/SchedulesPanel.tsx');
const editor = src('ui/schedules/JobEditorDialog.tsx');
const modal = src('ui/ProjectWorkspaceModal.tsx');
const tabs = await import('../src/lib/pullRequests.ts');
/** The text of one component function, from its declaration to the next top-level one. */
const component = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  const next = source.slice(start + 1).search(/\n(export )?(function|interface|const|type) /);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
};

test('C01 Schedules is a Settings section in both shells, next to Tasks no longer', () => {
  const software = tabs.workspaceTabs({ repositoryUrl: undefined }, { reading: { status: 'idle' }, hasArchived: false }).map((tab) => tab.key);
  assert.ok(!software.includes('schedules'));
  const settings = src('ui/project-popup/SettingsPanel.tsx');
  assert.match(settings, /schedules: \{ label: 'Schedules', icon: CalendarClock \}/);
  assert.match(settings, /\{current === 'schedules' && <SchedulesPanel project=\{project\} onOpenRun=\{onOpenRun\} \/>\}/);
  assert.match(component(modal, 'WorkspaceContent'), /onOpenRun=\{openRunInTasks\}/);
  assert.match(component(modal, 'NotesShell'), /onOpenRun=\{onOpenRun\}/);
});

test('C02 the Schedules area is its own exported component that takes a Building and imports nothing of the workspace shell', () => {
  assert.match(panel, /export function SchedulesPanel\(\{ project, onOpenRun \}: \{ project: ProjectData; onOpenRun: \(runId: string\) => void \}\)/);
  for (const source of [panel, editor, src('lib/schedules.ts'), src('store/schedulesStore.ts')]) {
    assert.doesNotMatch(source, /ProjectWorkspaceModal|NotesWorkspace|project-popup/);
  }
});

test('C03 read-only: the changing controls take `disabled`, and the area is never inside the shell\'s disabling fieldset', () => {
  assert.match(panel, /const controls = scheduleControls\(isBuildingReadOnly\(project\)\)/);
  for (const control of ['timezone', 'newJob', 'restoreDefaults', 'toggle', 'runNow', 'edit', 'delete']) assert.ok(panel.includes(`disabled={controls.${control}.disabled}`), control);
  for (const control of ['back', 'historyFilter', 'openRun', 'loadMore']) assert.ok(panel.includes(`disabled={controls.${control}.disabled}`), control);
  assert.doesNotMatch(panel, /<fieldset/);
  // Settings is self-guarded, so the Schedules section is never drawn inside the read-only fieldset.
  assert.equal(src('ui/project-popup/SettingsPanel.tsx').match(/<SchedulesPanel /g).length, 1);
  assert.doesNotMatch(modal, /SchedulesPanel/);
  // The job's name opens it without going through a control the read-only state disables.
  assert.match(component(panel, 'JobRow'), /<button type="button" className="[^"]*" onClick=\{onOpen\}>\{job\.name\}<\/button>/);
});

test('C04 visibility uses conditional rendering, never the `hidden` attribute', () => {
  for (const source of [panel, editor]) assert.doesNotMatch(source, /\shidden(=|\s|>)/);
  assert.match(editor, /\{groups\.cron && \(/);
  assert.match(panel, /\{openJob \? \(/);
});

test('C05 the switch, the delete confirmation, the refused Run now and the editor\'s errors are announced properly', () => {
  const toggle = component(panel, 'JobSwitch');
  assert.match(toggle, /role="switch"/);
  assert.match(toggle, /aria-checked=\{job\.enabled\}/);
  assert.match(toggle, /aria-label=\{`\$\{job\.name\}: \$\{job\.enabled \? 'on' : 'off'\}`\}/);
  assert.match(panel, /<Dialog open=\{deleting !== null\}[\s\S]*?<DialogContent[\s\S]*?deleteConfirmation\(deleting\)\.title[\s\S]*?<\/DialogContent>/);
  assert.match(component(panel, 'JobNotes'), /role=\{note\.role\}/);
  assert.match(src('lib/schedules.ts'), /kind: 'run-error', role: 'alert'/);
  const field = component(editor, 'Field');
  assert.match(field, /'aria-invalid': Boolean\(error\)/);
  assert.match(field, /<p id=\{`\$\{id\}-error`\} className="[^"]*" role="alert">\{error\}<\/p>/);
  assert.match(field, /<label htmlFor=\{id\}/);
  assert.ok((editor.match(/<Field /g) ?? []).length >= 14, 'every input goes through Field');
});

test('C06 the new files have no looping animation', () => {
  for (const source of [panel, editor]) assert.doesNotMatch(source, /animate-(spin|pulse|ping|bounce)|infinite|@keyframes/);
});

test('C07 Run now, on/off, Edit and Delete call their store actions, and Delete goes through the confirmation', () => {
  const actions = component(panel, 'JobActions');
  assert.match(actions, /const runNow = \(\) => void runScheduleJobNow\(project\.id, job\.id\)\.then\(\(result\) => onError\(runNowPanelError\(result\)\)\);/);
  assert.match(actions, /onClick=\{runNow\}><Play/);
  assert.match(actions, /onClick=\{\(\) => onEdit\(job\)\}/);
  assert.match(actions, /onClick=\{\(\) => onDelete\(job\)\}/);
  assert.doesNotMatch(actions, /deleteScheduleJob/);
  assert.match(component(panel, 'JobSwitch'), /updateScheduleJob\(project\.id, job\.id, \{ enabled: !job\.enabled \}\)/);
  assert.match(panel, /onDelete: setDeleting/);
  assert.match(panel, /async function confirmDelete\(job: ScheduledJob\) \{\s*const result = await deleteScheduleJob\(project\.id, job\.id\);/);
  assert.match(panel, /onClick=\{\(\) => void confirmDelete\(deleting\)\}>Delete job</);
  assert.equal(panel.match(/deleteScheduleJob\(/g).length, 1, 'the only delete call is the confirmed one');
  assert.match(panel, /setOpenJobId\(\(current\) => openJobAfterDelete\(current, job\.id\)\)/);
  assert.match(editor, /job \? await updateScheduleJob\(project\.id, job\.id, request\) : await createScheduleJob\(project\.id, request\)/);
});

test('C08 "Open run" switches to the Tasks tab and opens that run through the workspace\'s existing run link', () => {
  assert.match(component(panel, 'JobDetail'), /onClick=\{\(\) => onOpenRun\(row\.runId!\)\}>Open run</);
  assert.match(modal, /const openRunInTasks = \(runId: string\) => \{ setTasksRunId\(runId\); setTopTab\('tasks'\); \};/);
  assert.match(modal, /<TasksPanel project=\{project\} initialRunId=\{tasksRunId\}/);
  assert.match(component(modal, 'NotesShell'), /<TasksPanel project=\{project\} initialRunId=\{tasksRunId\}/);
});

test('C09 the editor: no missed-run field and an interval group for a watch job, and a note while the job has a run going', () => {
  assert.match(editor, /\{groups\.missed && \(\s*<Field label="If a run was missed while the app was off">/);
  assert.match(editor, /\{groups\.interval && \(\s*<Field label="Check every"/);
  assert.equal(editor.match(/If a run was missed/g).length, 1);
  assert.match(editor, /\{job\?\.activeRun && <Alert role="status"><AlertDescription>\{RUN_GOING_NOTE\}<\/AlertDescription><\/Alert>\}/);
  assert.match(editor, /const found = validateJobForm\(form, slots\.map\(\(slot\) => slot\.id\), savedCommands\.map\(\(command\) => command\.id\)\);/);
  assert.match(editor, /serverErrorToForm\(\{ message: result\.error, field: result\.field \}\)/);
});

test('C11 the timezone selector is at the top of Schedules; the editor states the timezone and has no selector', () => {
  const selector = panel.indexOf('aria-label="Timezone for this Building\'s schedules"');
  assert.ok(selector !== -1 && selector < panel.indexOf('aria-label="Jobs"'), 'above the job list');
  assert.match(panel, /setScheduleTimezone\(project\.id, event\.target\.value \|\| null\)/);
  assert.match(editor, /Times use this Building's timezone: \$\{timezone\}\. Change it at the top of Schedules\./);
  assert.doesNotMatch(editor, /setScheduleTimezone|timezoneOptions/);
});

test('C20 the editor offers a Saved command target with a select of the Building\'s commands, and a hint when it has none', () => {
  assert.match(editor, /aria-pressed=\{groups\.command\} onClick=\{\(\) => change\('targetKind', 'command'\)\}>A saved command<\/Button>/);
  assert.match(editor, /\{groups\.command && \(\s*<>\s*<Field label="Saved command"/);
  assert.match(editor, /useWorldStore\(\(s\) => s\.commandsByProject\[project\.id\]\)/);
  assert.match(editor, /void loadCommands\(project\.id\)/);
  assert.match(editor, /disabled=\{savedCommands\.length === 0\}/);
  assert.match(editor, /This Building has no saved commands yet\. Add one in Settings > Commands\./);
  assert.match(editor, /\{command\.name\} — \{command\.command\}/);
  assert.match(editor, /Command no longer exists/);
});

test('C21 a command target disables approval, the usage limits and the overlap rule', () => {
  assert.match(editor, /value=\{groups\.command \? 'skip' : form\.overlap\} disabled=\{groups\.command\}/);
  assert.match(editor, /checked=\{form\.needsApproval && !groups\.command\} disabled=\{groups\.command\}/);
  assert.match(editor, /value=\{form\.fiveHour\} disabled=\{groups\.command\}/);
  assert.match(editor, /value=\{form\.weekly\} disabled=\{groups\.command\}/);
});

test('C22 the job row and details name the command from the Building\'s loaded commands, loading them when a job needs it', () => {
  assert.match(panel, /commandsByProject\[project\.id\]/);
  assert.match(panel, /targetLabel\(job\.target, slots \?\? \[\], agents, buildings, commands \?\? null\)/);
  assert.match(panel, /if \(usesCommand && !commands\) void loadCommands\(project\.id\)/);
});

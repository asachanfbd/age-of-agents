import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
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

const layout = await import('../src/lib/workspaceLayout.ts');
const sections = await import('../src/lib/settingsSections.ts');
const { workspaceTabs } = await import('../src/lib/pullRequests.ts');
const { useWorldStore } = await import('../src/store/worldStore.ts');

const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const modal = src('ui/ProjectWorkspaceModal.tsx');
const body = src('ui/WorkspaceBody.tsx');
const settings = src('ui/project-popup/SettingsPanel.tsx');
const docs = readFileSync(new URL('../../.docs/blueprint.md', import.meta.url), 'utf8');
const MOVED = ['schedules', 'connections', 'activity'];
const reading = { status: 'idle' };
const SHELLS = {
  'software with a repository': () => workspaceTabs({ repositoryUrl: 'https://github.com/o/r' }, { reading, hasArchived: true }),
  'software without a repository': () => workspaceTabs({}, { reading, hasArchived: false }),
  'software with a non-GitHub repository': () => workspaceTabs({ repositoryUrl: 'https://gitlab.com/o/r' }, { reading, hasArchived: false }),
  notes: () => layout.notesTabs(),
};
/** The members of a string-literal union or `as const` array declared in a source file. */
const literals = (source, pattern) => [...source.match(pattern)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

test('the declaration covers every WorkspaceTab, each with a label and a self-guarded flag', () => {
  const tabs = literals(src('lib/workspaceLayout.ts'), /WORKSPACE_TABS = \[([^\]]*)\]/);
  assert.deepEqual(Object.keys(layout.TAB_DECLARATIONS).sort(), [...tabs].sort());
  for (const tab of tabs) {
    assert.equal(typeof layout.TAB_DECLARATIONS[tab].label, 'string');
    assert.equal(typeof layout.TAB_DECLARATIONS[tab].selfGuarded, 'boolean');
    assert.match(body, new RegExp(`\\b${tab}: [A-Z]`), `${tab} has an icon`);
  }
});

test('every Settings section has an icon and a label in the Settings panel', () => {
  for (const section of sections.SETTINGS_SECTIONS) assert.match(settings, new RegExp(`\\b${section}: \\{ label: '[^']+', icon: `), section);
});

test('no shell tab list contains Schedules, Connections or Activity', () => {
  for (const [name, tabs] of Object.entries(SHELLS)) for (const tab of tabs()) assert.ok(!MOVED.includes(tab.key), `${name}: ${tab.key}`);
  assert.deepEqual(SHELLS['software with a repository']().map((t) => t.key), ['tasks', 'documents', 'testing', 'code', 'pr', 'settings', 'archived']);
  assert.deepEqual(SHELLS.notes().map((t) => [t.key, t.label]), [['tasks', 'Tasks'], ['documents', 'Notes'], ['settings', 'Settings']]);
});

test('Settings offers the sections in order, per type', () => {
  assert.deepEqual(sections.settingsSectionsFor({ repository: true, hasStorage: true }), sections.SETTINGS_SECTIONS);
  assert.deepEqual(sections.settingsSectionsFor({ repository: false, hasStorage: true }), ['general', 'schedules', 'connections', 'activity', 'storage']);
  assert.deepEqual(sections.settingsSectionsFor({ repository: false, hasStorage: false }), ['general', ...MOVED]);
  assert.deepEqual(sections.settingsSectionsFor(undefined), ['general', 'workflow', 'git', 'commands']);
});

test('a deep link to a section the type does not offer falls back to its first section', () => {
  assert.equal(sections.effectiveSection('workflow', sections.settingsSectionsFor({ repository: false, hasStorage: false })), 'general');
  assert.equal(sections.effectiveSection('schedules', sections.settingsSectionsFor(undefined)), 'general');
});

test('a panel is never placed inside the read-only fieldset unless its tab is not self-guarded, and no panel means nothing is drawn', () => {
  for (const tab of Object.keys(layout.TAB_DECLARATIONS)) {
    assert.equal(layout.panelPlacement(tab, false), 'none', `${tab}: no empty wrapper`);
    assert.equal(layout.panelPlacement(tab, true), layout.TAB_DECLARATIONS[tab].selfGuarded ? 'bare' : 'read-only-fieldset', tab);
  }
  assert.equal(layout.panelPlacement('settings', true), 'bare');
  assert.equal(layout.panelPlacement('tasks', true), 'read-only-fieldset');
});

test('every tab of every shell resolves to a panel placed bare or in a fieldset', () => {
  for (const [name, tabs] of Object.entries(SHELLS)) {
    for (const { key } of tabs()) assert.notEqual(layout.panelPlacement(key, true), 'none', `${name}: ${key}`);
  }
});

test('stored and linked tab values: moved tabs open their Settings section, unknown values open Tasks, normalising is idempotent', () => {
  for (const tab of MOVED) assert.deepEqual(layout.normalizeWorkspaceTab(tab), { tab: 'settings', section: tab });
  for (const value of ['', undefined, 'Schedules', 'nope', 'constructor', '__proto__']) assert.deepEqual(layout.normalizeWorkspaceTab(value), { tab: 'tasks' });
  for (const tab of Object.keys(layout.TAB_DECLARATIONS)) assert.deepEqual(layout.normalizeWorkspaceTab(tab), { tab });
  assert.deepEqual(layout.normalizeWorkspaceTab(layout.normalizeWorkspaceTab('activity').tab), { tab: 'settings' });
});

test('tabOrTasks keeps an offered tab and falls back to Tasks for one the shell lacks', () => {
  assert.equal(layout.tabOrTasks('settings', layout.notesTabs()), 'settings');
  assert.equal(layout.tabOrTasks('code', layout.notesTabs()), 'tasks');
});

test('the store maps legacy tab values to Settings sections and keeps tasksRunId-free plain switches', () => {
  const store = () => useWorldStore.getState();
  for (const tab of MOVED) {
    useWorldStore.setState({ workspaceTab: 'tasks', workspaceSettingsSection: 'workflow' });
    store().setWorkspaceTab(tab);
    assert.deepEqual([store().workspaceTab, store().workspaceSettingsSection], ['settings', tab]);
  }
  store().setWorkspaceTab('tasks');
  assert.equal(store().workspaceSettingsSection, 'activity', 'the remembered section survives leaving Settings');
  store().setWorkspaceTab('bogus');
  assert.equal(store().workspaceTab, 'tasks');
});

test('a scheduled-job notification switches Settings to Schedules even when Settings is already open on another section', async () => {
  useWorldStore.setState({ projects: [{ id: 'alpha', name: 'alpha' }], notifications: [] });
  useWorldStore.getState().openWorkspace('alpha');
  useWorldStore.setState({ workspaceTab: 'settings', workspaceSettingsSection: 'commands' });
  await useWorldStore.getState().openNotificationTarget({ id: 'n1', kind: 'schedule.run_failed', subject: { type: 'scheduledJob', projectId: 'alpha', jobId: 'j1' }, projectId: 'alpha', readAt: null });
  assert.deepEqual([useWorldStore.getState().workspaceTab, useWorldStore.getState().workspaceSettingsSection], ['settings', 'schedules']);
});

test('no shell keeps its own tab list: tabs come from the declaration, panels through the one body', () => {
  assert.doesNotMatch(modal, /SELF_GUARDED_TABS|ownTabs|<TabsTrigger|<fieldset|ReadOnlyFieldset/);
  assert.doesNotMatch(modal, /\.includes\(\s*(tab|topTab)\s*\)/);
  assert.equal((modal.match(/<WorkspaceTabBar /g) ?? []).length, 2);
  assert.equal((modal.match(/<WorkspaceBody /g) ?? []).length, 2);
  assert.match(modal, /satisfies Record<WorkspaceTab, ReactNode>/, 'the Software shell must give every tab a panel');
  assert.match(body, /panelPlacement\(tab, Boolean\(panel\)\)/);
});

test('the Settings content area holds exactly one panel directly, and the three moved panels fill it themselves', () => {
  const content = settings.slice(settings.indexOf("<div className=\"flex min-h-0 min-w-0 flex-1 flex-col\">"));
  for (const panel of ['SchedulesPanel', 'ConnectionsPanel', 'ActivityPanel']) assert.match(content, new RegExp(`<${panel} project=\\{project\\}`));
  for (const file of ['schedules/SchedulesPanel.tsx', 'connections/ConnectionsPanel.tsx', 'connections/ActivityPanel.tsx']) {
    assert.match(src(`ui/${file}`), /return \(\s*<div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"|return <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"/, file);
  }
  assert.match(settings, /aria-label="Settings sections"/);
  assert.match(settings, /className="flex gap-1 overflow-x-auto md:flex-col"/);
  assert.match(settings, /label: 'Building links'/);
});

test('the layout rules and the pitfall are documented, linked from the UI conventions, and the declaration points to them', () => {
  assert.match(docs, /### Workspace layout rules/);
  assert.match(docs, /Known pitfall: content starts half way down the popup/);
  assert.match(readFileSync(new URL('../../.docs/planning-notes.md', import.meta.url), 'utf8'), /Workspace layout rules/);
  assert.match(src('lib/workspaceLayout.ts'), /"Workspace layout rules" in \.docs\/blueprint\.md/);
});

test('the Content Studio shell follows the layout rules: tabs from one declaration, every panel self-guarded, no wrapper and no fixed heights', async () => {
  const content = await import('../src/lib/contentWorkspace.ts');
  assert.deepEqual(content.CONTENT_TABS.map((t) => [t.key, t.label]), [['content', 'Content'], ['knowledge', 'Knowledge'], ['style', 'Writing style'], ['targets', 'Targets'], ['insights', 'Insights'], ['settings', 'Settings']]);
  assert.ok(content.CONTENT_TABS.every((t) => t.selfGuarded === true), 'each panel guards its own read-only state through its readOnly prop');
  const workspace = src('ui/ContentStudioWorkspace.tsx');
  assert.match(workspace, /CONTENT_TABS\.map\(/);
  assert.doesNotMatch(workspace, /<fieldset|ReadOnlyFieldset|TabsTrigger value="/);
  for (const tab of ['KnowledgeTab', 'WritingStyleTab', 'SettingsTab', 'ConceptList', 'CalendarView']) assert.match(workspace, new RegExp(`<${tab} projectId=\\{project\\.id\\}`), tab);
  for (const key of ['knowledge', 'style']) assert.match(workspace, new RegExp(`state\\.tab === '${key}' && <`), key);
  assert.match(workspace, /state\.tab === 'settings' \? <SettingsTab/, 'Settings is drawn bare, outside the scrolling wrapper');
  assert.match(src('ui/content/SettingsTab.tsx'), /min-h-0 flex-1 overflow-y-auto p-4 sm:p-6/, 'the Settings panel fills the area itself');
  for (const file of ['ContentStudioWorkspace.tsx', 'content/ConceptView.tsx', 'content/OverviewTab.tsx', 'content/KnowledgeTab.tsx', 'content/WritingStyleTab.tsx']) assert.doesNotMatch(src(`ui/${file}`), /\b(h|min-h)-\[\d+px\]|style=\{\{ ?height/, `${file} has no fixed height`);
  assert.match(workspace, /className="min-h-0 min-w-0 flex-1 overflow-y-auto"/);
  assert.match(src('lib/contentWorkspace.ts'), /"Workspace layout rules" in \.docs\/blueprint\.md/);
});

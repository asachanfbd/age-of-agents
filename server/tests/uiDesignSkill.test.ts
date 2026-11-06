import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { interactiveCliArgs } from '../src/terminal/terminalSessionManager.ts';

const CATALOG = path.resolve(import.meta.dirname, '..', '..', 'catalog');
const SKILL_DIR = path.join(CATALOG, 'skills', 'ui-design');
const REFERENCES = ['layout-and-type', 'states-and-edge-data', 'depth-and-materials', 'motion', 'gestures'].map((n) => `${n}.md`);

interface Step { id: string; skillIds?: string[]; preloadSkillIds?: string[]; instructions: string }
interface Index { skills: Record<string, { name: string; avatar: string; enabled: boolean }> }

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const body = (markdown: string) => markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

async function shippedWorkflows(): Promise<Array<{ file: string; steps: Step[] }>> {
  const dir = path.join(CATALOG, 'workflows');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  return Promise.all(files.map(async (file) => ({ file, steps: (await readJson<{ steps: Step[] }>(path.join(dir, file))).steps })));
}

/** Problems with the skill attachments of a workflow's steps; empty when they are all usable. */
function attachmentProblems(steps: Step[], index: Index, hasSkillFile: (id: string) => boolean): string[] {
  const problems: string[] = [];
  for (const step of steps) {
    for (const id of step.skillIds ?? []) {
      if (!hasSkillFile(id)) problems.push(`${step.id}: ${id} has no SKILL.md`);
      else if (!index.skills[id]?.enabled) problems.push(`${step.id}: ${id} is not enabled in the index`);
    }
    for (const id of step.preloadSkillIds ?? []) {
      if (!(step.skillIds ?? []).includes(id)) problems.push(`${step.id}: preload ${id} is not in skillIds`);
    }
  }
  return problems;
}

test('every skillIds entry in every shipped workflow has a SKILL.md, is enabled, and every preloadSkillIds entry is attached', async () => {
  const index = await readJson<Index>(path.join(CATALOG, 'catalog-index.json'));
  for (const { file, steps } of await shippedWorkflows()) {
    const problems = attachmentProblems(steps, index, (id) => existsSync(path.join(CATALOG, 'skills', id, 'SKILL.md')));
    assert.deepEqual(problems, [], file);
  }
});

test('attachmentProblems flags a preload outside skillIds, a missing skill folder and a disabled skill', () => {
  const index: Index = { skills: { on: { name: 'On', avatar: 'x', enabled: true }, off: { name: 'Off', avatar: 'x', enabled: false } } };
  const has = (id: string) => id !== 'gone';
  assert.deepEqual(attachmentProblems([{ id: 's', skillIds: ['on'], preloadSkillIds: ['off'], instructions: '' }], index, has), ['s: preload off is not in skillIds']);
  assert.deepEqual(attachmentProblems([{ id: 's', skillIds: ['gone', 'off'], instructions: '' }], index, has), ['s: gone has no SKILL.md', 's: off is not enabled in the index']);
  assert.deepEqual(attachmentProblems([{ id: 's', instructions: '' }, { id: 't', skillIds: ['on'], instructions: '' }], index, has), []);
});

test('ui-design is indexed, enabled, with a name and avatar, and sync would leave the entry unchanged', async () => {
  const index = await readJson<Index>(path.join(CATALOG, 'catalog-index.json'));
  const entry = index.skills['ui-design'];
  assert.ok(entry?.enabled);
  assert.ok(entry.name && entry.avatar);

  const temp = await mkdtemp(path.join(tmpdir(), 'ui-design-sync-'));
  try {
    await cp(CATALOG, path.join(temp, 'catalog'), { recursive: true });
    const run = await import('node:child_process').then(({ spawnSync }) => spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(path.resolve(import.meta.dirname, '../src/catalog/catalogIndex.ts'))}); const r = await m.syncCatalogIndex(); console.log(JSON.stringify(r.skills['ui-design']));`],
      { env: { ...process.env, AGENT_VISUAL_OS_CATALOG_DIR: path.join(temp, 'catalog') }, encoding: 'utf8' }));
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').pop()!), entry);
    assert.deepEqual(await readJson<Index>(path.join(temp, 'catalog', 'catalog-index.json')), index, 'sync did not rewrite the index');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('SKILL.md has the ui-design name and a one-sentence description', async () => {
  const text = await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: ui-design\ndescription: [^\n]+\n---\n/);
  const description = /description: ([^\n]+)/.exec(text)![1]!;
  assert.equal(description.split(/[.!?](\s|$)/).filter((p) => p.trim()).length, 1);
});

test('the word counter ignores frontmatter; 450 words pass and 451 fail', () => {
  const doc = (n: number) => `---\nname: x\ndescription: lots of words in the frontmatter that do not count\n---\n${Array(n).fill('w').join(' ')}`;
  assert.equal(countWords(body(doc(450))), 450);
  assert.ok(countWords(body(doc(450))) <= 450);
  assert.ok(countWords(body(doc(451))) > 450);
});

test('SKILL.md body is at most 450 words and each reference at most 700', async () => {
  assert.ok(countWords(body(await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8'))) <= 450);
  for (const file of await readdir(path.join(SKILL_DIR, 'references'))) {
    const words = countWords(await readFile(path.join(SKILL_DIR, 'references', file), 'utf8'));
    assert.ok(words <= 700, `${file} has ${words} words`);
  }
});

test('references/ holds exactly the five expected files, all named by the router and all present', async () => {
  const onDisk = (await readdir(path.join(SKILL_DIR, 'references'))).sort();
  assert.deepEqual(onDisk, [...REFERENCES].sort());
  const router = await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const named = [...router.matchAll(/references\/([\w-]+\.md)/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(named)].sort(), onDisk);
});

test('the router routes each tier and topic to the right references and asks for the audit report', async () => {
  const router = body(await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8'));
  const line = (re: RegExp) => router.split('\n').find((l) => re.test(l)) ?? '';
  assert.match(line(/Tier 1/), /Read nothing else/);
  const tier2 = line(/Tier 2/);
  assert.match(tier2, /layout-and-type\.md/);
  assert.match(tier2, /states-and-edge-data\.md/);
  assert.match(line(/Tier 3/), /depth-and-materials\.md/);
  assert.match(line(/animation/), /motion\.md/);
  assert.match(line(/dragged/), /gestures\.md/);
  assert.match(router, /tier chosen, why, and the exact list of reference files read \(or "none"\)/);
});

test('NOTICE.md carries the attribution and the router never references it', async () => {
  assert.match(await readFile(path.join(SKILL_DIR, 'NOTICE.md'), 'utf8'), /emilkowalski\/skills[\s\S]*MIT License\. Copyright \(c\) 2026 Emil Kowalski/);
  assert.doesNotMatch(await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8'), /NOTICE/);
});

test('no reference file points at another reference file', async () => {
  for (const file of REFERENCES) {
    assert.doesNotMatch(await readFile(path.join(SKILL_DIR, 'references', file), 'utf8'), /\.md\b|references\//, file);
  }
});

test('nothing was added for ui-design under .claude/skills', () => {
  assert.equal(existsSync(path.resolve(CATALOG, '..', '.claude', 'skills', 'ui-design')), false);
});

test('the ui-planning step attaches ui-design as always load and starts with the classify-first sentence', async () => {
  const workflow = (await shippedWorkflows()).find((w) => w.file === 'software-development.json')!;
  const step = workflow.steps.find((s) => s.id === 'ui-planning')!;
  assert.ok(step.skillIds?.includes('ui-design'));
  assert.ok(step.preloadSkillIds?.includes('ui-design'));
  assert.ok(step.instructions.startsWith('Classify the design tier with the `ui-design` skill first, and read only the reference files it names. Plan the UI for this task.'));
});

test("the ui-planning step's session args grant Read on the ui-design skill directory and deny Edit", async () => {
  const dir = path.join(CATALOG, 'skills', 'ui-design');
  const args = interactiveCliArgs({ kind: 'claude-cli', readOnly: true, autonomy: 'auto', readOnlyDirs: [dir] });
  const allowed = args[args.indexOf('--allowed-tools') + 1];
  const denied = args[args.indexOf('--disallowed-tools') + 1];
  assert.equal(allowed, `Read(/${dir}/**)`);
  assert.equal(denied, `Edit(/${dir}/**)`);
});

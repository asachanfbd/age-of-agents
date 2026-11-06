import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { SkillInstallRun, SkillInstallRunner, SkillInstallSpawnFn } from '../src/catalog/skillInstall.ts';

/**
 * Every test in this file works against a throwaway `catalog/` fixture under
 * a temp dir, never this repo's real `catalog/` or its real `.claude/` —
 * AGENT_VISUAL_OS_CATALOG_DIR is set *before* any catalog module is
 * imported, since config.ts resolves its paths once, at import time, from
 * the environment (the same pattern AGENT_VISUAL_OS_PROJECTS_DIR/
 * AGENT_VISUAL_OS_DATA_DIR already use in api.test.ts and friends).
 * server/tests/fixtures/catalog/ mirrors the real repo's `catalog/`: a
 * builder.md + manager.md pair and a seeded catalog-index.json, so this
 * suite can exercise auto-discovery (things NOT in that seed) as well as
 * CRUD on what already is.
 */

let tempRoot: string;
let catalogDir: string;
let catalogService: typeof import('../src/catalog/catalogService.ts');
let pathsModule: typeof import('../src/catalog/paths.ts');
let skillInstallModule: typeof import('../src/catalog/skillInstall.ts');
let notificationService: typeof import('../src/notifications/notificationService.ts');

const zipFixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures', 'zips', name));

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'catalog-service-test-'));
  catalogDir = path.join(tempRoot, 'catalog');
  await cp(path.join(import.meta.dirname, 'fixtures', 'catalog'), catalogDir, { recursive: true });
  process.env.AGENT_VISUAL_OS_CATALOG_DIR = catalogDir;
  // skillInstall.ts now reports a failed install into notificationsDb (Milestone 5) — isolated
  // from the real server/data/ the same way AGENT_VISUAL_OS_PROJECTS_DIR/_DATA_DIR already are in
  // workerManager.test.ts/commandRunner.test.ts/gitSyncPoller.test.ts.
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');

  catalogService = await import('../src/catalog/catalogService.ts');
  pathsModule = await import('../src/catalog/paths.ts');
  skillInstallModule = await import('../src/catalog/skillInstall.ts');
  notificationService = await import('../src/notifications/notificationService.ts');
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function fakeChildProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, { stdout, stderr }) as unknown as ReturnType<SkillInstallSpawnFn>;
  return {
    child,
    emitStdout: (text: string) => stdout.write(text),
    close: (code: number | null) => emitter.emit('close', code),
    fail: (error: Error) => emitter.emit('error', error),
  };
}

/**
 * `settle()` inside skillInstall.ts does real async work (re-syncing the Catalog index on success
 * means real fs I/O) before it emits the terminal `skillInstall` event — a single `setImmediate`
 * isn't reliably enough ticks for that to finish. Waiting for the actual terminal event instead of
 * guessing a delay is the same fix commandRunner.test.ts's own `waitUntil` doc comment describes.
 */
function waitForInstallSettled(runner: SkillInstallRunner, runId: string): Promise<SkillInstallRun> {
  return new Promise((resolve) => {
    const unsubscribe = runner.onEvent((event) => {
      if (event.type === 'skillInstall' && event.run.id === runId && event.run.status !== 'running') {
        unsubscribe();
        resolve(event.run);
      }
    });
  });
}

// ---- Agents: listing, auto-discovery, index persistence ----

test('listAgents surfaces the seeded builder and manager from the fixture catalog/agents', async () => {
  const agents = await catalogService.listAgents();
  const builder = agents.find((a) => a.id === 'builder');
  assert.ok(builder);
  assert.equal(builder!.name, 'Builder');
  assert.equal(builder!.avatar, '🤖');
  assert.equal(builder!.manager, false);
  assert.equal(builder!.defaultAutonomy, 'auto');
  assert.equal(builder!.agentFile, 'agents/builder.md');
  assert.equal(builder!.enabled, true);

  const manager = agents.find((a) => a.id === 'manager');
  assert.ok(manager);
  assert.equal(manager!.manager, true);
});

test('getAgent finds by id and returns undefined for an unknown one', async () => {
  assert.equal((await catalogService.getAgent('builder'))?.name, 'Builder');
  assert.equal(await catalogService.getAgent('does-not-exist'), undefined);
});

test('getDefaultAgent returns the first enabled agent in listing order', async () => {
  const [first] = await catalogService.listAgents();
  const fallback = await catalogService.getDefaultAgent();
  assert.equal(fallback.id, first!.id);
  assert.equal(fallback.enabled, true);
});

test('readAgentPersona strips the frontmatter and returns the markdown body', async () => {
  const builder = await catalogService.getAgent('builder');
  const persona = await catalogService.readAgentPersona(builder!);
  assert.ok(!persona.startsWith('---'));
  assert.match(persona, /# Builder/);
});

test('auto-discovery: a hand-dropped agent file not yet in the index gets a synthesized entry, persisted back to catalog-index.json', async () => {
  await writeFile(
    path.join(catalogDir, 'agents', 'scout.md'),
    '---\nname: scout\ndescription: Looks around before anyone else does.\n---\n\n# Scout\n\nExplores first.',
    'utf-8',
  );

  const agents = await catalogService.listAgents();
  const scout = agents.find((a) => a.id === 'scout');
  assert.ok(scout);
  assert.equal(scout!.name, 'Scout'); // title-cased default, not the frontmatter's lowercase name
  assert.equal(scout!.avatar, '🤖');
  assert.equal(scout!.manager, false);
  assert.equal(scout!.defaultAutonomy, 'auto');
  assert.equal(scout!.enabled, true);

  // Persistence: re-reading the index file directly (a fresh read, not through listAgents again)
  // must already carry the synthesized entry.
  const index = JSON.parse(await readFile(path.join(catalogDir, 'catalog-index.json'), 'utf-8'));
  assert.ok(index.agents.scout);
  assert.equal(index.agents.scout.name, 'Scout');
});

test('an index entry for an agent file that no longer exists on disk is dropped on the next sync', async () => {
  await writeFile(path.join(catalogDir, 'agents', 'temp-agent.md'), '---\nname: temp-agent\ndescription: short-lived.\n---\n\nbody', 'utf-8');
  await catalogService.listAgents(); // indexes it
  assert.ok(await catalogService.getAgent('temp-agent'));

  await rm(path.join(catalogDir, 'agents', 'temp-agent.md'));
  assert.equal(await catalogService.getAgent('temp-agent'), undefined);
  const index = JSON.parse(await readFile(path.join(catalogDir, 'catalog-index.json'), 'utf-8'));
  assert.equal(index.agents['temp-agent'], undefined);
});

// ---- Agents: CRUD ----

test('createAgent writes a real markdown file (frontmatter name forced to the id) and an index entry', async () => {
  const agent = await catalogService.createAgent({
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews code for correctness.',
    body: '# Reviewer\n\nReview things carefully.',
    avatar: '🔎',
  });
  assert.equal(agent.id, 'reviewer');
  assert.equal(agent.name, 'Reviewer');
  assert.equal(agent.avatar, '🔎');
  assert.equal(agent.manager, false);
  assert.equal(agent.defaultAutonomy, 'auto');
  assert.equal(agent.enabled, true);

  const raw = await readFile(path.join(catalogDir, 'agents', 'reviewer.md'), 'utf-8');
  assert.match(raw, /^---\nname: reviewer\ndescription: Reviews code for correctness\.\n---\n/);
  assert.match(raw, /# Reviewer/);
});

test('createAgent rejects a duplicate id', async () => {
  await assert.rejects(() => catalogService.createAgent({ id: 'reviewer', name: 'Dup', description: 'x' }), catalogService.AgentAlreadyExistsError);
});

test('createAgent rejects a missing name or description', async () => {
  await assert.rejects(() => catalogService.createAgent({ id: 'no-name', name: '', description: 'x' }));
  await assert.rejects(() => catalogService.createAgent({ id: 'no-desc', name: 'x', description: '' }));
  assert.equal(await catalogService.getAgent('no-name'), undefined);
});

test('updateAgent edits description/body/avatar/manager/defaultAutonomy while keeping the frontmatter name equal to the id', async () => {
  const updated = await catalogService.updateAgent('reviewer', {
    name: 'Senior Reviewer',
    description: 'Reviews code for correctness and style.',
    body: '# Reviewer\n\nBe thorough.',
    avatar: '🧐',
    manager: true,
    defaultAutonomy: 'approval',
  });
  assert.equal(updated.name, 'Senior Reviewer');
  assert.equal(updated.avatar, '🧐');
  assert.equal(updated.manager, true);
  assert.equal(updated.defaultAutonomy, 'approval');

  const raw = await readFile(path.join(catalogDir, 'agents', 'reviewer.md'), 'utf-8');
  assert.match(raw, /name: reviewer/);
  assert.match(raw, /description: Reviews code for correctness and style\./);
  assert.match(raw, /Be thorough/);
});

test('updateAgent partial patch leaves untouched fields as they were', async () => {
  const before = await catalogService.getAgent('reviewer');
  const updated = await catalogService.updateAgent('reviewer', { avatar: '🕵️' });
  assert.equal(updated.avatar, '🕵️');
  assert.equal(updated.name, before!.name);
  assert.equal(updated.manager, before!.manager);
});

test('updateAgent 404s for an unknown id', async () => {
  await assert.rejects(() => catalogService.updateAgent('does-not-exist', { name: 'x' }), catalogService.AgentNotFoundError);
});

test('setAgentEnabled disables and re-enables without touching the markdown file', async () => {
  const rawBefore = await readFile(path.join(catalogDir, 'agents', 'reviewer.md'), 'utf-8');

  const disabled = await catalogService.setAgentEnabled('reviewer', false);
  assert.equal(disabled.enabled, false);
  assert.equal((await catalogService.getAgent('reviewer'))!.enabled, false);

  const enabled = await catalogService.setAgentEnabled('reviewer', true);
  assert.equal(enabled.enabled, true);

  const rawAfter = await readFile(path.join(catalogDir, 'agents', 'reviewer.md'), 'utf-8');
  assert.equal(rawBefore, rawAfter);
});

test('setAgentEnabled 404s for an unknown id', async () => {
  await assert.rejects(() => catalogService.setAgentEnabled('does-not-exist', false), catalogService.AgentNotFoundError);
});

test('a disabled agent is skipped by getDefaultAgent even when it would otherwise sort first', async () => {
  const [first] = await catalogService.listAgents();
  await catalogService.setAgentEnabled(first!.id, false);
  try {
    const fallback = await catalogService.getDefaultAgent();
    assert.notEqual(fallback.id, first!.id);
    assert.equal(fallback.enabled, true);
  } finally {
    await catalogService.setAgentEnabled(first!.id, true); // restore for later tests
  }
});

test('deleteAgent removes both the markdown file and the index entry', async () => {
  await catalogService.deleteAgent('reviewer');
  assert.equal(await catalogService.getAgent('reviewer'), undefined);
  await assert.rejects(() => readFile(path.join(catalogDir, 'agents', 'reviewer.md'), 'utf-8'), { code: 'ENOENT' });
  const index = JSON.parse(await readFile(path.join(catalogDir, 'catalog-index.json'), 'utf-8'));
  assert.equal(index.agents.reviewer, undefined);
});

test('deleteAgent 404s for an unknown id', async () => {
  await assert.rejects(() => catalogService.deleteAgent('does-not-exist'), catalogService.AgentNotFoundError);
});

test('uploadAgentFile registers a raw .md upload as-is, preserving unknown frontmatter keys and forcing only name to match the id', async () => {
  const content = '---\nname: whatever\ndescription: Uploaded agent.\ncustom-key: kept\n---\n\n# Uploaded\n\nBody text.';
  const agent = await catalogService.uploadAgentFile({ id: 'uploaded', content, avatar: '📦' });
  assert.equal(agent.id, 'uploaded');
  assert.equal(agent.avatar, '📦');
  assert.equal(agent.name, 'Uploaded'); // no explicit name override given, so it's title-cased from the id

  const raw = await readFile(path.join(catalogDir, 'agents', 'uploaded.md'), 'utf-8');
  assert.match(raw, /name: uploaded/);
  assert.match(raw, /custom-key: kept/);
  assert.match(raw, /Body text\./);
});

test('uploadAgentFile rejects a duplicate id and content missing a description', async () => {
  await assert.rejects(
    () => catalogService.uploadAgentFile({ id: 'uploaded', content: '---\nname: x\ndescription: y\n---\n\nz' }),
    catalogService.AgentAlreadyExistsError,
  );
  await assert.rejects(
    () => catalogService.uploadAgentFile({ id: 'bad-upload', content: '---\nname: x\n---\n\nbody' }),
    catalogService.InvalidAgentFileError,
  );
});

// ---- Path-traversal guards ----

test('createAgent and createSkill reject ids that could traverse outside the Catalog', async () => {
  for (const badId of ['../evil', '/etc/passwd', 'a/b', '..', '', 'a b']) {
    await assert.rejects(() => catalogService.createAgent({ id: badId, name: 'x', description: 'y' }));
    await assert.rejects(() => catalogService.createSkill({ id: badId, name: 'x', description: 'y' }));
  }
});

test('agentFilePath rejects a same-directory symlink that escapes catalog/agents, even for an otherwise-valid id', async () => {
  const outsideTarget = path.join(tempRoot, 'outside-secret.md');
  await writeFile(outsideTarget, 'secret', 'utf-8');
  await symlink(outsideTarget, path.join(catalogDir, 'agents', 'escape-link.md'));
  await assert.rejects(
    () => pathsModule.agentFilePath(path.join(catalogDir, 'agents'), 'escape-link'),
    pathsModule.CatalogPathTraversalError,
  );
});

// ---- Skills: listing, auto-discovery, CRUD, support files ----

test('listSkills starts empty in the fixture, then auto-discovers a hand-dropped skill folder', async () => {
  assert.deepEqual(await catalogService.listSkills(), []);

  await mkdir(path.join(catalogDir, 'skills', 'triage'), { recursive: true });
  await writeFile(
    path.join(catalogDir, 'skills', 'triage', 'SKILL.md'),
    '---\nname: triage\ndescription: Triages incoming issues.\n---\n\n# Triage\n',
    'utf-8',
  );

  const skills = await catalogService.listSkills();
  const triage = skills.find((s) => s.id === 'triage');
  assert.ok(triage);
  assert.equal(triage!.name, 'Triage');
  assert.equal(triage!.description, 'Triages incoming issues.');
  assert.equal(triage!.enabled, true);
  assert.deepEqual(triage!.supportFiles, []);
  assert.equal(triage!.skillDir, 'skills/triage');
});

test('createSkill writes SKILL.md and an index entry', async () => {
  const skill = await catalogService.createSkill({
    id: 'linting',
    name: 'Linting',
    description: 'Runs the linter and summarizes findings.',
    body: '# Linting\n\nRun eslint.',
    triggers: ['lint', 'eslint'],
  });
  assert.equal(skill.id, 'linting');
  assert.deepEqual(skill.triggers, ['lint', 'eslint']);

  const raw = await readFile(path.join(catalogDir, 'skills', 'linting', 'SKILL.md'), 'utf-8');
  assert.match(raw, /name: linting/);
  assert.match(raw, /description: Runs the linter and summarizes findings\./);
});

test('createSkill rejects a duplicate id and missing name/description', async () => {
  await assert.rejects(() => catalogService.createSkill({ id: 'linting', name: 'x', description: 'y' }), catalogService.SkillAlreadyExistsError);
  await assert.rejects(() => catalogService.createSkill({ id: 'no-desc-skill', name: 'x', description: '' }));
});

test('updateSkill edits description/body/triggers/avatar while keeping the frontmatter name equal to the id', async () => {
  const updated = await catalogService.updateSkill('linting', {
    description: 'Runs the linter.',
    triggers: ['lint'],
    avatar: '🧹',
  });
  assert.equal(updated.description, 'Runs the linter.');
  assert.deepEqual(updated.triggers, ['lint']);
  assert.equal(updated.avatar, '🧹');

  const raw = await readFile(path.join(catalogDir, 'skills', 'linting', 'SKILL.md'), 'utf-8');
  assert.match(raw, /name: linting/);
});

test('updateSkill 404s for an unknown id', async () => {
  await assert.rejects(() => catalogService.updateSkill('does-not-exist', { description: 'x' }), catalogService.SkillNotFoundError);
});

test('setSkillEnabled toggles without touching SKILL.md', async () => {
  const disabled = await catalogService.setSkillEnabled('linting', false);
  assert.equal(disabled.enabled, false);
  const enabled = await catalogService.setSkillEnabled('linting', true);
  assert.equal(enabled.enabled, true);
});

test('setSkillEnabled 404s for an unknown id', async () => {
  await assert.rejects(() => catalogService.setSkillEnabled('does-not-exist', true), catalogService.SkillNotFoundError);
});

test('addSkillSupportFile / listSkillSupportFiles / removeSkillSupportFile round-trip', async () => {
  const withFile = await catalogService.addSkillSupportFile('linting', 'rules.json', Buffer.from('{"rule":"no-console"}'));
  assert.deepEqual(withFile.supportFiles, ['rules.json']);
  assert.deepEqual(await catalogService.listSkillSupportFiles('linting'), ['rules.json']);

  const content = await readFile(path.join(catalogDir, 'skills', 'linting', 'rules.json'), 'utf-8');
  assert.equal(content, '{"rule":"no-console"}');

  const withoutFile = await catalogService.removeSkillSupportFile('linting', 'rules.json');
  assert.deepEqual(withoutFile.supportFiles, []);
});

test('addSkillSupportFile rejects the reserved SKILL.md name and traversal attempts', async () => {
  await assert.rejects(() => catalogService.addSkillSupportFile('linting', 'SKILL.md', Buffer.from('x')));
  await assert.rejects(() => catalogService.addSkillSupportFile('linting', '../escape.txt', Buffer.from('x')));
  await assert.rejects(() => catalogService.addSkillSupportFile('linting', '/etc/passwd', Buffer.from('x')));
});

test('addSkillSupportFile / removeSkillSupportFile / listSkillSupportFiles 404 for an unknown skill', async () => {
  await assert.rejects(() => catalogService.addSkillSupportFile('does-not-exist', 'x.txt', Buffer.from('x')), catalogService.SkillNotFoundError);
  await assert.rejects(() => catalogService.removeSkillSupportFile('does-not-exist', 'x.txt'), catalogService.SkillNotFoundError);
  await assert.rejects(() => catalogService.listSkillSupportFiles('does-not-exist'), catalogService.SkillNotFoundError);
});

test('deleteSkill removes the whole folder and the index entry', async () => {
  await catalogService.deleteSkill('linting');
  assert.equal(await catalogService.getSkill('linting'), undefined);
  await assert.rejects(() => readFile(path.join(catalogDir, 'skills', 'linting', 'SKILL.md'), 'utf-8'), { code: 'ENOENT' });
});

test('deleteSkill 404s for an unknown id', async () => {
  await assert.rejects(() => catalogService.deleteSkill('does-not-exist'), catalogService.SkillNotFoundError);
});

// ---- Skill zip upload: valid extraction + zip-slip rejection ----

test('uploadSkillZip extracts a valid zip into a new skill folder', async () => {
  const skill = await catalogService.uploadSkillZip({ id: 'zipped', zipBuffer: await zipFixture('valid-skill.zip'), avatar: '🗜️' });
  assert.equal(skill.id, 'zipped');
  assert.equal(skill.description, 'A zipped skill.');
  assert.equal(skill.avatar, '🗜️');
  assert.deepEqual(skill.supportFiles, ['notes.md']);

  const raw = await readFile(path.join(catalogDir, 'skills', 'zipped', 'SKILL.md'), 'utf-8');
  assert.match(raw, /name: zipped/); // forced to match the id, like every other write path
  const notes = await readFile(path.join(catalogDir, 'skills', 'zipped', 'notes.md'), 'utf-8');
  assert.equal(notes, 'extra notes');
});

test('uploadSkillZip rejects a duplicate id', async () => {
  await assert.rejects(
    async () => catalogService.uploadSkillZip({ id: 'zipped', zipBuffer: await zipFixture('valid-skill.zip') }),
    catalogService.SkillAlreadyExistsError,
  );
});

test('uploadSkillZip rejects a zip with no SKILL.md at its root, and leaves nothing registered', async () => {
  await assert.rejects(
    async () => catalogService.uploadSkillZip({ id: 'no-skill-md', zipBuffer: await zipFixture('no-skill-md.zip') }),
    catalogService.InvalidSkillFileError,
  );
  assert.equal(await catalogService.getSkill('no-skill-md'), undefined);
});

// yauzl itself validates every entry's fileName as it's parsed (no ".." component, nothing absolute —
// see node_modules/yauzl/index.js's validateFileName) and aborts the whole read before our own
// planEntry() guard ever runs, surfacing as InvalidZipError rather than ZipSlipError. That's a real
// first layer of defense, not a reason to drop our own: it doesn't know anything about symlink
// entries (see the next test), which is exactly what planEntry()'s check catches instead.

test('uploadSkillZip rejects a zip-slip entry with a "../" escape, and extracts nothing', async () => {
  await assert.rejects(
    async () => catalogService.uploadSkillZip({ id: 'slip-relative', zipBuffer: await zipFixture('zip-slip-relative.zip') }),
    catalogService.InvalidZipError,
  );
  assert.equal(await catalogService.getSkill('slip-relative'), undefined);
  await assert.rejects(() => readFile(path.join(catalogDir, 'skills', 'slip-relative', 'SKILL.md'), 'utf-8'), { code: 'ENOENT' });
  await assert.rejects(() => readFile(path.join(tempRoot, 'evil.txt'), 'utf-8'), { code: 'ENOENT' });
});

test('uploadSkillZip rejects a zip-slip entry with an absolute path', async () => {
  await assert.rejects(
    async () => catalogService.uploadSkillZip({ id: 'slip-absolute', zipBuffer: await zipFixture('zip-slip-absolute.zip') }),
    catalogService.InvalidZipError,
  );
  await assert.rejects(() => readFile('/tmp/evil-absolute.txt', 'utf-8'), { code: 'ENOENT' });
});

test('uploadSkillZip rejects a symlink entry (the zip-format equivalent of a zip-slip escape) — this one is NOT caught by yauzl\'s own fileName validation, only by our own planEntry() check', async () => {
  await assert.rejects(
    async () => catalogService.uploadSkillZip({ id: 'slip-symlink', zipBuffer: await zipFixture('zip-slip-symlink.zip') }),
    catalogService.ZipSlipError,
  );
  assert.equal(await catalogService.getSkill('slip-symlink'), undefined);
});

// ---- Skill install: mocked subprocess only, never real npx / network ----

test('install() rejects an invalid "owner/repo" slug without spawning anything', () => {
  let spawned = false;
  const spawnFn: SkillInstallSpawnFn = () => { spawned = true; throw new Error('should not spawn'); };
  const runner = skillInstallModule.createSkillInstallRunner(spawnFn);
  for (const bad of ['not-a-slug', 'owner/', '/repo', 'owner/repo/extra', 'owner repo/x']) {
    assert.throws(() => runner.install(bad), skillInstallModule.InvalidRepoSlugError);
  }
  assert.equal(spawned, false);
});

test('install() spawns `npx skills add <repo>` with cwd set to a fresh temp dir (never the real repo), streams output, and settles success on a zero exit', async () => {
  const fake = fakeChildProcess();
  let capturedCommand = '';
  let capturedArgs: string[] = [];
  let capturedCwd = '';
  const spawnFn: SkillInstallSpawnFn = (command, args, options) => { capturedCommand = command; capturedArgs = args; capturedCwd = options.cwd; return fake.child; };
  const runner = skillInstallModule.createSkillInstallRunner(spawnFn);

  const events: Array<{ type: string; run?: { status: string }; runId?: string }> = [];
  runner.onEvent((event) => events.push(event));

  const run = runner.install('some-owner/some-skill');
  assert.equal(run.status, 'running');
  assert.equal(capturedCommand, 'npx');
  assert.deepEqual(capturedArgs, ['skills', 'add', 'some-owner/some-skill', '-y', '--copy', '--agent', 'claude-code']);
  // cwd is a throwaway temp dir the install runner created itself, not REPO_ROOT and not the Catalog dir —
  // this is what stops `npx skills add` from ever writing into this repo's real .claude/.
  assert.ok(capturedCwd.includes('agent-visual-os-skill-install-'));
  assert.notEqual(capturedCwd, catalogDir);

  const settledPromise = waitForInstallSettled(runner, run.id);
  fake.emitStdout('installing...\n');
  fake.close(0);
  const settled = await settledPromise;
  assert.equal(runner.getRun(run.id).status, 'success');
  assert.match(settled.output, /installing/);
  assert.ok(settled.completedAt);
  assert.ok(events.some((e) => e.type === 'skillInstallLog'));
  assert.ok(events.some((e) => e.type === 'skillInstall' && e.run?.status === 'success'));
  // The temp dir is cleaned up once the run settles.
  await assert.rejects(() => stat(capturedCwd), { code: 'ENOENT' });

  // A successful install isn't attention-needing — it must not raise a Notification.
  const afterSuccess = await notificationService.listNotifications({ resolved: false, projectId: 'none' });
  assert.deepEqual(afterSuccess.filter((n) => n.kind === 'skill.install_failed'), []);
});

test('install() settles failed on a non-zero exit, and raises a Project-less warning Notification', async () => {
  const fake = fakeChildProcess();
  const runner = skillInstallModule.createSkillInstallRunner(() => fake.child);
  const run = runner.install('some-owner/broken-skill');
  const settledPromise = waitForInstallSettled(runner, run.id);
  fake.emitStdout('some real npx failure output\n');
  fake.close(1);
  await settledPromise;
  assert.equal(runner.getRun(run.id).status, 'failed');

  const notifications = await notificationService.listNotifications({ resolved: false, projectId: 'none' });
  const own = notifications.filter((n) => n.kind === 'skill.install_failed' && n.title.includes('some-owner/broken-skill'));
  assert.equal(own.length, 1);
  assert.equal(own[0]?.severity, 'warning');
  assert.equal(own[0]?.projectId, null, "skill installs aren't scoped to a Project");
  assert.match(own[0]?.description ?? '', /npx failure output/);
});

test('install() settles failed when the subprocess itself fails to start, and raises a Notification', async () => {
  const fake = fakeChildProcess();
  const runner = skillInstallModule.createSkillInstallRunner(() => fake.child);
  const run = runner.install('some-owner/missing-npx');
  const settledPromise = waitForInstallSettled(runner, run.id);
  fake.fail(new Error('spawn npx ENOENT'));
  await settledPromise;
  const settled = runner.getRun(run.id);
  assert.equal(settled.status, 'failed');
  assert.match(settled.output, /Failed to start/);

  const notifications = await notificationService.listNotifications({ resolved: false, projectId: 'none' });
  const own = notifications.filter((n) => n.kind === 'skill.install_failed' && n.title.includes('some-owner/missing-npx'));
  assert.equal(own.length, 1);
  assert.match(own[0]?.description ?? '', /Failed to start/);
});

test('install() resolves an open skill.install_failed Notification once a later install of the same repo succeeds', async () => {
  const failFake = fakeChildProcess();
  const runner = skillInstallModule.createSkillInstallRunner(() => failFake.child);
  const failedRun = runner.install('some-owner/retry-skill');
  const failedSettled = waitForInstallSettled(runner, failedRun.id);
  failFake.close(1);
  await failedSettled;
  assert.equal((await notificationService.listNotifications({ resolved: false, projectId: 'none' })).filter((n) => n.kind === 'skill.install_failed' && n.title.includes('retry-skill')).length, 1);

  const successFake = fakeChildProcess();
  const retryRunner = skillInstallModule.createSkillInstallRunner(() => successFake.child);
  const successRun = retryRunner.install('some-owner/retry-skill');
  const successSettled = waitForInstallSettled(retryRunner, successRun.id);
  successFake.close(0);
  await successSettled;

  assert.equal((await notificationService.listNotifications({ resolved: false, projectId: 'none' })).filter((n) => n.kind === 'skill.install_failed' && n.title.includes('retry-skill')).length, 0);
});

test('install() failing again for the same repo updates the existing Notification in place rather than duplicating, and does not affect a different repo', async () => {
  const otherFake = fakeChildProcess();
  const otherRunner = skillInstallModule.createSkillInstallRunner(() => otherFake.child);
  const otherRun = otherRunner.install('some-owner/unrelated-repo');
  const otherSettled = waitForInstallSettled(otherRunner, otherRun.id);
  otherFake.close(1);
  await otherSettled;

  const firstFake = fakeChildProcess();
  const firstRunner = skillInstallModule.createSkillInstallRunner(() => firstFake.child);
  const firstRun = firstRunner.install('some-owner/dedupe-skill');
  const firstSettled = waitForInstallSettled(firstRunner, firstRun.id);
  firstFake.emitStdout('first failure\n');
  firstFake.close(1);
  await firstSettled;

  const secondFake = fakeChildProcess();
  const secondRunner = skillInstallModule.createSkillInstallRunner(() => secondFake.child);
  const secondRun = secondRunner.install('some-owner/dedupe-skill');
  const secondSettled = waitForInstallSettled(secondRunner, secondRun.id);
  secondFake.emitStdout('second failure\n');
  secondFake.close(1);
  await secondSettled;

  const ownNotifications = (await notificationService.listNotifications({ projectId: 'none' })).filter((n) => n.title.includes('dedupe-skill'));
  assert.equal(ownNotifications.length, 1, 'dedupes in place rather than creating a second record');
  assert.match(ownNotifications[0]!.description, /second failure/);

  const unrelated = (await notificationService.listNotifications({ resolved: false, projectId: 'none' })).find((n) => n.title.includes('unrelated-repo'));
  assert.ok(unrelated, 'a different repo failing is unaffected');
});

test('install() re-syncs the Catalog index after a successful install', async () => {
  await mkdir(path.join(catalogDir, 'skills', 'installed-skill'), { recursive: true });
  await writeFile(
    path.join(catalogDir, 'skills', 'installed-skill', 'SKILL.md'),
    '---\nname: installed-skill\ndescription: Dropped in by the mocked install.\n---\n\nbody',
    'utf-8',
  );
  // Checked by reading catalog-index.json directly, not via catalogService.getSkill — that call
  // would itself trigger auto-discovery as a side effect (every read re-syncs, per
  // syncCatalogIndex's doc comment) and falsely "prove" the install runner did something it didn't.
  const indexBefore = JSON.parse(await readFile(path.join(catalogDir, 'catalog-index.json'), 'utf-8'));
  assert.equal(indexBefore.skills['installed-skill'], undefined);

  const fake = fakeChildProcess();
  const runner = skillInstallModule.createSkillInstallRunner(() => fake.child);
  const run = runner.install('some-owner/installed-skill');
  const settledPromise = waitForInstallSettled(runner, run.id);
  fake.close(0);
  await settledPromise;

  const indexAfter = JSON.parse(await readFile(path.join(catalogDir, 'catalog-index.json'), 'utf-8'));
  assert.ok(indexAfter.skills['installed-skill']);
});

// The real repo's own .claude/ — the daemon must never read or write it as part of a skill install.
// A recursive snapshot (relative paths + mtimes) is taken before and after the test below and
// compared, rather than just asserting a specific path doesn't exist, so ANY change under it
// (new file, removed file, or an existing file rewritten) would fail the test.
const REAL_REPO_CLAUDE_DIR = path.resolve(import.meta.dirname, '..', '..', '.claude');

async function snapshotClaudeDir(): Promise<Record<string, number>> {
  const entries = await readdir(REAL_REPO_CLAUDE_DIR, { recursive: true });
  const snapshot: Record<string, number> = {};
  for (const entry of entries.sort()) {
    const full = path.join(REAL_REPO_CLAUDE_DIR, entry);
    const info = await stat(full);
    if (info.isFile()) snapshot[entry] = info.mtimeMs;
  }
  return snapshot;
}

test('install() copies the skill(s) the mocked CLI wrote into its tmpdir cwd into catalog/skills/, and never touches the real repo .claude/', async () => {
  const claudeBefore = await snapshotClaudeDir();

  let capturedCwd = '';
  let fake: ReturnType<typeof fakeChildProcess>;
  const spawnFn: SkillInstallSpawnFn = (_command, _args, options) => {
    capturedCwd = options.cwd;
    fake = fakeChildProcess();
    return fake.child;
  };
  const runner = skillInstallModule.createSkillInstallRunner(spawnFn);

  const run = runner.install('some-owner/tmpdir-skill');
  assert.ok(capturedCwd.includes('agent-visual-os-skill-install-'), 'spawnFn should have been called synchronously with a tmpdir cwd');

  // Simulate exactly what the real `npx skills add ... --copy --agent claude-code` CLI does:
  // write the installed skill's SKILL.md under `<cwd>/.claude/skills/<id>/`.
  await mkdir(path.join(capturedCwd, '.claude', 'skills', 'tmpdir-skill'), { recursive: true });
  await writeFile(
    path.join(capturedCwd, '.claude', 'skills', 'tmpdir-skill', 'SKILL.md'),
    '---\nname: tmpdir-skill\ndescription: Installed via the mocked tmpdir CLI run.\n---\n\n# Tmpdir Skill\n',
    'utf-8',
  );

  const settledPromise = waitForInstallSettled(runner, run.id);
  fake!.close(0); // "CLI process" exits successfully now that it has "written" its output.
  await settledPromise;

  const copied = await readFile(path.join(catalogDir, 'skills', 'tmpdir-skill', 'SKILL.md'), 'utf-8');
  assert.match(copied, /Installed via the mocked tmpdir CLI run/);

  const index = JSON.parse(await readFile(path.join(catalogDir, 'catalog-index.json'), 'utf-8'));
  assert.ok(index.skills['tmpdir-skill']);

  const claudeAfter = await snapshotClaudeDir();
  assert.deepEqual(claudeAfter, claudeBefore);
});

test('install() settles failed immediately when spawnFn itself throws synchronously (e.g. npx not on PATH)', async () => {
  // install()'s own try/catch calls settle() synchronously, which sets run.status/output
  // synchronously (before settle()'s first await) — already visible without waiting.
  const spawnFn: SkillInstallSpawnFn = () => { throw new Error('spawn npx ENOENT'); };
  const runner = skillInstallModule.createSkillInstallRunner(spawnFn);

  const run = runner.install('some-owner/no-npx-binary');
  const settled = runner.getRun(run.id);
  assert.equal(settled.status, 'failed');
  assert.match(settled.output, /Failed to start/);

  // settle()'s trailing work (temp dir cleanup, and — for a failed run — its Notification write)
  // is still in flight at this point. Wait for the terminal event, as every other settle() path in
  // this file does, so nothing leaks past this test into the next.
  await waitForInstallSettled(runner, run.id);
});

test('install() only settles once even if both "close" and "error" fire on the same subprocess', async () => {
  const fake = fakeChildProcess();
  const runner = skillInstallModule.createSkillInstallRunner(() => fake.child);
  const run = runner.install('some-owner/double-event-skill');

  const settledPromise = waitForInstallSettled(runner, run.id);
  fake.close(0); // settles first, as success
  await settledPromise;
  fake.fail(new Error('late spurious error')); // must be a no-op — already settled

  const settled = runner.getRun(run.id);
  assert.equal(settled.status, 'success');
  assert.doesNotMatch(settled.output, /late spurious error/);
});

test('getRun 404s for an unknown run id', () => {
  const runner = skillInstallModule.createSkillInstallRunner(() => fakeChildProcess().child);
  assert.throws(() => runner.getRun('does-not-exist'), skillInstallModule.SkillInstallNotFoundError);
});

// Catalog reads run syncCatalogIndex, which writes catalog-index.json when it
// auto-discovers a file with no entry yet. These bursts race reads against
// mutations so an unserialized read-modify-write (B.014) loses entries.
const BURST_SIZE = 12;
const burstIds = (prefix: string) => Array.from({ length: BURST_SIZE }, (_, i) => `${prefix}-${i}`);

async function readIndexOnDisk(): Promise<{ agents: Record<string, unknown>; skills: Record<string, unknown> }> {
  return JSON.parse(await readFile(path.join(catalogDir, 'catalog-index.json'), 'utf-8'));
}

test('concurrent createSkill calls racing catalog reads keep every index entry intact', async () => {
  const ids = burstIds('burst-skill');
  await Promise.all([
    ...ids.map((id) =>
      catalogService.createSkill({ id, name: 'Burst Skill', description: 'Burst.', avatar: '🛰️', triggers: ['t'] }),
    ),
    ...ids.map(() => catalogService.listAgents()),
  ]);

  await readIndexOnDisk(); // throws if a write left the file corrupt
  for (const id of ids) {
    const skill = await catalogService.getSkill(id);
    assert.equal(skill?.name, 'Burst Skill', id);
    assert.equal(skill?.avatar, '🛰️', id);
    assert.deepEqual(skill?.triggers, ['t'], id);
  }
});

test('concurrent createAgent calls racing catalog reads keep manager and defaultAutonomy', async () => {
  const ids = burstIds('burst-agent');
  await Promise.all([
    ...ids.map((id) =>
      catalogService.createAgent({
        id,
        name: 'Burst Agent',
        description: 'Burst.',
        avatar: '🛰️',
        manager: true,
        defaultAutonomy: 'approval',
      }),
    ),
    ...ids.map(() => catalogService.listSkills()),
  ]);

  await readIndexOnDisk();
  for (const id of ids) {
    const agent = await catalogService.getAgent(id);
    assert.equal(agent?.name, 'Burst Agent', id);
    assert.equal(agent?.manager, true, id);
    assert.equal(agent?.defaultAutonomy, 'approval', id);
  }
});

test('concurrent updateSkill calls racing catalog reads are not reverted', async () => {
  const ids = burstIds('burst-skill');
  await Promise.all([
    ...ids.map((id) => catalogService.updateSkill(id, { triggers: ['x'] })),
    ...ids.map(() => catalogService.listAgents()),
  ]);

  for (const id of ids) {
    assert.deepEqual((await catalogService.getSkill(id))?.triggers, ['x'], id);
  }
});

test('concurrent index mutations leave a parseable index and no temp files behind', async () => {
  await Promise.all([
    ...burstIds('burst-skill').map((id, i) =>
      i % 2 === 0 ? catalogService.setSkillEnabled(id, false) : catalogService.deleteSkill(id),
    ),
    ...burstIds('burst-agent').map((id) => catalogService.deleteAgent(id)),
    ...burstIds('burst-skill').map(() => catalogService.listAgents()),
  ]);

  const index = await readIndexOnDisk();
  assert.equal(Object.keys(index.agents).some((id) => id.startsWith('burst-agent-')), false);
  assert.deepEqual(
    Object.keys(index.skills).filter((id) => id.startsWith('burst-skill-')).sort(),
    burstIds('burst-skill').filter((_, i) => i % 2 === 0).sort(),
  );
  assert.deepEqual((await readdir(catalogDir)).filter((name) => name.endsWith('.tmp')), []);
});

test('a failed catalog index operation does not block later ones', async () => {
  const indexPath = path.join(catalogDir, 'catalog-index.json');
  const original = await readFile(indexPath, 'utf-8');
  await writeFile(indexPath, '{ not json', 'utf-8');
  try {
    await assert.rejects(() => catalogService.listAgents(), SyntaxError);
  } finally {
    await writeFile(indexPath, original, 'utf-8');
  }
  assert.ok((await catalogService.listAgents()).length > 0);
});

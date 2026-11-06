import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { git } from '../src/projects/git.ts';

// Cases 1-14 from task 7.001's test plan: pure detection against a real throwaway git fixture — the
// app's own checkout (AGENT_VISUAL_OS_APP_ROOT) compared against a local bare "origin", the same
// fetch-and-compare shape gitSyncPoller.test.ts exercises for a Project, just with no URL rewriting
// needed (the app's origin is a plain local path, not a github.com URL to rewrite).

let root: string;
let appDir: string;
let seedDir: string;
let detector: typeof import('../src/appUpdate/appUpdateDetector.ts');

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'app-update-detector-'));
  appDir = path.join(root, 'app');
  seedDir = path.join(root, 'seed');
  process.env.AGENT_VISUAL_OS_APP_ROOT = appDir;
  process.env.AGENT_VISUAL_OS_RUN_DIR = path.join(root, 'run');
  // This file's detection assertions are mode-independent except for the dedicated "dev mode" case
  // below — pin it explicitly rather than depending on the ambient shell/CI environment (which may
  // itself have NODE_ENV=production set).
  process.env.NODE_ENV = 'test';
  process.env.GIT_CONFIG_COUNT = '2';
  process.env.GIT_CONFIG_KEY_0 = 'user.name'; process.env.GIT_CONFIG_VALUE_0 = 'Test';
  process.env.GIT_CONFIG_KEY_1 = 'user.email'; process.env.GIT_CONFIG_VALUE_1 = 'test@example.com';

  await git(root, ['init', '--bare', '--initial-branch=main', 'origin.git']);
  await git(root, ['clone', path.join(root, 'origin.git'), 'app']);
  await writeFile(path.join(appDir, 'README.md'), 'v1');
  await git(appDir, ['add', '.']);
  await git(appDir, ['commit', '-m', 'initial']);
  await git(appDir, ['push', 'origin', 'main']);
  await git(root, ['clone', path.join(root, 'origin.git'), 'seed']);

  detector = await import('../src/appUpdate/appUpdateDetector.ts');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Resyncs `app` to origin/main after a scenario that left it behind, so the next test starts clean. */
async function resyncApp(): Promise<void> {
  await git(appDir, ['merge', '--ff-only', 'origin/main']);
}

test('isWebOnly: every changed file under web/ is web-only; a mixed or empty list is not', () => {
  assert.equal(detector.isWebOnly(['web/src/App.tsx', 'web/package.json']), true);
  assert.equal(detector.isWebOnly(['web/src/App.tsx', 'server/src/index.ts']), false);
  assert.equal(detector.isWebOnly(['package.json']), false);
  assert.equal(detector.isWebOnly(['scripts/prod-start.sh']), false);
  assert.equal(detector.isWebOnly([]), false, 'zero changed files never silently reads as web-only');
});

test('needsWebInstall: only a web manifest/lockfile change sets it', () => {
  assert.equal(detector.needsWebInstall(['web/package.json']), true);
  assert.equal(detector.needsWebInstall(['web/package-lock.json']), true);
  assert.equal(detector.needsWebInstall(['web/src/App.tsx']), false);
});

test('computeApplyFields: held/updating always block regardless of mode/availability; dev mode blocks with its own message; otherwise mirrors availability', () => {
  assert.equal(detector.computeApplyFields('prod', 'available', 'held').canApply, false);
  assert.match(detector.computeApplyFields('prod', 'available', 'held').applyBlockedReason ?? '', /already held/);
  assert.match(detector.computeApplyFields('prod', 'available', 'updating').applyBlockedReason ?? '', /being applied/);
  assert.equal(detector.computeApplyFields('dev', 'available', 'idle').canApply, false);
  assert.match(detector.computeApplyFields('dev', 'available', 'idle').applyBlockedReason ?? '', /production-style install/);
  assert.deepEqual(detector.computeApplyFields('prod', 'up-to-date', 'idle'), { canApply: false, applyBlockedReason: null });
  assert.deepEqual(detector.computeApplyFields('prod', 'available', 'idle'), { canApply: true, applyBlockedReason: null });
});

test('2: a freshly cloned checkout is up to date', async () => {
  const status = await detector.computeAppUpdateStatus(null);
  assert.equal(status.availability, 'up-to-date');
  assert.equal(status.behindBy, 0);
  assert.equal(status.aheadBy, 0);
  assert.equal(status.branch, 'main');
  assert.ok(status.currentCommit);
  assert.ok(status.checkedAt);
  assert.ok(status.lastSuccessfulCheckAt);
  assert.equal(status.checkError, null);
});

test('2: behindBy > 0 reports available(N)', async () => {
  await writeFile(path.join(seedDir, 'README.md'), 'v2');
  await git(seedDir, ['commit', '-am', 'remote change']);
  await git(seedDir, ['push', 'origin', 'main']);

  const status = await detector.computeAppUpdateStatus(null);
  assert.equal(status.availability, 'available');
  assert.equal(status.behindBy, 1);
  assert.equal(status.aheadBy, 0);
  assert.equal(status.classification, 'server');

  await resyncApp();
});

test('3: an unpushed local commit is ahead, not available, and names "ahead" in the reason', async () => {
  await writeFile(path.join(appDir, 'local-only.txt'), 'local work');
  await git(appDir, ['add', '.']);
  await git(appDir, ['commit', '-m', 'local work']);

  const status = await detector.computeAppUpdateStatus(null);
  assert.equal(status.availability, 'cant-auto-update');
  assert.match(status.cantUpdateReason ?? '', /ahead/);

  await git(appDir, ['reset', '--hard', 'origin/main']);
});

test('3: a diverged checkout names "diverged" in the reason', async () => {
  await writeFile(path.join(appDir, 'local-only.txt'), 'local divergent work');
  await git(appDir, ['add', '.']);
  await git(appDir, ['commit', '-m', 'local divergent work']);
  await writeFile(path.join(seedDir, 'README.md'), 'v3 remote');
  await git(seedDir, ['commit', '-am', 'remote divergent work']);
  await git(seedDir, ['push', 'origin', 'main']);

  const status = await detector.computeAppUpdateStatus(null);
  assert.equal(status.availability, 'cant-auto-update');
  assert.match(status.cantUpdateReason ?? '', /diverged/);

  await git(appDir, ['reset', '--hard', 'origin/main']);
});

test('4: local changes to files the update does not touch leave it available; an overlapping edit makes it cant-auto-update and names the file', async () => {
  await writeFile(path.join(seedDir, 'README.md'), 'v4 remote (fast-forwardable)');
  await git(seedDir, ['commit', '-am', 'another remote change']);
  await git(seedDir, ['push', 'origin', 'main']);
  await writeFile(path.join(appDir, 'dirty.txt'), 'uncommitted');

  const unrelated = await detector.computeAppUpdateStatus(null);
  assert.equal(unrelated.availability, 'available');
  assert.deepEqual(unrelated.blockingFiles, []);
  assert.equal(unrelated.blockingFilesTotal, 0);

  await writeFile(path.join(appDir, 'README.md'), 'my edit');
  const overlapping = await detector.computeAppUpdateStatus(null);
  assert.equal(overlapping.availability, 'cant-auto-update');
  assert.match(overlapping.cantUpdateReason ?? '', /uncommitted changes to files the update also changes: README\.md/);
  assert.deepEqual(overlapping.blockingFiles, [{ path: 'README.md', kind: 'modified' }]);

  await rm(path.join(appDir, 'dirty.txt'));
  await git(appDir, ['checkout', '--', 'README.md']);
  await resyncApp();
});

test('5: detached HEAD is could-not-check, never cant-auto-update or available', async () => {
  await git(appDir, ['checkout', '--detach', 'HEAD']);
  const status = await detector.computeAppUpdateStatus(null);
  assert.equal(status.availability, 'could-not-check');
  assert.ok(status.checkError);
  await git(appDir, ['checkout', 'main']);
});

test('5: no "origin" remote is could-not-check, never cant-auto-update or available', async () => {
  await git(appDir, ['remote', 'remove', 'origin']);
  const status = await detector.computeAppUpdateStatus(null);
  assert.equal(status.availability, 'could-not-check');
  assert.ok(status.checkError);
  await git(appDir, ['remote', 'add', 'origin', path.join(root, 'origin.git')]);
  await git(appDir, ['fetch', 'origin']);
});

test('5: a fetch failure is could-not-check, never cant-auto-update or available', async () => {
  await git(appDir, ['remote', 'set-url', 'origin', path.join(root, 'nonexistent-remote.git')]);
  const status = await detector.computeAppUpdateStatus(null);
  assert.equal(status.availability, 'could-not-check');
  assert.ok(status.checkError);
  await git(appDir, ['remote', 'set-url', 'origin', path.join(root, 'origin.git')]);
});

test('6+7: a failed check keeps previous status/behindBy/branch untouched, only checkError + checkedAt change; lastSuccessfulCheckAt tells "never checked" apart from "stale but known"', async () => {
  const good = await detector.computeAppUpdateStatus(null);
  assert.equal(good.checkError, null);
  assert.ok(good.lastSuccessfulCheckAt);

  await git(appDir, ['remote', 'set-url', 'origin', path.join(root, 'nonexistent-remote.git')]);
  const failed = await detector.computeAppUpdateStatus(good);
  assert.equal(failed.availability, 'could-not-check');
  assert.ok(failed.checkError);
  assert.equal(failed.branch, good.branch);
  assert.equal(failed.behindBy, good.behindBy);
  assert.equal(failed.currentCommit, good.currentCommit);
  assert.equal(failed.lastSuccessfulCheckAt, good.lastSuccessfulCheckAt, 'unchanged by a failed attempt');
  assert.notEqual(failed.checkedAt, good.checkedAt);

  // The very first check ever, if it fails, has no prior good reading to fall back to —
  // lastSuccessfulCheckAt stays null, distinguishing "never checked successfully" from "stale".
  const neverChecked = await detector.computeAppUpdateStatus(null);
  assert.equal(neverChecked.availability, 'could-not-check');
  assert.equal(neverChecked.lastSuccessfulCheckAt, null);

  await git(appDir, ['remote', 'set-url', 'origin', path.join(root, 'origin.git')]);
});

test('22: dev mode (the default test env, IS_PROD_MODE false) still runs detection normally — availability/behindBy are never suppressed — but canApply is false with a dev-mode-specific explanation', async () => {
  await writeFile(path.join(seedDir, 'README.md'), 'v22 dev mode check');
  await git(seedDir, ['commit', '-am', 'dev mode behind check']);
  await git(seedDir, ['push', 'origin', 'main']);

  const status = await detector.computeAppUpdateStatus(null);
  assert.equal(status.mode, 'dev');
  assert.equal(status.availability, 'available');
  assert.equal(status.behindBy, 1);
  assert.equal(status.canApply, false);
  assert.match(status.applyBlockedReason ?? '', /production-style install/);

  await resyncApp();
});

test('8/9: classification is web-only only when every changed file is under web/; any file outside it forces server', async () => {
  const { mkdir } = await import('node:fs/promises');
  // Web-only: add files only under web/.
  await mkdir(path.join(seedDir, 'web', 'src'), { recursive: true });
  await writeFile(path.join(seedDir, 'web', 'src', 'App.tsx'), 'export default function App() {}');
  await git(seedDir, ['add', '.']);
  await git(seedDir, ['commit', '-m', 'web-only change']);
  await git(seedDir, ['push', 'origin', 'main']);

  const webOnlyStatus = await detector.computeAppUpdateStatus(null);
  assert.equal(webOnlyStatus.availability, 'available');
  assert.equal(webOnlyStatus.classification, 'web-only');
  await resyncApp();

  // Server: a change touching anything outside web/ (even alongside a web/ file) forces server.
  await writeFile(path.join(seedDir, 'web', 'src', 'App.tsx'), 'export default function App2() {}');
  await writeFile(path.join(seedDir, 'server-file.txt'), 'server change');
  await git(seedDir, ['add', '.']);
  await git(seedDir, ['commit', '-m', 'mixed change']);
  await git(seedDir, ['push', 'origin', 'main']);

  const serverStatus = await detector.computeAppUpdateStatus(null);
  assert.equal(serverStatus.availability, 'available');
  assert.equal(serverStatus.classification, 'server');
  await resyncApp();
});

test('10/11: a web manifest/lockfile change still reads web-only but sets installWebDeps; a non-manifest web change does not', async () => {
  await writeFile(path.join(seedDir, 'web', 'package.json'), '{"name":"web"}');
  await git(seedDir, ['add', '.']);
  await git(seedDir, ['commit', '-m', 'bump web deps']);
  await git(seedDir, ['push', 'origin', 'main']);

  const withManifest = await detector.computeAppUpdateStatus(null);
  assert.equal(withManifest.classification, 'web-only');
  assert.equal(withManifest.installWebDeps, true);
  await resyncApp();

  await writeFile(path.join(seedDir, 'web', 'src', 'App.tsx'), 'export default function App3() {}');
  await git(seedDir, ['add', '.']);
  await git(seedDir, ['commit', '-m', 'non-manifest web change']);
  await git(seedDir, ['push', 'origin', 'main']);

  const withoutManifest = await detector.computeAppUpdateStatus(null);
  assert.equal(withoutManifest.classification, 'web-only');
  assert.equal(withoutManifest.installWebDeps, false);
  await resyncApp();
});

test('12: a change to root package.json / scripts/prod-start.sh / scripts/prod-stop.sh forces server with no special-casing (it just falls out of the web/-prefix rule)', async () => {
  await writeFile(path.join(seedDir, 'package.json'), '{"name":"root"}');
  await git(seedDir, ['add', '.']);
  await git(seedDir, ['commit', '-m', 'root package.json change']);
  await git(seedDir, ['push', 'origin', 'main']);

  const status = await detector.computeAppUpdateStatus(null);
  assert.equal(status.classification, 'server');
  await resyncApp();
});

test('13: zero changed files reported for a nonzero behindBy falls back to server, never silently web-only', async () => {
  await git(seedDir, ['commit', '--allow-empty', '-m', 'empty commit']);
  await git(seedDir, ['push', 'origin', 'main']);

  const status = await detector.computeAppUpdateStatus(null);
  assert.equal(status.behindBy, 1);
  assert.equal(status.classification, 'server');
  await resyncApp();
});

test('14: the incoming-commit list truncates at 10, behindBy still reflects the real total, and incomingCommitsTruncated flips accordingly', async () => {
  for (let i = 0; i < 12; i += 1) {
    await writeFile(path.join(seedDir, `batch-${i}.txt`), String(i));
    await git(seedDir, ['add', '.']);
    await git(seedDir, ['commit', '-m', `batch commit ${i}`]);
  }
  await git(seedDir, ['push', 'origin', 'main']);

  const status = await detector.computeAppUpdateStatus(null);
  assert.equal(status.behindBy, 12);
  assert.equal(status.incomingCommits.length, 10);
  assert.equal(status.incomingCommitsTruncated, true);
  // Newest first.
  assert.equal(status.incomingCommits[0]?.subject, 'batch commit 11');
  await resyncApp();

  await writeFile(path.join(seedDir, 'one-more.txt'), 'x');
  await git(seedDir, ['add', '.']);
  await git(seedDir, ['commit', '-m', 'just one more']);
  await git(seedDir, ['push', 'origin', 'main']);
  const smallStatus = await detector.computeAppUpdateStatus(null);
  assert.equal(smallStatus.incomingCommitsTruncated, false);
  await resyncApp();
});

test('unrelated local changes: a web-only update is available and web-only, with the changes left alone', async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(seedDir, 'web', 'src'), { recursive: true });
  await writeFile(path.join(seedDir, 'web', 'src', 'Unrelated.tsx'), 'export {}');
  await git(seedDir, ['add', '.']);
  await git(seedDir, ['commit', '-m', 'web-only change']);
  await git(seedDir, ['push', 'origin', 'main']);
  await writeFile(path.join(appDir, 'README.md'), 'local edit');
  await writeFile(path.join(appDir, 'generated.json'), '{}');

  const status = await detector.computeAppUpdateStatus(null);
  assert.equal(status.availability, 'available');
  assert.equal(status.classification, 'web-only');
  assert.equal(status.cantUpdateReason, null);
  assert.deepEqual(status.blockingFiles, []);

  await git(appDir, ['checkout', '--', 'README.md']);
  await rm(path.join(appDir, 'generated.json'));
  await resyncApp();
});

test('overlap: the status names the files without any absolute path, and the next check is available once the person moves the file away', async () => {
  await writeFile(path.join(seedDir, 'README.md'), 'remote overlap');
  await git(seedDir, ['commit', '-am', 'overlap']);
  await git(seedDir, ['push', 'origin', 'main']);
  await writeFile(path.join(appDir, 'README.md'), 'mine');

  const blocked = await detector.computeAppUpdateStatus(null);
  assert.equal(blocked.availability, 'cant-auto-update');
  assert.equal(blocked.classification, null);
  assert.equal(blocked.canApply, false);
  assert.equal(blocked.blockingFilesTotal, 1);
  assert.equal(JSON.stringify(blocked).includes(root), false, 'no absolute checkout path leaks into the status');

  await git(appDir, ['commit', '-am', 'keep my edit']);
  await git(appDir, ['reset', '--hard', 'origin/main']);
  const cleared = await detector.computeAppUpdateStatus(null);
  assert.equal(cleared.availability, 'up-to-date');
});

test('overlap does not change the ahead / diverged wording, and ahead wins over overlap', async () => {
  await writeFile(path.join(appDir, 'local.txt'), 'local commit');
  await git(appDir, ['add', '.']);
  await git(appDir, ['commit', '-m', 'local']);
  await writeFile(path.join(seedDir, 'README.md'), 'remote again');
  await git(seedDir, ['commit', '-am', 'remote']);
  await git(seedDir, ['push', 'origin', 'main']);
  await writeFile(path.join(appDir, 'README.md'), 'mine');

  const status = await detector.computeAppUpdateStatus(null);
  assert.match(status.cantUpdateReason ?? '', /has diverged from origin\/main/);
  assert.deepEqual(status.blockingFiles, []);

  await git(appDir, ['checkout', '--', 'README.md']);
  await git(appDir, ['reset', '--hard', 'origin/main']);
});

test('when the incoming paths cannot be read, a tracked change blocks with the reason; a clean tree is available as a server update', async () => {
  await writeFile(path.join(seedDir, 'README.md'), 'remote fallback');
  await git(seedDir, ['commit', '-am', 'fallback']);
  await git(seedDir, ['push', 'origin', 'main']);
  const deps = { incomingPaths: async () => { throw new Error('diff exploded'); } };

  const clean = await detector.computeAppUpdateStatus(null, deps);
  assert.equal(clean.availability, 'available');
  assert.equal(clean.classification, 'server');

  await writeFile(path.join(appDir, 'README.md'), 'mine');
  const dirty = await detector.computeAppUpdateStatus(null, deps);
  assert.equal(dirty.availability, 'cant-auto-update');
  assert.match(dirty.cantUpdateReason ?? '', /could not tell which files the update changes \(diff exploded\)/);

  await git(appDir, ['checkout', '--', 'README.md']);
  await resyncApp();
});

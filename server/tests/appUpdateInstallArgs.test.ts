import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { webInstallArgs } from '../src/appUpdate/realWebOnlySteps.ts';

// Both in-app update paths run npm from a daemon started with NODE_ENV=production, which makes a
// bare `npm install` omit AND prune devDependencies — taking `tsc` with it and breaking the web
// build. These guard the `--include=dev` that prevents it; no npm process is spawned here.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('web-only update installs web dependencies with devDependencies included', () => {
  assert.deepEqual(webInstallArgs('/app/web'), ['install', '--include=dev', '--prefix', '/app/web']);
});

test('install:all (used by prod:update and the server update path) includes devDependencies for both packages', async () => {
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const installs = manifest.scripts['install:all'].split('&&').map((command: string) => command.trim());
  assert.equal(installs.length, 2);
  for (const command of installs) assert.match(command, /^npm install --include=dev --prefix (server|web)$/);
});

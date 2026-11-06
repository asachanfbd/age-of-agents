import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/prod-start.sh');

test('prod-start.sh exits early with a clear message when server dependencies are not installed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'prod-start-'));
  try {
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(path.join(root, 'server'));
    cpSync(SCRIPT, path.join(root, 'scripts/prod-start.sh'));
    const result = spawnSync('bash', [path.join(root, 'scripts/prod-start.sh')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /better-sqlite3 is missing.*install:all/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

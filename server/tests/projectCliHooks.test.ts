import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cliHookReporterPath, ensureProjectCliHooks } from '../src/terminal/projectCliHooks.ts';

test('project CLI hooks are additive, local, and idempotent for Claude and Codex', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'project-cli-hooks-'));
  try {
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await writeFile(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] },
    }));

    await ensureProjectCliHooks(root);
    await ensureProjectCliHooks(root);

    const claude = JSON.parse(await readFile(path.join(root, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepEqual(claude.permissions, { allow: ['Read'] });
    assert.equal(claude.hooks.Stop.filter((entry: { hooks: { command?: string; args?: string[] }[] }) =>
      entry.hooks.some((hook) => hook.command === 'existing-hook')).length, 1);
    assert.equal(claude.hooks.Stop.filter((entry: { hooks: { command?: string; args?: string[] }[] }) =>
      entry.hooks.some((hook) => hook.args?.includes(cliHookReporterPath))).length, 1);
    assert.ok(claude.hooks.PermissionRequest);
    assert.ok(claude.hooks.Notification);

    const codex = JSON.parse(await readFile(path.join(root, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(codex.hooks.Stop.length, 1);
    assert.match(codex.hooks.Stop[0].hooks[0].command, /report-cli-hook\.mjs/);
    assert.ok(codex.hooks.PermissionRequest);
    assert.ok(codex.hooks.SessionEnd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an invalid existing settings file is preserved rather than overwritten', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'project-cli-hooks-invalid-'));
  const file = path.join(root, '.claude', 'settings.local.json');
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{not json');
    await assert.rejects(() => ensureProjectCliHooks(root), /not valid JSON/);
    assert.equal(await readFile(file, 'utf8'), '{not json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

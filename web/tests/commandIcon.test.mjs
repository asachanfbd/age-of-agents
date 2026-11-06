import assert from 'node:assert/strict';
import { test } from 'node:test';

const { commandIconKey } = await import('../src/lib/commandIcon.ts');

test('commandIconKey picks an icon family from the command name, case-insensitively', () => {
  assert.equal(commandIconKey('Build'), 'build');
  assert.equal(commandIconKey('Compile assets'), 'build');
  assert.equal(commandIconKey('Run tests'), 'test');
  assert.equal(commandIconKey('E2E'), 'test');
  assert.equal(commandIconKey('Lint'), 'lint');
  assert.equal(commandIconKey('Start dev server'), 'run');
  assert.equal(commandIconKey('Deploy'), 'generic');
  assert.equal(commandIconKey(''), 'generic');
});

test('commandIconKey prefers build over run when a name has both ("run build")', () => {
  assert.equal(commandIconKey('run build'), 'build');
  assert.equal(commandIconKey('run tests'), 'test');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatEnvText, parseEnvText } from '../src/lib/executorEnv.ts';

test('parseEnvText reads one KEY=value pair per line, trimming whitespace', () => {
  assert.deepEqual(parseEnvText('CLAUDE_CONFIG_DIR=/tmp/work\n  FOO = bar  '), {
    CLAUDE_CONFIG_DIR: '/tmp/work',
    FOO: 'bar',
  });
});

test('parseEnvText ignores blank lines and lines with no "="', () => {
  assert.deepEqual(parseEnvText('\n  \nKEY=value\nnot a pair\n'), { KEY: 'value' });
});

test('parseEnvText allows "=" inside the value itself', () => {
  assert.deepEqual(parseEnvText('CONNECTION=host=localhost;port=1'), { CONNECTION: 'host=localhost;port=1' });
});

test('parseEnvText drops a line with an empty key', () => {
  assert.deepEqual(parseEnvText('=no-key\nKEY=value'), { KEY: 'value' });
});

test('parseEnvText returns an empty object for blank input', () => {
  assert.deepEqual(parseEnvText(''), {});
  assert.deepEqual(parseEnvText('   \n  '), {});
});

test('formatEnvText renders one KEY=value per line', () => {
  assert.equal(formatEnvText({ CLAUDE_CONFIG_DIR: '/tmp/work', FOO: 'bar' }), 'CLAUDE_CONFIG_DIR=/tmp/work\nFOO=bar');
});

test('formatEnvText returns an empty string for an empty env map', () => {
  assert.equal(formatEnvText({}), '');
});

test('formatEnvText and parseEnvText round-trip', () => {
  const env = { A: '1', B: 'two' };
  assert.deepEqual(parseEnvText(formatEnvText(env)), env);
});

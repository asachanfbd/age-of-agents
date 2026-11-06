import assert from 'node:assert/strict';
import { test } from 'node:test';

const { highlightedLines, languageForPath } = await import('../src/lib/syntaxHighlight.ts');

test('languageForPath recognises common source extensions and special filenames', () => {
  assert.equal(languageForPath('web/src/App.tsx'), 'tsx');
  assert.equal(languageForPath('README.markdown'), 'markdown');
  assert.equal(languageForPath('config/.env'), 'bash');
  assert.equal(languageForPath('docker/Dockerfile'), 'docker');
  assert.equal(languageForPath('assets/photo.png'), undefined);
});

test('highlightedLines preserves source line count and balances multiline token spans', () => {
  const lines = highlightedLines('/* first\nsecond */\nconst ready = true;', 'javascript');

  assert.equal(lines.length, 3);
  assert.match(lines[0], /<span class="token comment">\/\* first<\/span>$/);
  assert.match(lines[1], /^<span class="token comment">second \*\/<\/span>$/);
  assert.match(lines[2], /<span class="token keyword">const<\/span>/);
  assert.match(lines[2], /<span class="token boolean">true<\/span>/);
});

test('highlightedLines safely escapes files without a known grammar and keeps trailing blank lines', () => {
  assert.deepEqual(highlightedLines('<script>alert("x")</script>\n'), [
    '&lt;script&gt;alert("x")&lt;/script&gt;',
    '',
  ]);
});

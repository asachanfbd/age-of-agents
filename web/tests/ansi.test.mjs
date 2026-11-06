import assert from 'node:assert/strict';
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

const { parseAnsi } = await import('../src/lib/ansi.ts');

const ESC = '\x1b';
const BEL = '\x07';

test('parseAnsi returns plain text as one unstyled segment when there are no escape codes', () => {
  assert.deepEqual(parseAnsi('hello world'), [{ text: 'hello world', style: {} }]);
});

test('parseAnsi returns an empty array for empty input', () => {
  assert.deepEqual(parseAnsi(''), []);
});

test('parseAnsi applies bold + a standard foreground color, and resets on 0', () => {
  const segments = parseAnsi(`plain ${ESC}[1;32mgreen bold${ESC}[0m plain again`);
  assert.deepEqual(segments, [
    { text: 'plain ', style: {} },
    { text: 'green bold', style: { fontWeight: 'bold', color: '#98c379' } },
    { text: ' plain again', style: {} },
  ]);
});

test('parseAnsi carries style across separate escape sequences (e.g. bold set, then color set separately)', () => {
  const segments = parseAnsi(`${ESC}[1m${ESC}[32mboth${ESC}[39m${ESC}[22m`);
  assert.deepEqual(segments, [{ text: 'both', style: { fontWeight: 'bold', color: '#98c379' } }]);
});

test('parseAnsi turning off just bold (22) or just color (39) leaves the other active style intact', () => {
  const segments = parseAnsi(`${ESC}[1;31mred-bold${ESC}[22mred-only${ESC}[39mplain`);
  assert.deepEqual(segments, [
    { text: 'red-bold', style: { fontWeight: 'bold', color: '#e06c75' } },
    { text: 'red-only', style: { color: '#e06c75' } },
    { text: 'plain', style: {} },
  ]);
});

test('parseAnsi supports bright (90-97) foreground and background (40-47 / 100-107) colors', () => {
  assert.deepEqual(parseAnsi(`${ESC}[93mbright yellow${ESC}[0m`), [{ text: 'bright yellow', style: { color: '#f0d089' } }]);
  assert.deepEqual(parseAnsi(`${ESC}[41mred bg${ESC}[0m`), [{ text: 'red bg', style: { backgroundColor: '#e06c75' } }]);
  assert.deepEqual(parseAnsi(`${ESC}[104mbright blue bg${ESC}[0m`), [{ text: 'bright blue bg', style: { backgroundColor: '#7fc1f5' } }]);
});

test('parseAnsi supports underline and strikethrough, combined and individually turned off', () => {
  assert.deepEqual(parseAnsi(`${ESC}[4munderline${ESC}[0m`), [{ text: 'underline', style: { textDecoration: 'underline' } }]);
  const both = parseAnsi(`${ESC}[4;9mboth${ESC}[24monly-strike`);
  assert.deepEqual(both, [
    { text: 'both', style: { textDecoration: 'underline line-through' } },
    { text: 'only-strike', style: { textDecoration: 'line-through' } },
  ]);
});

test('parseAnsi supports italic and dim (as reduced opacity)', () => {
  assert.deepEqual(parseAnsi(`${ESC}[3mitalic${ESC}[0m`), [{ text: 'italic', style: { fontStyle: 'italic' } }]);
  assert.deepEqual(parseAnsi(`${ESC}[2mdim${ESC}[0m`), [{ text: 'dim', style: { opacity: 0.7 } }]);
});

test('parseAnsi supports 256-color (38;5;N / 48;5;N) — base-16 index, 6x6x6 cube, and grayscale ramp', () => {
  assert.deepEqual(parseAnsi(`${ESC}[38;5;1mbase-16${ESC}[0m`), [{ text: 'base-16', style: { color: '#e06c75' } }]);
  assert.deepEqual(parseAnsi(`${ESC}[38;5;208morange${ESC}[0m`), [{ text: 'orange', style: { color: 'rgb(255, 135, 0)' } }]);
  assert.deepEqual(parseAnsi(`${ESC}[48;5;244mgray bg${ESC}[0m`), [{ text: 'gray bg', style: { backgroundColor: 'rgb(128, 128, 128)' } }]);
});

test('parseAnsi supports truecolor (38;2;R;G;B / 48;2;R;G;B)', () => {
  assert.deepEqual(parseAnsi(`${ESC}[38;2;10;20;30mfg${ESC}[0m`), [{ text: 'fg', style: { color: 'rgb(10, 20, 30)' } }]);
  assert.deepEqual(parseAnsi(`${ESC}[48;2;200;150;100mbg${ESC}[0m`), [{ text: 'bg', style: { backgroundColor: 'rgb(200, 150, 100)' } }]);
});

test('parseAnsi drops non-SGR CSI sequences (cursor moves, erase-line, ...) without leaking them as text', () => {
  // A progress bar repainting in place: erase-line, carriage-return-like cursor tricks, then new text.
  assert.deepEqual(parseAnsi(`${ESC}[2K${ESC}[1Aprogress: 100%`), [{ text: 'progress: 100%', style: {} }]);
});

test('parseAnsi drops OSC sequences (e.g. a shell setting the window title), terminated by BEL or ESC\\', () => {
  assert.deepEqual(parseAnsi(`${ESC}]0;My Title${BEL}after`), [{ text: 'after', style: {} }]);
  assert.deepEqual(parseAnsi(`${ESC}]0;My Title${ESC}\\after`), [{ text: 'after', style: {} }]);
});

test('parseAnsi safely drops an unterminated escape sequence at the end of the buffer instead of throwing', () => {
  assert.deepEqual(parseAnsi(`before${ESC}[1`), [{ text: 'before', style: {} }]);
  assert.deepEqual(parseAnsi(`before${ESC}`), [{ text: 'before', style: {} }]);
});

test('parseAnsi treats a lone ESC not followed by [ or ] as a dropped two-byte sequence (e.g. cursor save/restore)', () => {
  assert.deepEqual(parseAnsi(`a${ESC}7b`), [{ text: 'a', style: {} }, { text: 'b', style: {} }]);
});

test('parseAnsi real-world webpack-style output round-trips to the plain text with the right colors, no literal escape noise', () => {
  const raw = `asset ${ESC}[1m${ESC}[32mmain.js${ESC}[39m${ESC}[22m 80.1 KiB`;
  const segments = parseAnsi(raw);
  assert.equal(segments.map((s) => s.text).join(''), 'asset main.js 80.1 KiB');
  const styled = segments.find((s) => s.text === 'main.js');
  assert.deepEqual(styled.style, { fontWeight: 'bold', color: '#98c379' });
});

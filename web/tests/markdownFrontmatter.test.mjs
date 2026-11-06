import assert from 'node:assert/strict';
import { test } from 'node:test';

const { frontmatterValueText, splitFrontmatter } = await import('../src/lib/markdownFrontmatter.ts');

const text = (value) => ({ kind: 'text', text: value });

test('splits simple key/value frontmatter from the body', () => {
  const { frontmatter, body } = splitFrontmatter('---\nname: planner\ndescription: "Plans work: carefully"\n---\n# Title\n');
  assert.deepEqual(frontmatter, [
    { key: 'name', value: text('planner') },
    { key: 'description', value: text('Plans work: carefully') },
  ]);
  assert.equal(body, '# Title\n');
});

test('leaves content without frontmatter untouched', () => {
  const content = '# Just a doc\n\n---\nname: not frontmatter\n---\n';
  assert.deepEqual(splitFrontmatter(content), { frontmatter: null, body: content });
});

test('leaves a leading block that is not key/value YAML untouched', () => {
  const content = '---\nSome prose between rules\n---\nmore';
  assert.deepEqual(splitFrontmatter(content), { frontmatter: null, body: content });
});

test('leaves an empty or unterminated block untouched', () => {
  for (const content of ['---\n---\nbody', '---\nname: x\nbody without closing']) {
    assert.deepEqual(splitFrontmatter(content), { frontmatter: null, body: content });
  }
});

test('handles CRLF, a BOM, the ... terminator and a document with no body', () => {
  assert.deepEqual(splitFrontmatter('﻿---\r\ntitle: A\r\n---\r\nBody'), { frontmatter: [{ key: 'title', value: text('A') }], body: 'Body' });
  assert.deepEqual(splitFrontmatter('---\ntitle: A\n...'), { frontmatter: [{ key: 'title', value: text('A') }], body: '' });
});

test('parses block and inline lists, including flush list items', () => {
  const { frontmatter } = splitFrontmatter('---\ntags:\n  - one\n  - "two"\nflush:\n- a\n- b\ninline: [x, \'y\', ]\nempty: []\n---\n');
  assert.deepEqual(frontmatter, [
    { key: 'tags', value: { kind: 'list', items: [text('one'), text('two')] } },
    { key: 'flush', value: { kind: 'list', items: [text('a'), text('b')] } },
    { key: 'inline', value: { kind: 'list', items: [text('x'), text('y')] } },
    { key: 'empty', value: { kind: 'list', items: [] } },
  ]);
});

test('parses nested maps and lists of maps', () => {
  const { frontmatter } = splitFrontmatter('---\nmetadata:\n  type: project\n  owner:\n    name: Sam\npeople:\n  - name: A\n    role: dev\n  -\n  - key:\n---\n');
  assert.deepEqual(frontmatter, [
    { key: 'metadata', value: { kind: 'map', entries: [
      { key: 'type', value: text('project') },
      { key: 'owner', value: { kind: 'map', entries: [{ key: 'name', value: text('Sam') }] } },
    ] } },
    { key: 'people', value: { kind: 'list', items: [
      { kind: 'map', entries: [{ key: 'name', value: text('A') }, { key: 'role', value: text('dev') }] },
      text(''),
      { kind: 'map', entries: [{ key: 'key', value: text('') }] },
    ] } },
  ]);
});

test('parses literal and folded block scalars', () => {
  const { frontmatter } = splitFrontmatter('---\nliteral: |\n  line one\n    indented\n\nfolded: >-\n  first\n  second\n\n  third\n---\n');
  assert.deepEqual(frontmatter, [
    { key: 'literal', value: text('line one\n  indented') },
    { key: 'folded', value: text('first second\nthird') },
  ]);
});

test('skips comments, strips trailing comments, keeps # inside quotes, and unquotes keys', () => {
  const { frontmatter } = splitFrontmatter('---\n# heading comment\ncolor: red # trailing\nhash: "#fff"\nsingle: \'it\'\'s\'\nescaped: "say \\"hi\\""\n"quoted key": v\n---\n');
  assert.deepEqual(frontmatter, [
    { key: 'color', value: text('red') },
    { key: 'hash', value: text('#fff') },
    { key: 'single', value: text("it's") },
    { key: 'escaped', value: text('say "hi"') },
    { key: 'quoted key', value: text('v') },
  ]);
});

test('joins multi-line plain scalars and keeps URLs intact', () => {
  const { frontmatter } = splitFrontmatter('---\nsummary: a long\n  wrapped value\nurl: https://example.com/a#b\nblank:\n---\n');
  assert.deepEqual(frontmatter, [
    { key: 'summary', value: text('a long wrapped value') },
    { key: 'url', value: text('https://example.com/a#b') },
    { key: 'blank', value: text('') },
  ]);
});

test('falls back to text when nested content is not readable YAML', () => {
  const { frontmatter } = splitFrontmatter('---\nnotes:\n  just some words\n  more words\nlist:\n  - a\n  stray\n---\n');
  assert.deepEqual(frontmatter, [
    { key: 'notes', value: text('just some words more words') },
    { key: 'list', value: text('- a\nstray') },
  ]);
});

const valueOf = (yaml, key) => splitFrontmatter(`---\n${yaml}\n---\n`).frontmatter.find((entry) => entry.key === key).value;

test('copy text of a plain or block value is the value itself', () => {
  assert.equal(frontmatterValueText(valueOf('name: planner', 'name')), 'planner');
  assert.equal(frontmatterValueText(valueOf('notes: |\n  one\n  two', 'notes')), 'one\ntwo');
});

test('copy text of lists and maps is YAML that parses back to the same value', () => {
  const yaml = [
    'meta:',
    '  type: project',
    '  body: |',
    '    line one',
    '    line two',
    '  none: []',
    '  blank:',
    '  owner:',
    '    name: Sam',
    '  tags:',
    '    - a',
    '    - name: A',
    '      role: dev',
    '    -',
  ].join('\n');
  const value = valueOf(yaml, 'meta');
  const copied = frontmatterValueText(value);
  assert.equal(copied, [
    'type: project',
    'body: |',
    '  line one',
    '  line two',
    'none: []',
    'blank:',
    'owner:',
    '  name: Sam',
    'tags:',
    '  - a',
    '  - name: A',
    '    role: dev',
    '  -',
  ].join('\n'));
  assert.deepEqual(valueOf(`meta:\n${copied.split('\n').map((line) => `  ${line}`).join('\n')}`, 'meta'), value);
});

test('copy text of an empty nested map is {}', () => {
  assert.equal(frontmatterValueText({ kind: 'map', entries: [{ key: 'x', value: { kind: 'map', entries: [] } }] }), 'x: {}');
});

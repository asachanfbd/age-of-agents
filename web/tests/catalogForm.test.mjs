import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  slugify,
  parseTriggers,
  formatTriggers,
  isValidCatalogId,
  buildCreateCatalogAgentInput,
  buildUpdateCatalogAgentPatch,
  buildCreateCatalogSkillInput,
  buildUpdateCatalogSkillPatch,
} from '../src/lib/catalogForm.ts';

test('slugify lowercases and dashes a display name', () => {
  assert.equal(slugify('Code Reviewer'), 'code-reviewer');
});

test('slugify collapses runs of non-alphanumeric characters into a single dash', () => {
  assert.equal(slugify('Roadmap  Runner!!  v2'), 'roadmap-runner-v2');
});

test('slugify trims leading/trailing punctuation and whitespace', () => {
  assert.equal(slugify('  --Builder--  '), 'builder');
});

test('slugify drops non-ASCII letters rather than transliterating them', () => {
  assert.equal(slugify('Über Cool'), 'ber-cool');
});

test('slugify returns an empty string when nothing alphanumeric remains', () => {
  assert.equal(slugify('!!!'), '');
  assert.equal(slugify(''), '');
});

test('parseTriggers reads one trigger per line', () => {
  assert.deepEqual(parseTriggers('deploy\nship it\nrelease'), ['deploy', 'ship it', 'release']);
});

test('parseTriggers accepts comma-separated triggers on one line', () => {
  assert.deepEqual(parseTriggers('deploy, ship it,release'), ['deploy', 'ship it', 'release']);
});

test('parseTriggers trims whitespace and drops empty entries from mixed separators', () => {
  assert.deepEqual(parseTriggers('deploy,\n  ship it \n\n,release,'), ['deploy', 'ship it', 'release']);
});

test('parseTriggers returns undefined for blank input rather than an empty array', () => {
  assert.equal(parseTriggers(''), undefined);
  assert.equal(parseTriggers('   \n , ,'), undefined);
});

test('formatTriggers joins triggers one per line', () => {
  assert.equal(formatTriggers(['deploy', 'ship it']), 'deploy\nship it');
});

test('formatTriggers returns an empty string for undefined or an empty array', () => {
  assert.equal(formatTriggers(undefined), '');
  assert.equal(formatTriggers([]), '');
});

test('parseTriggers and formatTriggers round-trip one-per-line input', () => {
  const triggers = ['a', 'b', 'c'];
  assert.deepEqual(parseTriggers(formatTriggers(triggers)), triggers);
});

// ---- isValidCatalogId ----

test('isValidCatalogId accepts a letter-led slug with dashes and underscores', () => {
  assert.equal(isValidCatalogId('code-reviewer_v2'), true);
});

test('isValidCatalogId accepts a digit-led id', () => {
  assert.equal(isValidCatalogId('007-agent'), true);
});

test('isValidCatalogId rejects an empty string', () => {
  assert.equal(isValidCatalogId(''), false);
  assert.equal(isValidCatalogId('   '), false);
});

test('isValidCatalogId rejects a leading dash or underscore', () => {
  assert.equal(isValidCatalogId('-reviewer'), false);
  assert.equal(isValidCatalogId('_reviewer'), false);
});

test('isValidCatalogId rejects spaces, dots, and slashes', () => {
  assert.equal(isValidCatalogId('code reviewer'), false);
  assert.equal(isValidCatalogId('code.reviewer'), false);
  assert.equal(isValidCatalogId('code/reviewer'), false);
});

test('isValidCatalogId trims surrounding whitespace before checking', () => {
  assert.equal(isValidCatalogId('  reviewer  '), true);
});

// ---- buildCreateCatalogAgentInput / buildUpdateCatalogAgentPatch ----

const baseAgentFields = { name: 'Reviewer', description: 'Reviews code', avatar: '', manager: false, defaultAutonomy: 'auto', body: '' };

test('buildCreateCatalogAgentInput trims id/name/description and omits blank optionals', () => {
  const input = buildCreateCatalogAgentInput('  reviewer  ', { ...baseAgentFields, name: '  Reviewer  ', description: '  Reviews code  ' });
  assert.deepEqual(input, { id: 'reviewer', name: 'Reviewer', description: 'Reviews code', manager: false, defaultAutonomy: 'auto' });
  assert.ok(!('avatar' in input));
  assert.ok(!('body' in input));
});

test('buildCreateCatalogAgentInput includes avatar/body when provided, and manager/defaultAutonomy as given', () => {
  const input = buildCreateCatalogAgentInput('manager-bot', {
    ...baseAgentFields,
    avatar: '🤖',
    manager: true,
    defaultAutonomy: 'approval',
    body: 'You are a manager.',
  });
  assert.deepEqual(input, {
    id: 'manager-bot',
    name: 'Reviewer',
    description: 'Reviews code',
    manager: true,
    defaultAutonomy: 'approval',
    avatar: '🤖',
    body: 'You are a manager.',
  });
});

test('buildUpdateCatalogAgentPatch omits description/body when left blank', () => {
  const patch = buildUpdateCatalogAgentPatch({ ...baseAgentFields, description: '', body: '   ' });
  assert.deepEqual(patch, { name: 'Reviewer', manager: false, defaultAutonomy: 'auto' });
  assert.ok(!('description' in patch));
  assert.ok(!('body' in patch));
  assert.ok(!('avatar' in patch));
});

test('buildUpdateCatalogAgentPatch includes description/body/avatar when the user typed something', () => {
  const patch = buildUpdateCatalogAgentPatch({
    ...baseAgentFields,
    description: 'Updated description',
    avatar: '✨',
    body: 'Updated persona body.',
  });
  assert.deepEqual(patch, {
    name: 'Reviewer',
    manager: false,
    defaultAutonomy: 'auto',
    avatar: '✨',
    description: 'Updated description',
    body: 'Updated persona body.',
  });
});

// ---- buildCreateCatalogSkillInput / buildUpdateCatalogSkillPatch ----

const baseSkillFields = { name: 'Deployer', description: 'Deploys the app', avatar: '', triggersText: '', body: '' };

test('buildCreateCatalogSkillInput trims id/name/description and omits blank optionals', () => {
  const input = buildCreateCatalogSkillInput('  deployer  ', baseSkillFields);
  assert.deepEqual(input, { id: 'deployer', name: 'Deployer', description: 'Deploys the app' });
  assert.ok(!('avatar' in input));
  assert.ok(!('body' in input));
  assert.ok(!('triggers' in input));
});

test('buildCreateCatalogSkillInput includes avatar/body/triggers when provided', () => {
  const input = buildCreateCatalogSkillInput('deployer', {
    ...baseSkillFields,
    avatar: '🚀',
    triggersText: 'deploy\nship it',
    body: '# Steps',
  });
  assert.deepEqual(input, {
    id: 'deployer',
    name: 'Deployer',
    description: 'Deploys the app',
    avatar: '🚀',
    body: '# Steps',
    triggers: ['deploy', 'ship it'],
  });
});

test('buildUpdateCatalogSkillPatch always sends name/description/triggers (known from the read shape)', () => {
  const patch = buildUpdateCatalogSkillPatch(baseSkillFields);
  assert.deepEqual(patch, { name: 'Deployer', description: 'Deploys the app', triggers: undefined });
  assert.ok(!('avatar' in patch));
  assert.ok(!('body' in patch));
});

test('buildUpdateCatalogSkillPatch includes avatar/body when the user typed something, and parses triggers', () => {
  const patch = buildUpdateCatalogSkillPatch({
    ...baseSkillFields,
    avatar: '🚀',
    triggersText: 'deploy, ship it',
    body: 'Updated body.',
  });
  assert.deepEqual(patch, {
    name: 'Deployer',
    description: 'Deploys the app',
    triggers: ['deploy', 'ship it'],
    avatar: '🚀',
    body: 'Updated body.',
  });
});

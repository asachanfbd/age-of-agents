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

const { BUILDING_STATUS_STYLES, buildingVisualStatus, describeAttention } = await import('../src/lib/buildingVisualStatus.ts');
const { describeSync } = await import('../src/lib/gitSync.ts');
const task = (status) => ({ status });

test('maps each building attention state to its visual dot state', () => {
  assert.equal(buildingVisualStatus('idle', undefined, false), 'idle');
  assert.equal(buildingVisualStatus('developing', undefined, false), 'developing');
  assert.equal(buildingVisualStatus('blocked', task('blocked'), false), 'question');
  assert.equal(buildingVisualStatus('idle', task('done'), false), 'completed');
  assert.equal(buildingVisualStatus('idle', task('failed'), false), 'error');
});

test('a reviewed completion returns to idle', () => {
  assert.equal(buildingVisualStatus('idle', task('done'), true), 'idle');
});

test('a dismissed failure returns to idle', () => {
  assert.equal(buildingVisualStatus('idle', task('failed'), true), 'idle');
});

test('an intentionally stopped task is neutral, not an error', () => {
  assert.equal(buildingVisualStatus('idle', task('stopped'), false), 'idle');
});

test('active project state wins over a previous settled task', () => {
  assert.equal(buildingVisualStatus('developing', task('failed'), false), 'developing');
  assert.equal(buildingVisualStatus('blocked', task('failed'), false), 'question');
});

test('an out-of-sync branch shows the same red error state as a failed task', () => {
  assert.equal(buildingVisualStatus('idle', undefined, false, true), 'error');
  assert.equal(buildingVisualStatus('idle', task('done'), true, true), 'error', 'stays visible even once the last task was reviewed');
});

test('active project state and blocked still win over an out-of-sync branch', () => {
  assert.equal(buildingVisualStatus('developing', undefined, false, true), 'developing');
  assert.equal(buildingVisualStatus('blocked', undefined, false, true), 'question');
});

test('outOfSync defaults to false for existing callers', () => {
  assert.equal(buildingVisualStatus('idle', undefined, false), 'idle');
});

test('describeAttention explains a failed latest task', () => {
  const failed = { status: 'failed', failureReason: 'Tests failed' };
  assert.equal(describeAttention('error', failed, false, null), 'Latest task failed: Tests failed');
});

test('describeAttention explains a failed task with no reason given', () => {
  const failed = { status: 'failed', failureReason: null };
  assert.equal(describeAttention('error', failed, false, null), 'Latest task failed');
});

test('describeAttention explains an out-of-sync branch via describeSync', () => {
  const sync = { status: 'behind', branch: 'main', behindBy: 2, aheadBy: 0 };
  assert.equal(describeAttention('error', undefined, true, sync), describeSync(sync));
});

test('describeAttention combines both reasons when both apply', () => {
  const failed = { status: 'failed', failureReason: 'Build broke' };
  const sync = { status: 'diverged', branch: 'main', behindBy: 1, aheadBy: 3 };
  const message = describeAttention('error', failed, true, sync);
  assert.match(message, /Build broke/);
  assert.match(message, /Diverged/);
});

test('describeAttention returns null for any non-error, non-notice visual status', () => {
  assert.equal(describeAttention('idle', undefined, false, null), null);
  assert.equal(describeAttention('developing', undefined, false, null), null);
  assert.equal(describeAttention('question', undefined, false, null), null);
  assert.equal(describeAttention('completed', { status: 'done' }, false, null), null);
});

// --- Notification severity folding into the dot (milestone-5-notification-system.md's "Dot precedence" open question) ---

const notification = (severity, overrides = {}) => ({
  id: 'n1',
  kind: 'task.failed',
  severity,
  subject: { type: 'task', projectId: 'p1', conversationId: 'conv-1', taskId: 'task-1' },
  projectId: 'p1',
  title: 'Task failed twice',
  description: 'Retried automatically and failed again.',
  readAt: null,
  resolvedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

test('a critical notification overrides an otherwise-idle or completed building', () => {
  assert.equal(buildingVisualStatus('idle', undefined, false, false, 'critical'), 'error');
  assert.equal(buildingVisualStatus('idle', task('done'), false, false, 'critical'), 'error');
});

test('a critical notification does not override blocked or developing', () => {
  assert.equal(buildingVisualStatus('blocked', undefined, false, false, 'critical'), 'question');
  assert.equal(buildingVisualStatus('developing', undefined, false, false, 'critical'), 'developing');
});

test('warning/info notifications surface as a distinct notice tier, not plain idle', () => {
  assert.equal(buildingVisualStatus('idle', undefined, false, false, 'warning'), 'notice');
  assert.equal(buildingVisualStatus('idle', undefined, false, false, 'info'), 'notice');
});

test('warning/info notifications do not override blocked, developing, error, or completed', () => {
  assert.equal(buildingVisualStatus('blocked', undefined, false, false, 'warning'), 'question');
  assert.equal(buildingVisualStatus('developing', undefined, false, false, 'info'), 'developing');
  assert.equal(buildingVisualStatus('idle', task('failed'), false, false, 'warning'), 'error');
  assert.equal(buildingVisualStatus('idle', task('done'), false, false, 'info'), 'completed');
});

test('no open notification (the default) behaves exactly as it did before notifications existed', () => {
  assert.equal(buildingVisualStatus('idle', undefined, false), 'idle');
  assert.equal(buildingVisualStatus('idle', undefined, false, false, null), 'idle');
  assert.equal(buildingVisualStatus('developing', task('failed'), false, true, null), 'developing');
});

test('describeAttention explains a critical notification alongside a failed task and out-of-sync branch', () => {
  const failed = { status: 'failed', failureReason: 'Build broke' };
  const n = notification('critical');
  const message = describeAttention('error', failed, true, { status: 'diverged', branch: 'main', behindBy: 1, aheadBy: 3 }, n);
  assert.match(message, /Build broke/);
  assert.match(message, /Diverged/);
  assert.match(message, /Task failed twice: Retried automatically and failed again\./);
});

test('describeAttention explains the notice tier from its notification title/description', () => {
  const n = notification('warning');
  assert.equal(describeAttention('notice', undefined, false, null, n), 'Task failed twice: Retried automatically and failed again.');
});

test('describeAttention falls back to just the title when a notification has no description', () => {
  const n = notification('warning', { description: '' });
  assert.equal(describeAttention('notice', undefined, false, null, n), 'Task failed twice');
});

test('describeAttention returns null for the notice tier if no notification was actually passed (defensive)', () => {
  assert.equal(describeAttention('notice', undefined, false, null), null);
});

test('every visual status has a dot style, and only idle stays unlit', () => {
  const states = ['idle', 'developing', 'completed', 'question', 'error', 'notice'];
  assert.deepEqual(Object.keys(BUILDING_STATUS_STYLES).sort(), [...states].sort());
  for (const state of states) {
    const style = BUILDING_STATUS_STYLES[state];
    assert.match(style.dotColor, /^#[0-9a-f]{6}$/);
    assert.ok(style.accessibleLabel.length > 0);
    assert.equal(style.glowing, state !== 'idle');
  }
});

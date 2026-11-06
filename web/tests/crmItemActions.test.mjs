import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const { isMessageType, canMarkDone } = await import('../src/lib/crmCalendar.ts');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

test('isMessageType is true only for message, email and dm', () => {
  for (const t of ['message', 'email', 'dm']) assert.equal(isMessageType(t), true, t);
  for (const t of ['call', 'online_meeting', 'in_person_meeting', 'appointment', 'other', '', 'sms']) assert.equal(isMessageType(t), false, t);
});

test('canMarkDone accepts open non-message items only', () => {
  for (const type of ['call', 'other', 'online_meeting', 'in_person_meeting', 'appointment']) {
    for (const state of ['planned', 'pending', 'approved']) assert.equal(canMarkDone({ type, state }), true, `${type} ${state}`);
    for (const state of ['failed', 'done', 'sent', 'cancelled']) assert.equal(canMarkDone({ type, state }), false, `${type} ${state}`);
  }
  for (const type of ['message', 'email', 'dm']) assert.equal(canMarkDone({ type, state: 'pending' }), false, type);
});

test('the contact panel offers Mark done and Notes for non-message items and keeps the message actions for message items', () => {
  const panel = src('ui/crm/ContactPanel.tsx');
  assert.match(panel, /isMessageType\(f\.type\)/);
  assert.match(panel, /canMarkDone\(f\)/);
  assert.match(panel, /crmApi\.complete\(projectId, f\.id\)/);
  assert.match(panel, /Mark done/);
  assert.match(panel, /<MomDialog/);
  assert.match(panel, /Pending reachout/);
  assert.ok(panel.indexOf('isMessageType(f.type)') < panel.indexOf('Pending reachout'), 'Pending reachout sits inside the message branch');
});

test('the Calendar card and Expand Today use the shared helpers, and NOTE_TYPES is gone', () => {
  const cal = src('ui/crm/CalendarTab.tsx'), expand = src('ui/crm/ExpandToday.tsx');
  assert.match(cal, /isMessageType\(item\.type\) && item\.state === 'pending'/);
  assert.match(cal, /canMarkDone\(item\)/);
  assert.match(cal, /crmApi\.complete\(project\.id, item\.id\)/);
  assert.match(cal, /<MomDialog/);
  assert.match(expand, /current\.group === 'overdue' && canMarkDone\(item\)/);
  assert.match(expand, /crmApi\.complete\(projectId, item\.id\)/);
  assert.match(expand, /isMessageType\(item\.type\) && <p[^>]*>\{item\.message \?\? 'No message'\}/);
  assert.match(expand, /isMessageType\(item\.type\) && \(current\.group === 'overdue'/);
  for (const f of ['ui/crm/CalendarTab.tsx', 'ui/crm/ExpandToday.tsx', 'ui/crm/ContactPanel.tsx']) assert.doesNotMatch(src(f), /NOTE_TYPES/);
});

test('the Prospects pending flag opens the popup for a message item, not a call', () => {
  assert.match(src('ui/crm/ProspectsTab.tsx'), /rows\.find\(\(row\) => isMessageType\(row\.type\)\)/);
});

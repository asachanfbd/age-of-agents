import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../../templates/notifications-drawer.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];

/** Runs the template's inline script against a minimal fake DOM and returns handles to drive it. */
function loadTemplate() {
  const elements = new Map();
  const fake = (id) => {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, {
        id, dataset: {}, hidden: false, textContent: '', innerHTML: '', disabled: false,
        addEventListener: (type, fn) => { handlers[type] = fn; },
        fire: (type, event = {}) => handlers[type]?.(event),
        setAttribute() {}, focus() {}, querySelector: () => fake('focus-target'),
      });
    }
    return elements.get(id);
  };
  const tabs = ['unread', 'read'].map((name) => ({ ...fake(`tab-${name}`), dataset: { tab: name } }));
  tabs.forEach((tab) => elements.set(tab.id, tab));
  const counts = ['unread', 'read'].map((name) => ({ dataset: { tabCount: name }, textContent: '' }));
  const selects = ['status', 'severity', 'project'].map((name) => {
    const select = fake(`filter-${name}`);
    select.dataset.filter = name;
    return select;
  });
  const groups = { '[data-tab]': tabs, '[data-tab-count]': counts, '[data-filter]': selects };

  const sandbox = {
    document: {
      getElementById: fake,
      querySelectorAll: (selector) => groups[selector] ?? [],
      querySelector: () => null,
      addEventListener() {},
      documentElement: { classList: { toggle: () => true } },
    },
    localStorage: { setItem() {} },
    lucide: { createIcons() {} },
    setTimeout: () => 0,
    clearTimeout() {},
  };
  vm.runInNewContext(`${script}\n;__t = { state, NOTIFICATIONS, PAGE_SIZE };`, sandbox);

  const list = fake('notification-list');
  const rows = () => [...list.innerHTML.matchAll(/data-open="(\d+)"/g)].map((m) => Number(m[1]));
  const click = (target) => list.fire('click', { target: { closest: (selector) => target[selector] ?? null } });
  return {
    ...sandbox.__t,
    fake, tabs, counts, selects, rows,
    toggleDot: (id) => click({ '[data-toggle]': { dataset: { toggle: String(id) } } }),
    openRow: (id) => click({ '[data-open]': { dataset: { open: String(id) } } }),
    switchTab: (name) => tabs.find((t) => t.dataset.tab === name).fire('click'),
    filter: (name, value) => { const s = selects.find((x) => x.dataset.filter === name); s.value = value; s.fire('change'); },
  };
}

test('each tab shows 10 rows first and offers Load more with what remains', () => {
  const t = loadTemplate();
  assert.equal(t.rows().length, 10);
  assert.equal(t.fake('load-more-wrap').hidden, false);
  assert.match(t.fake('load-more').textContent, /10 of 10 remaining/);

  t.switchTab('read');
  assert.equal(t.rows().length, 10);
  assert.match(t.fake('load-more').textContent, /2 of 2 remaining/);
});

test('Load more reveals the next page and then disappears', () => {
  const t = loadTemplate();
  t.fake('load-more').fire('click');
  assert.equal(t.rows().length, 20);
  assert.equal(t.fake('load-more-wrap').hidden, true);
});

test('tab badges count unread and read notifications', () => {
  const t = loadTemplate();
  assert.deepEqual(t.counts.map((c) => c.textContent), [20, 12]);
});

test('the dot toggles read status but the notification stays in its tab until the drawer reopens', () => {
  const t = loadTemplate();
  const [first] = t.rows();
  const notification = t.NOTIFICATIONS.find((n) => n.id === first);
  t.toggleDot(first);

  assert.equal(notification.read, true);
  assert.ok(t.rows().includes(first), 'still listed under Unread');
  assert.match(t.fake('notification-list').innerHTML, /Mark as unread/);
  assert.deepEqual(t.counts.map((c) => c.textContent), [20, 12]);

  t.fake('drawer-open').fire('click');
  assert.ok(!t.rows().includes(first), 'leaves Unread on the next open');
  assert.deepEqual(t.counts.map((c) => c.textContent), [19, 13]);
  t.switchTab('read');
  assert.ok(t.rows().includes(first), 'and is listed under Read');
});

test('un-reading a read notification also waits for the next open', () => {
  const t = loadTemplate();
  t.switchTab('read');
  const [first] = t.rows();
  t.toggleDot(first);
  assert.ok(t.rows().includes(first));

  t.fake('drawer-open').fire('click');
  assert.ok(!t.rows().includes(first));
});

test('clicking a notification marks it read, closes the drawer and opens its target', () => {
  const t = loadTemplate();
  const first = t.rows()[0];
  const notification = t.NOTIFICATIONS.find((n) => n.id === first);
  t.openRow(first);

  assert.equal(notification.read, true);
  assert.equal(t.fake('drawer').dataset.state, 'closed');
  assert.match(t.fake('last-opened').textContent, new RegExp(notification.target.label));
});

test('every target type is represented in the sample data', () => {
  const t = loadTemplate();
  const types = new Set(t.NOTIFICATIONS.map((n) => n.target.type));
  assert.deepEqual([...types].sort(), ['agent', 'city', 'planning', 'project', 'skill', 'task']);
});

test('Mark all as read only affects notifications matching the filters', () => {
  const t = loadTemplate();
  t.filter('severity', 'critical');
  const criticalUnread = t.NOTIFICATIONS.filter((n) => n.severity === 'critical' && !n.read).length;
  assert.ok(criticalUnread > 0);
  t.fake('mark-all').fire('click');

  assert.equal(t.NOTIFICATIONS.filter((n) => n.severity === 'critical' && !n.read).length, 0);
  assert.equal(t.NOTIFICATIONS.filter((n) => !n.read).length, 20 - criticalUnread);
  assert.equal(t.fake('mark-all').disabled, true);
  assert.equal(t.rows().length > 0, true, 'rows stay in place until the drawer reopens');
});

test('changing a filter resets pagination and shows an empty state when nothing matches', () => {
  const t = loadTemplate();
  t.fake('load-more').fire('click');
  t.filter('project', 'agent-visual-os');
  assert.equal(t.state.visible.unread, t.PAGE_SIZE);

  t.filter('status', 'dismissed');
  t.filter('severity', 'critical');
  assert.equal(t.rows().length, 0);
  assert.equal(t.fake('empty-state').hidden, false);
});

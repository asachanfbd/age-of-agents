/**
 * A minimal in-memory stand-in for agent-visual-os's daemon HTTP API, used to
 * test the store's server-backed actions without a real server/ process or
 * network call — see CLAUDE.md's test-isolation guidance (applied here to
 * the frontend's one external dependency, the daemon, rather than a
 * database).
 */
import { PROJECT_PLOTS } from '../src/scene/townLayout.ts';
import { seoBacklinksRoute } from './seoBacklinksStub.mjs';
import { seoKeywordsRoute } from './seoKeywordsStub.mjs';
import { seoReportsRoute } from './seoReportsStub.mjs';
import { seoLinksRoute } from './seoInternalLinksStub.mjs';
import { contentStudioRoute, createContentStudioState } from './contentStudioStub.mjs';

const PLAN_DOC_DEFS = [
  { key: 'specifications', title: 'Specifications' },
  { key: 'requirements', title: 'Requirements' },
  { key: 'testCases', title: 'Test Cases' },
  { key: 'e2eTesting', title: 'End-to-End Testing' },
  { key: 'performanceTesting', title: 'Performance Testing' },
];

/** Mirrors server/src/projects/townPlots.ts: the 240 project plots a PATCH position must land on exactly. */
const STUB_PROJECT_PLOTS = PROJECT_PLOTS.map((plot) => [plot.x, plot.z]);
const nearPlot = (a, b) => Math.abs(a[0] - b[0]) < 0.001 && Math.abs(a[1] - b[1]) < 0.001;

/** Mirrors server/src/executors/executorService.ts's id generation for the settings-panel stub below. */
function slugify(label) {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'executor';
}

function uniqueId(base, existingIds) {
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** Mirrors server/src/catalog/skillInstall.ts's REPO_SLUG_PATTERN — a plain "owner/repo" GitHub slug. */
const REPO_SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** What a testing setup's approval leaves the project with — one suite, enough for a smoke test to then run and see in history. Mirrors docs/testing-contract.md's shape, not a real framework's. */
const TESTING_CONFIG_PATH = '.docs/testing/config.json';
const DEFAULT_TESTING_CONFIG = {
  schemaVersion: 1,
  suites: [{
    id: 'unit',
    label: 'Unit tests',
    kind: 'unit',
    enabled: true,
    primaryActionId: 'run',
    actions: [{ id: 'run', label: 'Run unit tests', purpose: 'result', command: 'npm test', workingDirectory: '.', enabled: true, collectors: [] }],
    metrics: [],
  }],
};
/** Mirrors server/src/testing/setup.ts's built-in testing-setup workflow: a read-only proposal gate, then implementation. */
const TESTING_SETUP_STEPS = [
  { id: 'proposal', name: 'Propose setup', canEditCode: false, requiresApproval: true },
  { id: 'implementation', name: 'Implement setup', canEditCode: true, requiresApproval: false },
];

export function installServerStub() {
  const projects = new Map();
  const githubAccounts = {
    gh: { state: 'ok', version: '2.45.0' },
    addCommand: 'gh auth login -h github.com',
    minGhVersion: '2.40.0',
    accounts: ['personal', 'acme-hr'].map((login, index) => ({
      login, name: null, active: index === 0, signedIn: true, hasCustomIdentity: false, usedByProjects: 0,
      identity: { name: login, email: `${login}@users.noreply.github.com` },
    })),
  };
  const githubAccountChecks = new Map();
  /** The SEO Building's Connections and Data routes (server/src/api/seoRoutes.ts), with the requests the web sent. */
  const content = createContentStudioState();
  const seo = { byProject: new Map(), requests: [], pagesGate: null, sitemapsBusy: false, submitRefused: false, log: [] };
  /** The app-wide Google OAuth client (Settings > Google (SEO)); `fail` makes the next request answer with that status. */
  const googleClient = { saved: false, requests: [], fail: null };
  const seoView = (id) => {
    const st = seo.byProject.get(id);
    const connection = (service) => ({ service, state: service === 'gsc' && st.property ? (st.syncing ? 'syncing' : 'connected') : 'not-connected', property: service === 'gsc' ? st.property ?? undefined : undefined, progress: service === 'gsc' && st.syncing ? { done: 5, total: 10 } : undefined });
    return { siteUrl: st.siteUrl, googleClientSaved: googleClient.saved, adsDeveloperTokenSaved: false, bingKeySaved: false, indexNowKeySaved: false, connections: ['gsc', 'ga4', 'ads', 'bing', 'indexnow'].map(connection), previousProperties: st.previous ?? [], keywordMarket: st.kw?.market ?? null };
  };
  /** Building Types: the registered types, per-type slot configuration, and (per Building) bulk rows, storage status and the list requests the web sent. */
  const buildings = {
    types: [
      { id: 'software', name: 'Software', description: 'Build and fix software in a Git repository.', category: 'Engineering', version: 1, repository: true, look: { model: 'software', color: '#7295ad' }, workspace: 'software', devOnly: false, hasStorage: false, slots: [{ id: 'feature', label: 'Build a feature or change', usedWhen: 'A Task is started on a planned feature.', defaultWorkflowId: 'software-development' }], agents: [], tables: [], rollups: [] },
      { id: 'notes', name: 'Notes', description: 'Developer skeleton type.', category: 'Developer', version: 1, repository: false, look: { model: 'generic', color: '#e0a030' }, workspace: 'notes', devOnly: true, hasStorage: true, slots: [], agents: [], tables: [], rollups: [] },
    ],
    configs: new Map(), rows: new Map(), storage: new Map(), dataRequests: [],
  };
  /**
   * The Schedules area — mirrors server/src/scheduler for the routes the store calls. Per Building: its timezone, its
   * jobs and each job's history (newest first). `declared` holds a type's default jobs by type id. A run started here
   * stays "running" until a test settles it with `settleRun`; `failStart` (a reason) makes the next start fail at set-up. The real cron arithmetic lives in the daemon and is
   * tested there; here the next run of any schedule is 09:00 the next day in the Building's timezone.
   */
  const schedules = { hostTimezone: 'UTC', byProject: new Map(), declared: new Map(), requests: [], now: '2026-10-11T05:50:00.000Z', failStart: null };
  const scheduleState = (projectId) => {
    if (!schedules.byProject.has(projectId)) {
      const project = projects.get(projectId);
      const state = { timezone: null, jobs: [], history: new Map() };
      schedules.byProject.set(projectId, state);
      for (const declaration of schedules.declared.get(project?.typeId) ?? []) state.jobs.push(scheduledJob(projectId, state, declaredSettings(declaration), declaration.id));
    }
    return schedules.byProject.get(projectId);
  };
  const declaredSettings = (declaration) => ({
    name: declaration.name ?? declaration.description, enabled: declaration.enabled ?? false, trigger: { kind: 'cron', cron: declaration.cron },
    target: { kind: 'slot', slotId: declaration.slotId ?? 'review', description: declaration.description },
    overlap: 'skip', missedPolicy: 'skip', maxRunsPerDay: null, maxFiveHourPercent: null, maxWeeklyPercent: null, needsApproval: declaration.needsApproval ?? false, failureThreshold: 3,
  });
  const zoneOffsetMs = (timezone) => {
    const at = new Date(schedules.now);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(at).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - at.getTime();
  };
  const nextRunAt = (state, settings) => {
    if (!settings.enabled) return null;
    if (settings.trigger.kind !== 'cron') return schedules.now;
    return new Date(Date.parse('2026-10-12T09:00:00.000Z') - zoneOffsetMs(state.timezone ?? schedules.hostTimezone)).toISOString();
  };
  const scheduledJob = (projectId, state, settings, declaredJobId = null) => ({
    ...settings, id: `job-${nextId++}`, projectId, declaredJobId, consecutiveFailures: 0, autoDisabled: false,
    nextRunAt: nextRunAt(state, settings), pollError: null, createdAt: new Date(Date.parse(schedules.now) + nextId).toISOString(), updatedAt: schedules.now,
  });
  /** Mirrors server/src/scheduler/jobValidation.ts for the fields the web can get wrong: `{ value }` or `{ error, field }`. */
  const validateScheduleJob = (body, project) => {
    const refuse = (field, error) => ({ error, field });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('body', 'The job must be a JSON object');
    if (typeof body.name !== 'string' || !body.name.trim()) return refuse('name', 'The name is required');
    if (body.name.trim().length > 120) return refuse('name', 'The name must be at most 120 characters');
    const trigger = body.trigger ?? {};
    if (!['cron', 'file', 'api'].includes(trigger.kind)) return refuse('trigger.kind', 'The trigger kind must be one of: cron, file, api');
    if (trigger.kind === 'cron') {
      const cron = typeof trigger.cron === 'string' ? trigger.cron.trim() : '';
      if (!cronIsValid(cron)) return refuse('trigger.cron', 'Invalid cron expression: it needs 5 fields (minute hour day month weekday)');
    } else if (!Number.isInteger(trigger.intervalSeconds) || trigger.intervalSeconds < 60) {
      return refuse('trigger.intervalSeconds', 'The interval must be at least 1 minute');
    }
    const target = body.target ?? {};
    const slots = buildings.types.find((type) => type.id === project.typeId)?.slots ?? [];
    if (target.kind === 'slot' && !slots.some((slot) => slot.id === target.slotId)) return refuse('target.slotId', `This Building's type has no workflow slot "${target.slotId}"`);
    if (target.kind !== 'slot' && target.kind !== 'prompt') return refuse('target.kind', 'What the job runs must be one of: slot, prompt');
    return {
      value: {
        name: body.name.trim(), enabled: body.enabled ?? true, trigger, target, overlap: body.overlap ?? 'skip',
        missedPolicy: trigger.kind === 'cron' ? body.missedPolicy ?? 'skip' : null, maxRunsPerDay: body.maxRunsPerDay ?? null,
        maxFiveHourPercent: body.maxFiveHourPercent ?? null, maxWeeklyPercent: body.maxWeeklyPercent ?? null,
        needsApproval: body.needsApproval ?? false, failureThreshold: body.failureThreshold ?? 3,
      },
    };
  };
  const cronIsValid = (cron) => ['@hourly', '@daily', '@weekly', '@monthly', '@yearly'].includes(cron.toLowerCase()) || (cron.split(/\s+/).length === 5 && /^[\d*\/,\-a-zA-Z ]+$/.test(cron));
  const GOING = ['running', 'awaiting-approval'];
  const jobView = (state, job) => {
    const entries = state.history.get(job.id) ?? [];
    const active = entries.find((entry) => GOING.includes(entry.outcome));
    return {
      ...job, runsToday: entries.filter((entry) => entry.runStartedAt !== null).length,
      activeRun: active ? { entryId: active.id, runId: active.runId, outcome: active.outcome } : null,
      queued: entries.some((entry) => entry.outcome === 'queued'), lastEntry: entries[0] ?? null,
    };
  };
  const schedulesView = (projectId) => {
    const state = scheduleState(projectId);
    const declared = schedules.declared.get(projects.get(projectId)?.typeId) ?? [];
    return {
      projectId, timezone: state.timezone, hostTimezone: schedules.hostTimezone,
      jobs: [...state.jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((job) => jobView(state, job)),
      missingDefaults: declared.filter((declaration) => !state.jobs.some((job) => job.declaredJobId === declaration.id)).length,
    };
  };
  const historyEntry = (state, job, fields) => {
    const entries = state.history.get(job.id) ?? [];
    const entry = {
      id: `entry-${nextId++}`, jobId: job.id, projectId: job.projectId, seq: (entries[0]?.seq ?? 0) + 1, dueAt: schedules.now, startedAt: schedules.now,
      finishedAt: null, durationMs: null, note: null, change: null, runId: null, runStartedAt: null, deferredUntil: null, ...fields,
    };
    state.history.set(job.id, [entry, ...entries]);
    return entry;
  };
  /** Ends a run a test started through Run now, the way the daemon's run events would. */
  const settleRun = (runId, outcome = 'succeeded') => {
    for (const state of schedules.byProject.values()) {
      for (const entries of state.history.values()) {
        const entry = entries.find((candidate) => candidate.runId === runId);
        if (entry) Object.assign(entry, { outcome, finishedAt: schedules.now, durationMs: 0 });
      }
    }
  };
  /**
   * Links, subscriptions, capability calls and the Activity log — mirrors server/src/api/connectionRoutes.ts for the
   * routes the store calls. A test seeds each type's `capabilities` / `events` on `buildings.types`, may mark a
   * `(target id, capability id)` busy through `connections.busy`, and reads `connections.requests` (every call sent).
   */
  const connections = { links: new Map(), subscriptions: new Map(), activity: [], busy: new Set(), requests: [] };
  const connectionFailure = (status, error, field) => respond({ error, ...(field ? { field } : {}) }, status);
  const typeOfProject = (projectId) => buildings.types.find((type) => type.id === (projects.get(projectId)?.typeId ?? 'software'));
  const linkView = (link) => {
    const type = typeOfProject(link.toBuildingId);
    const reasons = [
      ...link.capabilities.filter((g) => !(type?.capabilities ?? []).some((c) => c.id === g.capabilityId)).map((g) => `The target no longer offers "${g.capabilityId}"`),
      ...link.events.filter((e) => !(type?.events ?? []).some((event) => event.id === e)).map((e) => `The target no longer publishes "${e}"`),
    ];
    return { ...link, fromName: projects.get(link.fromBuildingId)?.name ?? null, toName: projects.get(link.toBuildingId)?.name ?? null, broken: reasons.length > 0, brokenReasons: reasons };
  };
  const parseGrants = (grants, type) => {
    for (const [index, grant] of (grants ?? []).entries()) {
      if (!(type?.capabilities ?? []).some((c) => c.id === grant.capabilityId)) return { field: `capabilities[${index}].capabilityId`, error: `The target does not offer "${grant.capabilityId}"` };
    }
    return null;
  };
  const record = (entry) => {
    const stamped = {
      id: `activity-${nextId++}`, at: new Date(Date.parse('2026-10-12T09:00:00.000Z') + nextId * 1000).toISOString(), inputsShortened: false, message: null, runRef: null, callerRefId: null,
      callerName: projects.get(entry.callerBuildingId)?.name ?? 'Building deleted', targetName: projects.get(entry.targetBuildingId)?.name ?? 'Building deleted', ...entry,
    };
    connections.activity.push(stamped);
    return stamped;
  };
  const transcripts = new Map();
  const planDocsByProject = new Map();
  const planItems = new Map();
  /** Every POST /api/plan-items/:id/execute body, in order — what the start dialog sent. */
  const executeRequests = [];
  /** Every POST /api/plan-items/:id/regression body, in order. */
  const regressionRequests = [];
  /** When set, a regression request is refused with this 409 message (a full Project, a busy folder). */
  let regressionRefusal = '';
  const tasksById = new Map();
  const blueprintsByProject = new Map();
  const commands = new Map();
  /** Agent terminal sessions — mirrors server/src/terminal/agentSessions.ts (numbering never reuses a number, names are trimmed and at most 80 characters). */
  const agentSessions = { byId: new Map(), counters: new Map(), requests: [], failStart: null };
  const commandRuns = new Map();
  const catalogAgents = new Map();
  const catalogSkills = new Map();
  const skillInstallRuns = new Map();
  const notifications = new Map();
  const workflows = new Map();
  const workflowRuns = new Map();
  const reopenedTasks = new Set();
  const stepRuns = new Map();
  /** Per-project testing config state — mirrors GET /api/projects/:id/testing/config's `TestingConfigState`. Absent for a project until its setup is approved (see the approve route below). */
  const testingConfigs = new Map();
  const testRuns = new Map();
  /** The 3D village's red machines: which runs the web marked opened, a forced refusal, and a gate that holds the unopened-failures lists (to race them against a mark-opened). */
  const openedRequests = [];
  let openedFailure = null;
  const unopenedListGate = { wait: null };
  /**
   * The PR tab — mirrors server/src/projects/pullRequestService.ts for the routes the store calls.
   * Tests seed `open` (per project: the list rows) and `mergeStates` (per project: number → the
   * classified merge state), and script failures: `unreadable` (number → the merge-state read's
   * error), `mergeRefusals` (number → the provider's reason), `mergeResults` (number → the merged
   * result's branch fields), `checkoutRefusals` (number → `{ status, error }`) and `goneBranches`
   * (branch names Return can no longer reach). `requests` records every action request.
   */
  const pullRequests = {
    open: new Map(), mergeStates: new Map(), unreadable: new Map(), mergeRefusals: new Map(), mergeResults: new Map(),
    checkoutRefusals: new Map(), goneBranches: new Set(), requests: [],
  };
  const syncReading = (project, branch) => ({ projectId: project.id, branch, status: 'synced', aheadBy: 0, behindBy: 0, checkedAt: new Date().toISOString() });
  const activeConflictRun = (projectId, number) => [...workflowRuns.values()]
    .find((run) => run.projectId === projectId && run.prConflict?.number === number && ['running', 'completing'].includes(run.status)) ?? null;
  const executors = new Map([
    ['test-claude', { id: 'test-claude', label: 'Test Claude', kind: 'claude-cli', bin: 'claude', env: {} }],
    ['test-codex', { id: 'test-codex', label: 'Test Codex', kind: 'codex-cli', bin: 'codex', env: {} }],
  ]);
  /** The app-wide default coding agent (task 19.001): `id` is null until a test or a PUT sets it; `requests` records every PUT body. */
  const defaultExecutor = { id: null, requests: [] };
  const executorUnavailable = (executor) => [executor.limits?.fiveHour, executor.limits?.sevenDay]
    .some((window) => window && window.usedPercentage >= 100 && (window.resetsAt === null || window.resetsAt > Date.now() / 1000));
  /**
   * Agent analytics — mirrors server/src/analytics for the routes the store calls. Tests seed
   * `readings` (stored readings per agent id), `activities` and `stepRows`, and set `failing` to make
   * every analytics route answer 500. The real series analysis (gaps, resets, decreases) lives in the
   * daemon and is tested there; here every reading of a day is one joined segment.
   */
  const analytics = { readings: new Map(), activities: [], stepRows: [], failing: false, refreshResult: 'refreshed', refreshCount: 0, collectionStartedAt: 0 };
  const analyticsAgent = (executor) => ({ id: executor.id, label: executor.label, kind: executor.kind, retired: false, retiredAt: null, sharedWith: [] });
  const analyticsHistory = { loadError: null, saveError: null };
  const analyticsCheck = (readings) => ({ lastSuccessAt: readings.at(-1)?.at ?? null, lastFailure: null, nextEligibleAt: null });
  const analyticsSeries = (readings, window, from, to) => ({
    points: readings.filter((reading) => reading[window] && reading.at >= from && reading.at <= to)
      .map((reading) => ({ at: reading.at, remaining: 100 - reading[window].usedPercentage, used: reading[window].usedPercentage, resetsAt: reading[window].resetsAt, segment: 0 })),
    gaps: [],
    resets: [],
  });
  const analyticsCurrent = (latest, window) => !latest ? { state: 'awaiting', remaining: null, used: null, observedAt: null, resetsAt: null }
    : !latest[window] ? { state: 'unavailable', remaining: null, used: null, observedAt: latest.at, resetsAt: null }
    : { state: 'measured', remaining: 100 - latest[window].usedPercentage, used: latest[window].usedPercentage, observedAt: latest.at, resetsAt: latest[window].resetsAt };
  let nextId = 1;

  const respond = (body, status = 200) =>
    new Response(body === undefined || status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  /** A timestamp strictly after `previous`, as two daemon writes always are; within one test tick the clock alone would repeat. */
  const laterThan = (previous) => new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();

  function makeTask(project, { description, executorId, kind = 'execute', planItemId = null, sessionId = null, executionMode, conversationId }) {
    const task = {
      id: `test-task-${nextId++}`,
      projectId: project.id,
      templateId: 'builder',
      executorId: executorId ?? 'test-claude',
      executionMode,
      conversationId,
      description,
      status: 'developing',
      autonomy: 'auto',
      kind,
      planItemId,
      sessionId,
      blockedQuestion: null,
      failureReason: null,
      createdAt: new Date(Date.now() + nextId).toISOString(), // monotonically increasing even within the same tick
      updatedAt: new Date().toISOString(),
      completedAt: null,
    };
    project.activeTaskId = task.id;
    project.status = 'developing';
    project.taskCount += 1;
    tasksById.set(task.id, task);
    transcripts.set(task.id, { id: task.id, taskId: task.id, turns: [] });
    if (planItemId) {
      const item = planItems.get(planItemId);
      if (item) {
        item.status = 'developing';
        item.taskIds = [...item.taskIds, task.id];
      }
    }
    return task;
  }

  // ---- Notifications (docs/milestones/milestone-5-notification-system.md) ----
  // Mirrors server/src/notifications/notificationService.ts closely enough for store/UI tests to
  // seed and read Notifications exactly as a real producer/route would, including dedupe.

  function subjectIdentityKey(subject) {
    if (subject.type === 'task') return `task:${subject.conversationId}`;
    if (subject.type === 'command') return `command:${subject.commandId}`;
    if (subject.type === 'project') return `project:${subject.projectId}`;
    return `skill:${subject.repo}`;
  }
  function sameSubjectIdentity(a, b) {
    return a.type === b.type && subjectIdentityKey(a) === subjectIdentityKey(b);
  }
  function subjectProjectId(subject) {
    return subject.type === 'skill' ? null : subject.projectId;
  }
  function matchesNotificationFilter(n, filter) {
    if (filter.resolved !== undefined && (n.resolvedAt !== null) !== filter.resolved) return false;
    if (filter.read !== undefined && (n.readAt !== null) !== filter.read) return false;
    if (filter.severity !== undefined && n.severity !== filter.severity) return false;
    if (filter.projectId !== undefined) {
      if (filter.projectId === 'none') { if (n.projectId !== null) return false; }
      else if (n.projectId !== filter.projectId) return false;
    }
    return true;
  }
  /** Exposed on the returned stub (as `raiseNotification`) so tests can seed a Notification exactly as a real producer would, dedupe included. */
  function raiseNotification({ kind, subject, title, description }) {
    const now = new Date().toISOString();
    const existing = [...notifications.values()].find((n) => n.kind === kind && n.resolvedAt === null && sameSubjectIdentity(n.subject, subject));
    if (existing) {
      existing.title = title; existing.description = description; existing.subject = subject;
      existing.projectId = subjectProjectId(subject); existing.readAt = null; existing.updatedAt = now;
      return existing;
    }
    const SEVERITY_BY_KIND = {
      'task.needs_input': 'warning', 'task.failed': 'critical', 'task.completed': 'info',
      'command.failed': 'warning', 'git.out_of_sync': 'warning', 'skill.install_failed': 'warning',
      'testing.failed': 'warning', 'workflow.awaiting_approval': 'warning', 'workflow.needs_attention': 'critical',
    };
    const notification = {
      id: `test-notification-${nextId++}`,
      kind, severity: SEVERITY_BY_KIND[kind] ?? 'info', subject, projectId: subjectProjectId(subject),
      title, description, readAt: null, resolvedAt: null,
      createdAt: new Date(Date.now() + nextId).toISOString(), updatedAt: now,
    };
    notifications.set(notification.id, notification);
    return notification;
  }

  function testingConfigState(projectId) {
    return testingConfigs.get(projectId) ?? { state: 'absent', path: TESTING_CONFIG_PATH };
  }

  /** Mirrors GET /api/projects/:id/testing's shape: every configured suite joined with its runs, plus the live queue. */
  function buildTestingOverview(projectId) {
    const config = testingConfigState(projectId);
    const runsForProject = [...testRuns.values()].filter((r) => r.projectId === projectId);
    const suites = config.state === 'valid' ? config.config.suites.map((suiteCfg) => {
      const actions = suiteCfg.actions.map((actionCfg) => {
        const runsForAction = runsForProject
          .filter((r) => r.suite.id === suiteCfg.id && r.action.id === actionCfg.id)
          .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
        const activeRun = runsForAction.find((r) => r.status === 'queued' || r.status === 'running') ?? null;
        const latestResult = runsForAction.find((r) => r.status === 'passed' || r.status === 'failed' || r.status === 'error') ?? null;
        return { id: actionCfg.id, label: actionCfg.label, purpose: actionCfg.purpose, enabled: actionCfg.enabled, latestResult, latestRun: runsForAction[0] ?? null, activeRun };
      });
      const suiteLatest = actions
        .map((a) => a.latestResult)
        .filter(Boolean)
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0] ?? null;
      return { id: suiteCfg.id, label: suiteCfg.label, kind: suiteCfg.kind, enabled: suiteCfg.enabled, primaryActionId: suiteCfg.primaryActionId, latestResult: suiteLatest, actions };
    }) : [];
    const queue = runsForProject
      .filter((r) => r.status === 'queued' || r.status === 'running')
      .sort((a, b) => (a.status === 'running' ? -1 : 1) - (b.status === 'running' ? -1 : 1) || a.queuedAt.localeCompare(b.queuedAt));
    return { config, suites, queue };
  }

  function findSuiteAction(config, suiteId, actionId) {
    if (config.state !== 'valid') return null;
    const suite = config.config.suites.find((s) => s.id === suiteId);
    const action = suite?.actions.find((a) => a.id === actionId);
    return suite && action ? { suite, action } : null;
  }

  /** A freshly-queued TestRun — mirrors server/src/domain/types.ts's TestRunRecord; `output`/`result` are detail-only fields a test can settle directly on this returned record (no background execution is simulated here). */
  function makeTestRun(project, suite, action, { trigger = 'manual', taskId = null } = {}) {
    const now = new Date().toISOString();
    const run = {
      id: `test-run-${nextId++}`,
      projectId: project.id,
      batchId: null,
      suite: { id: suite.id, label: suite.label, kind: suite.kind },
      action: { id: action.id, label: action.label, purpose: action.purpose, command: action.command, workingDirectory: action.workingDirectory, collectors: action.collectors },
      trigger,
      taskId,
      executionRoot: 'main',
      cwd: null,
      branch: 'main',
      commit: null,
      status: 'running',
      exitCode: null,
      queuedAt: now,
      startedAt: now,
      completedAt: null,
      durationMs: null,
      outputTruncated: false,
      summary: null,
      diagnostics: [],
      artifactDir: null,
      output: '',
      result: null,
    };
    testRuns.set(run.id, run);
    return run;
  }

  function testingSetupPlanItem(projectId) {
    return [...planItems.values()]
      .filter((item) => item.projectId === projectId && item.testingSetup)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  globalThis.fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : init.body || undefined;

    if (method === 'POST' && pathname === '/api/projects' && body?.typeId === 'seo') {
      // Mirrors server/src/buildings/types/seo.ts: the site address must be a valid http(s) URL, else a 400 naming siteUrl.
      let site;
      try { site = new URL(String(body.siteUrl ?? '')); } catch { return respond({ error: 'siteUrl must be a full http or https address such as https://example.com', field: 'siteUrl' }, 400); }
      if (!['http:', 'https:'].includes(site.protocol)) return respond({ error: 'siteUrl must start with http:// or https://', field: 'siteUrl' }, 400);
      const id = `test-project-${nextId++}`;
      const project = { id, typeId: 'seo', typeVersion: 1, typeUnavailable: false, readOnly: false, readOnlyReason: null, name: (body.name ?? '').trim() || site.hostname, slug: id, relativePath: `projects/${id}`, status: 'idle', position: body.position ?? null, activeTaskId: null, taskCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      projects.set(id, project);
      seo.byProject.set(id, { siteUrl: `${site.protocol}//${site.hostname}`, syncing: false, acknowledged: false, property: null });
      return respond(project, 201);
    }

    if (method === 'POST' && pathname === '/api/projects') {
      // Mirrors server/src/api/router.ts: an unknown type is a 400 naming typeId; the type validates the rest.
      const type = body.typeId === undefined ? buildings.types.find((t) => t.id === 'software') : buildings.types.find((t) => t.id === body.typeId && !t.devOnly);
      if (!type) return respond({ error: `Unknown Building type "${body.typeId}"`, field: 'typeId' }, 400);
      if (typeof body.name !== 'string' || !body.name.trim()) return respond({ error: 'name is required', field: 'name' }, 400);
      const id = `test-project-${nextId++}`;
      const project = {
        id,
        typeId: type.id,
        typeVersion: type.version,
        typeUnavailable: false,
        readOnly: false,
        readOnlyReason: null,
        name: body.name.trim(),
        repositoryUrl: body.repositoryUrl,
        slug: id,
        relativePath: `projects/${id}`,
        status: 'idle',
        position: body.position ?? null,
        activeTaskId: null,
        taskCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      projects.set(id, project);
      planDocsByProject.set(id, PLAN_DOC_DEFS.map((d) => ({ ...d, content: `# ${d.title}\n\nNothing recorded yet.\n` })));
      blueprintsByProject.set(id, '# Blueprint\n\n## What currently exists\n\nNo Task has run yet.\n');
      return respond(project, 201);
    }

    const blueprintMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/blueprint$/);
    if (blueprintMatch) {
      const markdown = blueprintsByProject.get(blueprintMatch[1]);
      if (markdown === undefined) return respond({ error: 'not found' }, 404);
      return new Response(markdown, { status: 200, headers: { 'content-type': 'text/markdown' } });
    }

    const listTasksMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/tasks$/);
    if (listTasksMatch) {
      if (!projects.has(listTasksMatch[1])) return respond({ error: 'not found' }, 404);
      return respond([...tasksById.values()].filter((t) => t.projectId === listTasksMatch[1]));
    }

    const followupMatch = method === 'POST' && pathname.match(/^\/api\/tasks\/([^/]+)\/followup$/);
    if (followupMatch) {
      const prior = tasksById.get(followupMatch[1]);
      if (!prior) return respond({ error: 'not found' }, 404);
      if (prior.status === 'developing' || prior.status === 'blocked') return respond({ error: 'still active' }, 409);
      const project = projects.get(prior.projectId);
      return respond(
        makeTask(project, {
          description: body.instruction,
          executorId: prior.executorId,
          kind: prior.kind,
          planItemId: prior.planItemId,
          sessionId: prior.sessionId,
          executionMode: prior.executionMode,
          conversationId: prior.conversationId ?? prior.id,
        }),
        201,
      );
    }

    const resumeMatch = method === 'POST' && pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
    if (resumeMatch) {
      const prior = tasksById.get(resumeMatch[1]);
      if (!prior) return respond({ error: 'not found' }, 404);
      if (prior.status === 'developing' || prior.status === 'blocked') return respond({ error: 'still active' }, 409);
      const project = projects.get(prior.projectId);
      return respond(
        makeTask(project, {
          description: prior.description,
          executorId: prior.executorId,
          kind: prior.kind,
          planItemId: prior.planItemId,
          sessionId: prior.sessionId,
          executionMode: prior.executionMode,
          conversationId: prior.conversationId ?? prior.id,
        }),
        201,
      );
    }

    if (method === 'GET' && pathname === '/api/projects') {
      return respond([...projects.values()]);
    }

    const openPrMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/open-pull-requests$/);
    if (openPrMatch) {
      const project = projects.get(openPrMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      if (!project.repositoryUrl) return respond({ error: 'This project has no linked GitHub repository' }, 400);
      const open = pullRequests.open.get(project.id) ?? [];
      return respond({ count: open.length, pullRequests: open, truncated: false, checkedAt: new Date().toISOString() });
    }

    const projectGetMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectGetMatch) {
      const project = projects.get(projectGetMatch[1]);
      return project ? respond(project) : respond({ error: 'not found' }, 404);
    }

    const prReturnMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/pull-requests\/return$/);
    if (prReturnMatch) {
      const project = projects.get(prReturnMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      pullRequests.requests.push({ action: 'return', projectId: project.id, body });
      if (!project.prCheckout) return respond({ error: 'This project has no pull request checked out to return from.' }, 409);
      const target = body?.branch ?? project.prCheckout.previousBranch;
      if (pullRequests.goneBranches.has(target)) {
        return respond({ error: `The branch "${target}" you were on before no longer exists. Return to "main" instead.`, defaultBranch: 'main' }, 409);
      }
      project.prCheckout = null;
      project.sync = syncReading(project, target);
      return respond(project);
    }

    const prActionMatch = pathname.match(/^\/api\/projects\/([^/]+)\/pull-requests\/([^/]+)\/(merge-state|merge|checkout)$/);
    if (prActionMatch) {
      const [, projectId, rawNumber, action] = prActionMatch;
      if (!/^[1-9]\d{0,9}$/.test(rawNumber)) return respond({ error: 'The pull request number must be a positive whole number' }, 400);
      const number = Number(rawNumber);
      const project = projects.get(projectId);
      if (!project) return respond({ error: 'not found' }, 404);
      if (!project.repositoryUrl) return respond({ error: 'This project has no linked repository for its Git provider' }, 400);
      pullRequests.requests.push({ action, method, projectId, number, body });
      const options = body ?? {};
      const state = pullRequests.mergeStates.get(projectId)?.get(number);
      const open = pullRequests.open.get(projectId) ?? [];

      if (action === 'merge-state' && method === 'GET') {
        const checkedAt = new Date().toISOString();
        if (pullRequests.unreadable.has(number)) return respond({ number, checkedAt, mergeState: null, error: pullRequests.unreadable.get(number) });
        return state ? respond({ number, checkedAt, mergeState: state }) : respond({ error: `Pull request #${number} was not found.` }, 404);
      }

      if (action === 'checkout' && method === 'POST') {
        const refusal = pullRequests.checkoutRefusals.get(number);
        if (refusal) return respond({ error: refusal.error }, refusal.status);
        if (!state) return respond({ error: `Pull request #${number} was not found.` }, 404);
        if (!state.headBranchExists) return respond({ error: `The branch of pull request #${number} no longer exists.` }, 409);
        const from = project.sync?.branch ?? 'main';
        const branch = state.isFork ? `pr-${number}/${state.headBranch}` : state.headBranch;
        project.prCheckout = { number, branch, previousBranch: from !== branch ? from : project.prCheckout?.previousBranch ?? 'main' };
        project.sync = syncReading(project, branch);
        return respond(project);
      }

      if (action === 'merge' && method === 'POST') {
        const running = activeConflictRun(projectId, number);
        if (running) return respond({ outcome: 'resolving', run: running, existing: true });
        if (!state) return respond({ error: `Pull request #${number} was not found.` }, 404);
        if (state.status === 'unmergeable') return respond({ error: state.reason }, 409);
        if (state.status === 'conflicts') {
          if (!options.executorId) return respond({ error: "Choose a coding agent to resolve this pull request's conflicts." }, 400);
          if (!executors.has(options.executorId)) return respond({ error: 'executor not found' }, 404);
          const now = new Date().toISOString();
          const prConflict = { number, title: state.title, headBranch: state.headBranch, baseBranch: state.baseBranch, pushRemote: 'origin' };
          const planItem = {
            id: `test-plan-item-${nextId++}`, projectId, title: `Resolve conflicts: #${number} ${state.title}`, description: '', status: 'developing',
            order: [...planItems.values()].filter((i) => i.projectId === projectId).length, taskIds: [], milestoneId: null, executorId: options.executorId,
            prConflict, createdAt: now, updatedAt: now,
          };
          planItems.set(planItem.id, planItem);
          const run = {
            id: `test-workflow-run-${nextId++}`, projectId, planItemId: planItem.id, workflowId: 'pr-conflict-resolution',
            workflowSnapshot: { id: 'pr-conflict-resolution', name: 'Resolve PR conflicts', steps: [{ id: 'resolve-conflicts', name: 'Resolve conflicts', canEditCode: true, requiresApproval: false }] },
            status: 'running', currentStepId: 'resolve-conflicts', baseBranch: `origin/${state.baseBranch}`, branch: `pr-conflicts/${number}-stub`,
            worktreePath: `/worktrees/run-${planItem.id}`, executorId: options.executorId, prUrl: null, completionReport: null,
            attentionReason: null, loopRoundAllowance: 0, prConflict: { ...prConflict, outcome: null, detail: null }, createdAt: now, updatedAt: now, completedAt: null,
          };
          workflowRuns.set(run.id, run);
          planItem.workflowRunId = run.id;
          const task = makeTask(project, { description: `Resolve conflicts: ${planItem.title}`, executorId: options.executorId, planItemId: planItem.id, executionMode: 'terminal' });
          Object.assign(task, { workflowRunId: run.id, workflowStepId: 'resolve-conflicts', runtimeStatus: 'running', worktreePath: run.worktreePath });
          return respond({ outcome: 'resolving', run, existing: false });
        }
        if (state.status === 'blocked' && options.confirmBlockers !== true) return respond({ outcome: 'needs-confirmation', blockers: state.blockers });
        if (pullRequests.mergeRefusals.has(number)) return respond({ error: pullRequests.mergeRefusals.get(number) }, 502);
        pullRequests.open.set(projectId, open.filter((pr) => pr.number !== number));
        pullRequests.mergeStates.get(projectId)?.delete(number);
        if (project.sync) project.sync = { ...project.sync, checkedAt: new Date(Date.now() + nextId++).toISOString() };
        return respond({ outcome: 'merged', branchDeleted: true, branchWarning: null, branchNote: null, ...pullRequests.mergeResults.get(number) });
      }
    }

    if (method === 'GET' && pathname === '/api/executors') {
      // Real GET /api/executors attaches a rolled-up usage summary per executor (see
      // server/src/executors/executorUsage.ts) — no Task is ever started against this stub, so
      // every executor's usage is always zero here.
      return respond([...executors.values()].map((executor) => ({ ...executor, usage: { totalTokens: 0, taskCount: 0 }, isDefault: executor.id === defaultExecutor.id })));
    }

    if (method === 'PUT' && pathname === '/api/executors/default') {
      defaultExecutor.requests.push(body);
      if (typeof body?.executorId !== 'string' || !body.executorId) return respond({ error: 'executorId must be a non-empty string' }, 400);
      const executor = executors.get(body.executorId);
      if (!executor) return respond({ error: 'This executor is not configured' }, 404);
      if (executorUnavailable(executor)) return respond({ error: `${executor.label} is out of quota` }, 409);
      defaultExecutor.id = executor.id;
      return respond({ defaultExecutorId: executor.id });
    }

    if (pathname.startsWith('/api/analytics/') && analytics.failing) return respond({ error: 'analytics unavailable' }, 500);

    if (method === 'GET' && pathname === '/api/analytics/agents') {
      return respond({ agents: [...executors.values()].map(analyticsAgent), collectionStartedAt: analytics.collectionStartedAt, history: analyticsHistory });
    }

    const analyticsMatch = pathname.match(/^\/api\/analytics\/agents\/([^/]+)(\/steps|\/refresh)?$/);
    if (analyticsMatch) {
      const executor = executors.get(decodeURIComponent(analyticsMatch[1]));
      if (!executor) return respond({ error: 'This coding agent has no analytics' }, 404);
      const readings = analytics.readings.get(executor.id) ?? [];
      if (method === 'GET' && analyticsMatch[2] === '/steps') return respond({ agent: analyticsAgent(executor), now: Date.now(), rows: analytics.stepRows });
      if (method === 'POST' && analyticsMatch[2] === '/refresh') {
        analytics.refreshCount += 1;
        return respond({ result: analytics.refreshResult, failureReason: null, nextEligibleAt: null, check: analyticsCheck(readings), history: analyticsHistory });
      }
      if (method === 'GET' && !analyticsMatch[2]) {
        const [from, to] = [Number(searchParams.get('from')), Number(searchParams.get('to'))];
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return respond({ error: 'The range must be one day' }, 400);
        return respond({
          agent: analyticsAgent(executor),
          now: Date.now(),
          range: { from, to },
          earliestAt: analytics.collectionStartedAt,
          current: { fiveHour: analyticsCurrent(readings.at(-1), 'fiveHour'), sevenDay: analyticsCurrent(readings.at(-1), 'sevenDay') },
          check: analyticsCheck(readings),
          series: { fiveHour: analyticsSeries(readings, 'fiveHour', from, to), sevenDay: analyticsSeries(readings, 'sevenDay', from, to) },
          activities: analytics.activities.filter((activity) => activity.startedAt <= to && (activity.endedAt ?? Date.now()) >= from),
          unattributed: [],
          history: analyticsHistory,
        });
      }
    }

    if (method === 'POST' && pathname === '/api/executors') {
      if (!body.label || !body.label.trim()) return respond({ error: 'label is required' }, 400);
      if (!body.bin || !body.bin.trim()) return respond({ error: 'bin is required' }, 400);
      if (body.kind !== 'claude-cli' && body.kind !== 'codex-cli') return respond({ error: 'kind must be "claude-cli" or "codex-cli"' }, 400);
      const id = uniqueId(slugify(body.label), new Set(executors.keys()));
      const executor = { id, label: body.label.trim(), kind: body.kind, bin: body.bin.trim(), env: body.env ?? {} };
      executors.set(id, executor);
      return respond(executor, 201);
    }

    const executorPatchMatch = method === 'PATCH' && pathname.match(/^\/api\/executors\/([^/]+)$/);
    if (executorPatchMatch) {
      const executor = executors.get(executorPatchMatch[1]);
      if (!executor) return respond({ error: 'not found' }, 404);
      if (body.kind !== undefined && body.kind !== 'claude-cli' && body.kind !== 'codex-cli') {
        return respond({ error: 'kind must be "claude-cli" or "codex-cli"' }, 400);
      }
      Object.assign(executor, {
        ...(body.label !== undefined && { label: body.label.trim() }),
        ...(body.kind !== undefined && { kind: body.kind }),
        ...(body.bin !== undefined && { bin: body.bin.trim() }),
        ...(body.env !== undefined && { env: body.env }),
      });
      return respond(executor);
    }

    const executorDeleteMatch = method === 'DELETE' && pathname.match(/^\/api\/executors\/([^/]+)$/);
    if (executorDeleteMatch) {
      if (!executors.has(executorDeleteMatch[1])) return respond({ error: 'not found' }, 404);
      if (executors.size === 1) return respond({ error: 'cannot remove the last executor' }, 409);
      executors.delete(executorDeleteMatch[1]);
      return respond(undefined, 204);
    }

    const patchMatch = method === 'PATCH' && pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (patchMatch) {
      const project = projects.get(patchMatch[1]);
      if (body.position !== undefined) {
        const valid = Array.isArray(body.position) && body.position.length === 2 && body.position.every((v) => typeof v === 'number' && Number.isFinite(v));
        const plot = valid && STUB_PROJECT_PLOTS.find((candidate) => nearPlot(candidate, body.position));
        if (!plot) return respond({ error: 'position must be [x, z] of one of the 240 project plots' }, 400);
        if (!project) return respond({ error: 'not found' }, 404);
        if ([...projects.values()].some((other) => other.id !== project.id && other.position && nearPlot(other.position, plot))) return respond({ error: 'That plot is already taken by another project' }, 409);
        body.position = plot;
      }
      if (!project) return respond({ error: 'not found' }, 404);
      Object.assign(project, body);
      return respond(project);
    }

    // Mirrors server/src/commands/commandRunner.ts's runProjectSync: refused with an active Task
    // (real guard), otherwise a CommandRun the same shape as POST /api/commands/:id/run below —
    // real fetch/fast-forward/diverge behavior is exercised against a real git repo by the
    // daemon's own gitSyncPoller.test.ts, not this in-memory stub.
    const syncMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/sync$/);
    if (syncMatch) {
      const project = projects.get(syncMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      if (project.activeTaskId) return respond({ error: 'active task' }, 409);
      const run = {
        id: `test-run-${nextId++}`,
        projectId: project.id,
        commandId: `sync:${project.id}`,
        commandName: 'Sync branch with origin',
        commandText: 'git fetch origin && git merge --ff-only origin/main',
        origin: 'sync',
        status: 'running',
        exitCode: null,
        output: '',
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      commandRuns.set(run.id, run);
      return respond(run, 201);
    }

    const tasksMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/tasks$/);
    if (tasksMatch) {
      const project = projects.get(tasksMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      return respond(makeTask(project, { description: body.description, executorId: body.executorId }), 201);
    }

    // ---- Bug tracker: mirrors server/src/api/router.ts and server/src/worker/bugTracker.ts ----

    // No executorId: the session is created with no CLI (settled, `cliNotStarted`), to be started later.
    const bugReportMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/plan-and-bugs$/);
    if (bugReportMatch) {
      const project = projects.get(bugReportMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      if (!description) return respond({ error: 'description is required' }, 400);
      const task = makeTask(project, { description, executorId: body.executorId ?? '', kind: 'plan' });
      const sessionNumbers = [...tasksById.values()].filter((t) => t.projectId === project.id && t.kind === 'plan').map((t) => t.planningSessionNumber ?? 0);
      Object.assign(task, { planningPurpose: 'plan-and-bugs', planningSessionNumber: Math.max(0, ...sessionNumbers) + 1, planningCreatedTaskCount: 0 });
      if (!body.executorId) {
        Object.assign(task, { status: 'stopped', cliNotStarted: true });
        project.activeTaskId = null;
        project.status = 'idle';
      }
      return respond(task, 201);
    }

    const sessionDescriptionMatch = method === 'PATCH' && pathname.match(/^\/api\/tasks\/([^/]+)\/description$/);
    const sessionStartMatch = method === 'POST' && pathname.match(/^\/api\/tasks\/([^/]+)\/start-session$/);
    if (sessionDescriptionMatch || sessionStartMatch) {
      const task = tasksById.get((sessionDescriptionMatch || sessionStartMatch)[1]);
      if (!task) return respond({ error: 'not found' }, 404);
      if (!task.cliNotStarted) return respond({ error: 'This session has already started, so its description and coding agent can no longer be changed' }, 409);
      if (sessionDescriptionMatch) {
        if (typeof body.description !== 'string' || !body.description.trim()) return respond({ error: 'description is required' }, 400);
        Object.assign(task, { description: body.description.trim(), updatedAt: laterThan(task.updatedAt) });
        return respond(task);
      }
      if (!body.executorId) return respond({ error: 'executorId is required' }, 400);
      if (!executors.has(body.executorId)) return respond({ error: 'Executor not found' }, 404);
      Object.assign(task, { executorId: body.executorId, status: 'developing', cliNotStarted: false, runtimeStatus: 'running', updatedAt: laterThan(task.updatedAt) });
      return respond(task, 201);
    }

    // The ids must be exactly the group's ready bugs: an unknown id is 404, anything else out of place 409.
    const bugGroupOrderMatch = method === 'PUT' && pathname.match(/^\/api\/projects\/([^/]+)\/planning-queue\/bugs\/([^/]+)\/order$/);
    if (bugGroupOrderMatch) {
      const [, projectId, introducerId] = bugGroupOrderMatch;
      if (!Array.isArray(body.ids) || new Set(body.ids).size !== body.ids.length) return respond({ error: 'ids must be an array of distinct plan item ids' }, 400);
      const inProject = [...planItems.values()].filter((item) => item.projectId === projectId);
      const ready = inProject.filter((item) => item.type === 'bug' && item.status === 'pending' && !item.archived && item.bug?.introducedBy?.planItemId === introducerId);
      if (!inProject.some((item) => item.id === introducerId || item.bug?.introducedBy?.planItemId === introducerId)) return respond({ error: 'not found' }, 404);
      if (body.ids.some((id) => !inProject.some((item) => item.id === id))) return respond({ error: 'not found' }, 404);
      if (body.ids.length !== ready.length || body.ids.some((id) => !ready.some((item) => item.id === id))) {
        return respond({ error: 'These bugs changed while you were reordering them. Reload and try again' }, 409);
      }
      body.ids.forEach((id, groupOrder) => { planItems.get(id).bug.groupOrder = groupOrder; });
      return respond(undefined, 204);
    }

    // Every top-level entry must be named once: a missing or unknown one fails the whole save.
    const planningQueueOrderMatch = method === 'PUT' && pathname.match(/^\/api\/projects\/([^/]+)\/planning-queue\/order$/);
    if (planningQueueOrderMatch) {
      const projectId = planningQueueOrderMatch[1];
      if (!Array.isArray(body.entries) || body.entries.some((entry) => !['session', 'task', 'reference'].includes(entry?.kind) || typeof entry.id !== 'string')) {
        return respond({ error: 'entries must contain planning session, task or introducing-task (reference) ids' }, 400);
      }
      const inProject = [...planItems.values()].filter((item) => item.projectId === projectId);
      const grouped = (item) => item.type === 'bug' && item.status === 'pending' && !item.archived && !!item.bug?.introducedBy;
      const groupIds = new Set(inProject.filter(grouped).map((item) => item.bug.introducedBy.planItemId));
      const named = new Set(body.entries.filter((entry) => entry.kind === 'reference').map((entry) => entry.id));
      if ([...named].some((id) => !groupIds.has(id))) return respond({ error: 'not found' }, 404);
      if (named.size !== groupIds.size) return respond({ error: 'The Planning order changed. Reload and try again' }, 409);
      body.entries.forEach((entry, planningQueueOrder) => {
        if (entry.kind === 'session') { const task = tasksById.get(entry.id); if (task) task.planningQueueOrder = planningQueueOrder; }
        else for (const item of inProject) if (item.id === entry.id || (entry.kind === 'reference' && grouped(item) && item.bug.introducedBy.planItemId === entry.id)) item.planningQueueOrder = planningQueueOrder;
      });
      return respond(undefined, 204);
    }

    const chatMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/chat$/);
    if (chatMatch) {
      const project = projects.get(chatMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      const kind = body.skipPlanning ? 'execute' : 'plan';
      return respond(makeTask(project, { description: body.message, executorId: body.executorId, kind }), 201);
    }

    const answerMatch = method === 'POST' && pathname.match(/^\/api\/tasks\/([^/]+)\/answer$/);
    if (answerMatch) {
      const task = tasksById.get(answerMatch[1]);
      if (!task) return respond({ error: 'not found' }, 404);
      if (task.status !== 'blocked') return respond({ error: 'not blocked' }, 409);
      const project = projects.get(task.projectId);
      task.blockedQuestion = null;
      task.updatedAt = new Date(Date.parse(task.updatedAt) + 1).toISOString();
      task.status = 'developing';
      if (project) project.status = 'developing';
      return respond(task);
    }

    const stopMatch = method === 'POST' && pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/);
    if (stopMatch) {
      const task = tasksById.get(stopMatch[1]);
      if (!task) return respond({ error: 'not found' }, 404);
      task.status = 'failed';
      task.failureReason = 'Stopped by user';
      const project = projects.get(task.projectId);
      if (project) { project.status = 'idle'; project.activeTaskId = null; }
      return respond(task);
    }

    const transcriptMatch = method === 'GET' && pathname.match(/^\/api\/tasks\/([^/]+)\/transcript$/);
    if (transcriptMatch) {
      const context = transcripts.get(transcriptMatch[1]);
      if (!context) return respond({ error: 'not found' }, 404);
      return respond(context);
    }

    const planMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/plan$/);
    if (planMatch) {
      const docs = planDocsByProject.get(planMatch[1]);
      if (!docs) return respond({ error: 'not found' }, 404);
      const items = [...planItems.values()].filter((i) => i.projectId === planMatch[1]).sort((a, b) => a.order - b.order);
      return respond({ docs, items });
    }

    const planDocMatch = method === 'PUT' && pathname.match(/^\/api\/projects\/([^/]+)\/plan\/docs\/([^/]+)$/);
    if (planDocMatch) {
      const docs = planDocsByProject.get(planDocMatch[1]);
      if (!docs) return respond({ error: 'not found' }, 404);
      const doc = docs.find((d) => d.key === planDocMatch[2]);
      if (!doc) return respond({ error: 'not a real doc' }, 400);
      doc.content = body.content;
      return respond(doc);
    }

    const planItemsCreateMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/plan-items$/);
    if (planItemsCreateMatch) {
      const projectId = planItemsCreateMatch[1];
      if (!projects.has(projectId)) return respond({ error: 'not found' }, 404);
      const existing = [...planItems.values()].filter((i) => i.projectId === projectId);
      const item = {
        id: `test-plan-item-${nextId++}`,
        projectId,
        title: body.title || body.description.split('\n')[0],
        description: body.description ?? '',
        status: 'pending',
        order: existing.length,
        taskIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      planItems.set(item.id, item);
      return respond(item, 201);
    }

    // Mirrors server/src/projects/planItemService.ts's reorderPlanItems.
    const planItemsOrderMatch = method === 'PUT' && pathname.match(/^\/api\/projects\/([^/]+)\/plan-items\/order$/);
    if (planItemsOrderMatch) {
      const moved = body.ids.map((id) => planItems.get(id));
      if (moved.some((item) => !item || item.projectId !== planItemsOrderMatch[1])) return respond({ error: 'not found' }, 404);
      const slots = moved.map((item) => item.order).sort((a, b) => a - b);
      moved.forEach((item, index) => { item.order = slots[index]; });
      return respond([...planItems.values()].filter((i) => i.projectId === planItemsOrderMatch[1]).sort((a, b) => a.order - b.order));
    }

    // Mirrors the Auto-merge routes in server/src/api/router.ts: 400 for a body that is not { enabled: boolean }, 404 for an unknown or out-of-project task, 409 when the task cannot have a PR.
    const autoMergeMatch = pathname.match(/^\/api\/projects\/([^/]+)\/plan-items\/([^/]+)\/auto-merge(\/retry)?$/);
    if (autoMergeMatch && (method === 'PUT' || (method === 'POST' && autoMergeMatch[3]))) {
      const item = planItems.get(autoMergeMatch[2]);
      if (!item || item.projectId !== autoMergeMatch[1]) return respond({ error: 'Plan item not found' }, 404);
      const now = new Date().toISOString();
      if (autoMergeMatch[3]) {
        if (!item.autoMerge?.enabled || !['failed', 'agent'].includes(item.autoMerge.state)) return respond({ error: 'Only a failed auto-merge, or one waiting for an agent, can be retried.' }, 409);
        item.autoMerge = { ...item.autoMerge, state: 'waiting', reasons: [], updatedAt: now };
        return respond(item);
      }
      if (typeof body?.enabled !== 'boolean') return respond({ error: 'The body must be { "enabled": true | false }' }, 400);
      if (body.enabled && !projects.get(item.projectId)?.repositoryUrl) return respond({ error: 'This project has no linked repository, so its tasks never raise a pull request.' }, 409);
      item.autoMerge = item.autoMerge
        ? { ...item.autoMerge, enabled: body.enabled, updatedAt: now }
        : { enabled: body.enabled, state: 'waiting', reasons: [], prNumber: null, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: now };
      return respond(item);
    }

    // Mirrors the dependency routes in server/src/api/router.ts and projects/dependencyService.ts. A parent counts as
    // satisfied here when its status is 'done' (the daemon reads git); everything else waits.
    const dependenciesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/plan-items\/([^/]+)\/(dependencies|start-when-ready|cancel-waiting|ui-planning-waits)$/);
    if (dependenciesMatch) {
      const [, projectId, itemId, action] = dependenciesMatch;
      const item = planItems.get(itemId);
      if (!item || item.projectId !== projectId) return respond({ error: 'This task no longer exists — it may have been deleted' }, 404);
      const ready = item.status === 'pending' && !item.workflowRunId;
      const parentsOf = (id) => planItems.get(id)?.dependsOn ?? [];
      const reaches = (from, target, seen = new Set()) => from === target || (!seen.has(from) && (seen.add(from), parentsOf(from).some((parent) => reaches(parent, target, seen))));
      if (method === 'PUT' && action === 'dependencies') {
        const next = body?.dependsOn;
        if (!Array.isArray(next) || next.length > 20 || !next.every((id) => typeof id === 'string' && id.trim())) return respond({ error: 'dependsOn must be an array of distinct task ids.' }, 400);
        const parents = [...new Set(next.map((id) => id.trim()))];
        if (parents.includes(itemId)) return respond({ error: 'A task cannot depend on itself.' }, 409);
        if (parents.some((id) => planItems.get(id)?.projectId !== projectId)) return respond({ error: 'This task no longer exists — it may have been deleted' }, 404);
        if (!projects.get(projectId)?.repositoryUrl) return respond({ error: 'Dependencies need a linked repository: this project has none.' }, 409);
        if (!ready) return respond({ error: 'Dependencies can only be changed on a ready task that has not started.' }, 409);
        if (parents.some((id) => reaches(id, itemId))) return respond({ error: 'That would make the tasks wait for each other (a cycle).' }, 409);
        item.dependsOn = parents;
        return respond(item);
      }
      if (method === 'GET' && action === 'dependencies') {
        return respond((item.dependsOn ?? []).map((id) => {
          const parent = planItems.get(id);
          const satisfied = parent?.status === 'done';
          return { id, label: parent?.title ?? 'Deleted task', title: parent?.title ?? '', satisfied, reason: satisfied ? null : { parentId: id, text: parent ? 'Waiting for ' + parent.title + ' to finish' : 'Blocked: a parent task was deleted', blocked: !parent } };
        }));
      }
      if (method === 'POST' && action === 'start-when-ready') {
        if (!ready) return respond({ error: 'Dependencies can only be changed on a ready task that has not started.' }, 409);
        if (!(item.dependsOn ?? []).length) return respond({ error: 'This task has no dependencies: start it normally.' }, 409);
        const unsatisfied = item.dependsOn.filter((id) => planItems.get(id)?.status !== 'done');
        if (unsatisfied.length === 0) return respond({ started: true, run: { id: `test-workflow-run-${nextId++}`, projectId, planItemId: itemId, status: 'starting', workflowId: 'software-development', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }, 201);
        const reasons = unsatisfied.map((id) => ({ parentId: id, text: 'Waiting for ' + planItems.get(id)?.title + ' to finish', blocked: false }));
        item.waiting = { options: body ?? {}, state: 'waiting', reasons, since: new Date().toISOString(), longWaitNotified: false, updatedAt: new Date().toISOString() };
        return respond({ started: false, item }, 202);
      }
      if (method === 'PUT' && action === 'ui-planning-waits') {
        if (typeof body?.uiPlanningWaitsForParent !== 'boolean') return respond({ error: 'uiPlanningWaitsForParent must be true or false.' }, 400);
        if (!(item.dependsOn ?? []).length) return respond({ error: 'This task has no parent tasks, so the setting does not apply.' }, 409);
        if (item.workflowRunId) return respond({ error: 'UI Planning has already started, so this can\'t change now.' }, 409);
        item.uiPlanningWaitsForParent = body.uiPlanningWaitsForParent;
        return respond(item);
      }
      if (method === 'POST' && action === 'cancel-waiting') {
        if (!item.waiting) return respond({ error: 'This task is not waiting for its parents.' }, 409);
        delete item.waiting;
        return respond(item);
      }
    }
    const chainMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/planning-groups\/([^/]+)\/chain$/);
    if (chainMatch) {
      const session = Number(chainMatch[2]);
      if (!Number.isInteger(session) || session < 1 || (body?.autoMerge !== undefined && typeof body.autoMerge !== 'boolean')) return respond({ error: 'The session must be a positive whole number and autoMerge a boolean' }, 400);
      const group = [...planItems.values()].filter((item) => item.projectId === chainMatch[1] && item.planningRef?.session === session);
      const ready = group.filter((item) => item.status === 'pending' && !item.workflowRunId && !item.archived).sort((a, b) => (a.planningGroupOrder ?? Infinity) - (b.planningGroupOrder ?? Infinity) || a.planningRef.task - b.planningRef.task);
      ready.slice(1).forEach((item, index) => { item.dependsOn = [...new Set([...(item.dependsOn ?? []), ready[index].id])]; });
      if (body?.autoMerge) ready.forEach((item) => { item.autoMerge = item.autoMerge ?? { enabled: true, state: 'waiting', reasons: [], prNumber: null, runId: null, mergedAt: null, branchWarning: null, branchNote: null, updatedAt: new Date().toISOString() }; item.autoMerge.enabled = true; });
      return respond(group);
    }

    const planItemPatchMatch = method === 'PATCH' && pathname.match(/^\/api\/plan-items\/([^/]+)$/);
    if (planItemPatchMatch) {
      const item = planItems.get(planItemPatchMatch[1]);
      if (!item) return respond({ error: 'not found' }, 404);
      // Mirrors planItemService.ts's archivePlanItem: refused while the item is developing.
      if (body.archived === true && item.status === 'developing') return respond({ error: 'cannot archive while developing' }, 409);
      // Mirrors bugTracker.ts's setBugInfoStatus: a bug's advisory flag, only while the bug has not started.
      if (body.infoStatus !== undefined) {
        if (!['enough', 'needs-more-info'].includes(body.infoStatus)) return respond({ error: 'infoStatus must be one of: enough, needs-more-info' }, 400);
        if (item.type !== 'bug') return respond({ error: 'only a bug has an info status' }, 400);
        if (item.status !== 'pending') return respond({ error: `"${item.title}" has already started, so its report can no longer be changed` }, 409);
        item.bug = { ...item.bug, infoStatus: body.infoStatus };
        return respond(item);
      }
      Object.assign(item, body);
      return respond(item);
    }

    const planItemDeleteMatch = method === 'DELETE' && pathname.match(/^\/api\/plan-items\/([^/]+)$/);
    if (planItemDeleteMatch) {
      const item = planItems.get(planItemDeleteMatch[1]);
      if (!item) return respond({ error: 'not found' }, 404);
      if (item.status === 'developing' || item.status === 'blocked') return respond({ error: 'has an active task' }, 409);
      planItems.delete(planItemDeleteMatch[1]);
      return respond(undefined, 204);
    }

    // Mirrors the execute route in server/src/api/router.ts: 201 with the new WorkflowRun, still 'starting'.
    // A task with parents must use start-when-ready (409); `createBranch` needs a repository (400);
    // without a branch the project folder must be free (409).
    const planItemExecuteMatch = method === 'POST' && pathname.match(/^\/api\/plan-items\/([^/]+)\/execute$/);
    if (planItemExecuteMatch) {
      const item = planItems.get(planItemExecuteMatch[1]);
      if (!item) return respond({ error: 'not found' }, 404);
      const project = projects.get(item.projectId);
      if (!project) return respond({ error: 'not found' }, 404);
      if (item.dependsOn?.length || item.waiting) return respond({ error: 'This task depends on other tasks: start it with start-when-ready.' }, 409);
      executeRequests.push({ planItemId: item.id, ...body });
      const createBranch = body.createBranch ?? !!project.repositoryUrl;
      if (createBranch && !project.repositoryUrl) return respond({ error: `Project "${project.id}" has no linked repository, so a task can't be started on a new branch` }, 400);
      if (!createBranch && project.activeTaskId) return respond({ error: `Project "${project.id}"'s folder is busy with another task` }, 409);
      const now = new Date().toISOString();
      const stepNames = { name: 'Choosing branch name', worktree: 'Creating worktree', hooks: 'Installing CLI hooks', launch: 'Launching agent' };
      const stepIds = createBranch ? ['name', 'worktree', 'hooks', 'launch'] : ['launch'];
      const run = {
        id: `test-workflow-run-${nextId++}`, projectId: project.id, planItemId: item.id, workflowId: body.workflowId ?? 'software-development',
        workflowSnapshot: { id: body.workflowId ?? 'software-development', name: 'Software Development', steps: [{ id: 'development', name: 'Development', canEditCode: true, requiresApproval: false }] },
        status: 'starting', startup: { reuseBranch: false, steps: stepIds.map((id) => ({ id, name: stepNames[id], state: 'pending' })) },
        currentStepId: 'development', executorId: body.executorId ?? 'test-claude', prUrl: null, completionReport: null,
        attentionReason: null, loopRoundAllowance: 0, createdAt: now, updatedAt: now, completedAt: null,
      };
      workflowRuns.set(run.id, run);
      item.workflowRunId = run.id;
      project.activeTaskId = run.id; // stands in for the work now holding the project, as the daemon's folder guard sees it
      return respond(run, 201);
    }

    // Mirrors POST /api/plan-items/:id/regression: the reason is validated, only a done bug reopens, and the reason is recorded with the new run.
    const planItemRegressionMatch = method === 'POST' && pathname.match(/^\/api\/plan-items\/([^/]+)\/regression$/);
    if (planItemRegressionMatch) {
      const item = planItems.get(planItemRegressionMatch[1]);
      if (!item) return respond({ error: 'not found' }, 404);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason) return respond({ error: 'reason is required' }, 400);
      if (reason.length > 20000) return respond({ error: 'reason must be at most 20,000 characters' }, 400);
      if (item.type !== 'bug') return respond({ error: `"${item.title}" is a task, not a bug` }, 409);
      if (item.status !== 'done') return respond({ error: `"${item.title}" is not completed` }, 409);
      if (regressionRefusal) return respond({ error: regressionRefusal }, 409);
      const now = new Date().toISOString();
      const run = { id: `test-workflow-run-${nextId++}`, projectId: item.projectId, planItemId: item.id, workflowId: 'bug-fix', status: 'starting', createdAt: now, updatedAt: now, completedAt: null, regression: { roundOffsets: { development: 1 } } };
      workflowRuns.set(run.id, run);
      item.workflowRunId = run.id;
      item.status = 'developing';
      item.archived = false;
      item.bug = { ...item.bug, regressions: [...(item.bug?.regressions ?? []), { reason, reportedAt: now, reporter: { kind: 'person' } }] };
      regressionRequests.push({ planItemId: item.id, ...body });
      return respond({ item, run, workflowNote: null }, 201);
    }

    // ---- Project Commands: user-defined shell commands, run from the project's root ----

    const commandsListMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/commands$/);
    if (commandsListMatch) {
      if (!projects.has(commandsListMatch[1])) return respond({ error: 'not found' }, 404);
      return respond([...commands.values()].filter((c) => c.projectId === commandsListMatch[1]));
    }

    const commandsCreateMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/commands$/);
    if (commandsCreateMatch) {
      const projectId = commandsCreateMatch[1];
      if (!projects.has(projectId)) return respond({ error: 'not found' }, 404);
      if (!body.name || !body.name.trim()) return respond({ error: 'name is required' }, 400);
      if (!body.command || !body.command.trim()) return respond({ error: 'command is required' }, 400);
      if (body.highlighted) {
        const highlightedCount = [...commands.values()].filter((c) => c.projectId === projectId && c.highlighted).length;
        if (highlightedCount >= 3) return respond({ error: 'highlight limit reached' }, 400);
      }
      const command = {
        id: `test-command-${nextId++}`,
        projectId,
        name: body.name.trim(),
        command: body.command.trim(),
        highlighted: body.highlighted === true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      commands.set(command.id, command);
      return respond(command, 201);
    }

    const commandPatchMatch = method === 'PATCH' && pathname.match(/^\/api\/commands\/([^/]+)$/);
    if (commandPatchMatch) {
      const command = commands.get(commandPatchMatch[1]);
      if (!command) return respond({ error: 'not found' }, 404);
      if (body.highlighted === true && !command.highlighted) {
        const highlightedCount = [...commands.values()].filter((c) => c.projectId === command.projectId && c.id !== command.id && c.highlighted).length;
        if (highlightedCount >= 3) return respond({ error: 'highlight limit reached' }, 400);
      }
      Object.assign(command, {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.command !== undefined && { command: body.command }),
        ...(body.highlighted !== undefined && { highlighted: body.highlighted }),
      });
      return respond(command);
    }

    const commandDeleteMatch = method === 'DELETE' && pathname.match(/^\/api\/commands\/([^/]+)$/);
    if (commandDeleteMatch) {
      if (!commands.has(commandDeleteMatch[1])) return respond({ error: 'not found' }, 404);
      commands.delete(commandDeleteMatch[1]);
      return respond(undefined, 204);
    }

    const commandRunMatch = method === 'POST' && pathname.match(/^\/api\/commands\/([^/]+)\/run$/);
    if (commandRunMatch) {
      const command = commands.get(commandRunMatch[1]);
      if (!command) return respond({ error: 'not found' }, 404);
      const run = {
        id: `test-run-${nextId++}`,
        projectId: command.projectId,
        commandId: command.id,
        commandName: command.name,
        commandText: command.command,
        origin: 'saved',
        status: 'running',
        exitCode: null,
        output: '',
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      commandRuns.set(run.id, run);
      return respond(run, 201);
    }

    // "Run a custom command and see the output right away" — a one-off, never-saved command.
    const runAdHocMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/commands\/run-adhoc$/);
    if (runAdHocMatch) {
      const project = projects.get(runAdHocMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      if (!body.command || !body.command.trim()) return respond({ error: 'command is required' }, 400);
      const run = {
        id: `test-run-${nextId++}`,
        projectId: project.id,
        commandId: `adhoc:${nextId}`,
        commandName: 'Custom command',
        commandText: body.command.trim(),
        origin: 'adhoc',
        status: 'running',
        exitCode: null,
        output: '',
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      commandRuns.set(run.id, run);
      return respond(run, 201);
    }

    const commandRunStopMatch = method === 'POST' && pathname.match(/^\/api\/command-runs\/([^/]+)\/stop$/);
    if (commandRunStopMatch) {
      const run = commandRuns.get(commandRunStopMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      if (run.status === 'running') { run.status = 'stopped'; run.completedAt = new Date().toISOString(); }
      return respond(run);
    }

    const commandRunGetMatch = method === 'GET' && pathname.match(/^\/api\/command-runs\/([^/]+)$/);
    if (commandRunGetMatch) {
      const run = commandRuns.get(commandRunGetMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      return respond(run);
    }

    const commandRunsListMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/command-runs$/);
    if (commandRunsListMatch) {
      if (!projects.has(commandRunsListMatch[1])) return respond({ error: 'not found' }, 404);
      const status = searchParams.get('status');
      // Mirrors server/src/api/router.ts: `?failureUnopened=true` lists only failed runs nobody has opened (the 3D village's red machines).
      const unopened = searchParams.get('failureUnopened');
      if (unopened !== null && unopened !== 'true') return respond({ error: 'failureUnopened must be "true"' }, 400);
      if (unopened) await unopenedListGate.wait?.();
      return respond([...commandRuns.values()]
        .filter((r) => r.projectId === commandRunsListMatch[1] && (!status || r.status === status) && (!unopened || r.failureUnopened === true))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
    }

    const commandRunOpenedMatch = method === 'POST' && pathname.match(/^\/api\/command-runs\/([^/]+)\/opened$/);
    if (commandRunOpenedMatch) {
      const run = commandRuns.get(commandRunOpenedMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      openedRequests.push(run.id);
      if (openedFailure) return respond({ error: openedFailure }, 500);
      delete run.failureUnopened;
      return respond(run);
    }

    // ---- Catalog: agents (Templates), mirrors server/src/catalog/catalogService.ts's TemplateRecord shape ----

    if (method === 'GET' && pathname === '/api/catalog/agents') {
      return respond([...catalogAgents.values()]);
    }

    if (method === 'POST' && pathname === '/api/catalog/agents') {
      if (!body.id || !body.id.trim()) return respond({ error: 'id is required' }, 400);
      if (!body.name || !body.name.trim()) return respond({ error: 'name is required' }, 400);
      if (!body.description || !body.description.trim()) return respond({ error: 'description is required' }, 400);
      if (catalogAgents.has(body.id)) return respond({ error: 'already exists' }, 409);
      const agent = {
        id: body.id.trim(),
        name: body.name.trim(),
        avatar: body.avatar?.trim() || '🤖',
        manager: body.manager ?? false,
        defaultAutonomy: body.defaultAutonomy ?? 'approval',
        agentFile: `agents/${body.id.trim()}.md`,
        enabled: body.enabled ?? true,
      };
      catalogAgents.set(agent.id, agent);
      return respond(agent, 201);
    }

    if (method === 'POST' && pathname === '/api/catalog/agents/upload') {
      if (!body.id || !body.id.trim()) return respond({ error: 'id is required' }, 400);
      if (!body.contentBase64) return respond({ error: 'contentBase64 is required' }, 400);
      if (catalogAgents.has(body.id)) return respond({ error: 'already exists' }, 409);
      const agent = {
        id: body.id.trim(),
        name: body.name?.trim() || body.id.trim(),
        avatar: body.avatar?.trim() || '🤖',
        manager: body.manager ?? false,
        defaultAutonomy: body.defaultAutonomy ?? 'approval',
        agentFile: `agents/${body.id.trim()}.md`,
        enabled: body.enabled ?? true,
      };
      catalogAgents.set(agent.id, agent);
      return respond(agent, 201);
    }

    const catalogAgentEnableMatch = method === 'POST' && pathname.match(/^\/api\/catalog\/agents\/([^/]+)\/(enable|disable)$/);
    if (catalogAgentEnableMatch) {
      const agent = catalogAgents.get(catalogAgentEnableMatch[1]);
      if (!agent) return respond({ error: 'not found' }, 404);
      agent.enabled = catalogAgentEnableMatch[2] === 'enable';
      return respond(agent);
    }

    const catalogAgentGetMatch = method === 'GET' && pathname.match(/^\/api\/catalog\/agents\/([^/]+)$/);
    if (catalogAgentGetMatch) {
      const agent = catalogAgents.get(catalogAgentGetMatch[1]);
      if (!agent) return respond({ error: 'not found' }, 404);
      return respond(agent);
    }

    const catalogAgentPutMatch = method === 'PUT' && pathname.match(/^\/api\/catalog\/agents\/([^/]+)$/);
    if (catalogAgentPutMatch) {
      const agent = catalogAgents.get(catalogAgentPutMatch[1]);
      if (!agent) return respond({ error: 'not found' }, 404);
      Object.assign(agent, {
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.avatar !== undefined && { avatar: body.avatar.trim() || '🤖' }),
        ...(body.manager !== undefined && { manager: body.manager }),
        ...(body.defaultAutonomy !== undefined && { defaultAutonomy: body.defaultAutonomy }),
      });
      return respond(agent);
    }

    const catalogAgentDeleteMatch = method === 'DELETE' && pathname.match(/^\/api\/catalog\/agents\/([^/]+)$/);
    if (catalogAgentDeleteMatch) {
      if (!catalogAgents.has(catalogAgentDeleteMatch[1])) return respond({ error: 'not found' }, 404);
      catalogAgents.delete(catalogAgentDeleteMatch[1]);
      return respond(undefined, 204);
    }

    // ---- Catalog: skills, mirrors server/src/catalog/catalogService.ts's SkillRecord shape ----

    if (method === 'GET' && pathname === '/api/catalog/skills') {
      return respond([...catalogSkills.values()]);
    }

    if (method === 'POST' && pathname === '/api/catalog/skills') {
      if (!body.id || !body.id.trim()) return respond({ error: 'id is required' }, 400);
      if (!body.name || !body.name.trim()) return respond({ error: 'name is required' }, 400);
      if (!body.description || !body.description.trim()) return respond({ error: 'description is required' }, 400);
      if (catalogSkills.has(body.id)) return respond({ error: 'already exists' }, 409);
      const skill = {
        id: body.id.trim(),
        name: body.name.trim(),
        description: body.description.trim(),
        triggers: body.triggers ?? [],
        avatar: body.avatar?.trim() || '🧩',
        enabled: body.enabled ?? true,
        skillDir: `skills/${body.id.trim()}`,
        supportFiles: [],
      };
      catalogSkills.set(skill.id, skill);
      return respond(skill, 201);
    }

    if (method === 'POST' && pathname === '/api/catalog/skills/upload') {
      if (!body.id || !body.id.trim()) return respond({ error: 'id is required' }, 400);
      if (!body.contentBase64) return respond({ error: 'contentBase64 is required' }, 400);
      if (catalogSkills.has(body.id)) return respond({ error: 'already exists' }, 409);
      const skill = {
        id: body.id.trim(),
        name: body.name?.trim() || body.id.trim(),
        description: 'Uploaded skill',
        triggers: body.triggers ?? [],
        avatar: body.avatar?.trim() || '🧩',
        enabled: body.enabled ?? true,
        skillDir: `skills/${body.id.trim()}`,
        supportFiles: [],
      };
      catalogSkills.set(skill.id, skill);
      return respond(skill, 201);
    }

    // Install-from-registry: kicks off `npx skills add <owner/repo>` for real in the daemon (see
    // server/src/catalog/skillInstall.ts) — this stub only ever returns the just-started 'running'
    // run. Tests that need a settled run simulate the 'skillInstall'/'skillInstallLog' WorkerEvents directly.
    if (method === 'POST' && pathname === '/api/catalog/skills/install') {
      if (!body.repo || !body.repo.trim()) return respond({ error: 'repo is required' }, 400);
      if (!REPO_SLUG_PATTERN.test(body.repo.trim())) return respond({ error: `"${body.repo}" is not a valid "owner/repo" GitHub slug` }, 400);
      const run = {
        id: `test-install-${nextId++}`,
        repo: body.repo.trim(),
        status: 'running',
        output: '',
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      skillInstallRuns.set(run.id, run);
      return respond(run, 201);
    }

    const catalogSkillInstallGetMatch = method === 'GET' && pathname.match(/^\/api\/catalog\/skills\/install\/([^/]+)$/);
    if (catalogSkillInstallGetMatch) {
      const run = skillInstallRuns.get(catalogSkillInstallGetMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      return respond(run);
    }

    const catalogSkillEnableMatch = method === 'POST' && pathname.match(/^\/api\/catalog\/skills\/([^/]+)\/(enable|disable)$/);
    if (catalogSkillEnableMatch) {
      const skill = catalogSkills.get(catalogSkillEnableMatch[1]);
      if (!skill) return respond({ error: 'not found' }, 404);
      skill.enabled = catalogSkillEnableMatch[2] === 'enable';
      return respond(skill);
    }

    const catalogSkillFileAddMatch = method === 'POST' && pathname.match(/^\/api\/catalog\/skills\/([^/]+)\/files$/);
    if (catalogSkillFileAddMatch) {
      const skill = catalogSkills.get(catalogSkillFileAddMatch[1]);
      if (!skill) return respond({ error: 'not found' }, 404);
      if (!body.name || !body.name.trim()) return respond({ error: 'name is required' }, 400);
      if (!body.contentBase64) return respond({ error: 'contentBase64 is required' }, 400);
      skill.supportFiles = [...new Set([...skill.supportFiles, body.name.trim()])].sort();
      return respond(skill, 201);
    }

    const catalogSkillFileRemoveMatch = method === 'DELETE' && pathname.match(/^\/api\/catalog\/skills\/([^/]+)\/files\/([^/]+)$/);
    if (catalogSkillFileRemoveMatch) {
      const skill = catalogSkills.get(catalogSkillFileRemoveMatch[1]);
      if (!skill) return respond({ error: 'not found' }, 404);
      skill.supportFiles = skill.supportFiles.filter((f) => f !== decodeURIComponent(catalogSkillFileRemoveMatch[2]));
      return respond(skill);
    }

    const catalogSkillGetMatch = method === 'GET' && pathname.match(/^\/api\/catalog\/skills\/([^/]+)$/);
    if (catalogSkillGetMatch) {
      const skill = catalogSkills.get(catalogSkillGetMatch[1]);
      if (!skill) return respond({ error: 'not found' }, 404);
      return respond(skill);
    }

    const catalogSkillPutMatch = method === 'PUT' && pathname.match(/^\/api\/catalog\/skills\/([^/]+)$/);
    if (catalogSkillPutMatch) {
      const skill = catalogSkills.get(catalogSkillPutMatch[1]);
      if (!skill) return respond({ error: 'not found' }, 404);
      Object.assign(skill, {
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.description !== undefined && { description: body.description.trim() }),
        ...(body.avatar !== undefined && { avatar: body.avatar.trim() || '🧩' }),
        ...(body.triggers !== undefined && { triggers: body.triggers }),
      });
      return respond(skill);
    }

    const catalogSkillDeleteMatch = method === 'DELETE' && pathname.match(/^\/api\/catalog\/skills\/([^/]+)$/);
    if (catalogSkillDeleteMatch) {
      if (!catalogSkills.has(catalogSkillDeleteMatch[1])) return respond({ error: 'not found' }, 404);
      catalogSkills.delete(catalogSkillDeleteMatch[1]);
      return respond(undefined, 204);
    }

    // ---- Catalog: Workflows (task 3.012), mirrors server/src/catalog/workflowService.ts's WorkflowRecord shape ----

    if (method === 'GET' && pathname === '/api/catalog/workflows') {
      return respond([...workflows.values()]);
    }

    if (method === 'POST' && pathname === '/api/catalog/workflows') {
      if (!body.id || !body.id.trim()) return respond({ error: 'id is required' }, 400);
      if (!body.name || !body.name.trim()) return respond({ error: 'name is required' }, 400);
      if (!body.description || !body.description.trim()) return respond({ error: 'description is required' }, 400);
      if (workflows.has(body.id)) return respond({ error: 'already exists' }, 409);
      if (!Array.isArray(body.steps) || body.steps.length === 0) return respond({ error: 'steps must include at least one step' }, 400);
      const workflow = {
        id: body.id.trim(),
        name: body.name.trim(),
        description: body.description.trim(),
        enabled: body.enabled ?? true,
        steps: body.steps,
      };
      workflows.set(workflow.id, workflow);
      return respond(workflow, 201);
    }

    const workflowGetMatch = method === 'GET' && pathname.match(/^\/api\/catalog\/workflows\/([^/]+)$/);
    if (workflowGetMatch) {
      const workflow = workflows.get(workflowGetMatch[1]);
      if (!workflow) return respond({ error: 'not found' }, 404);
      return respond(workflow);
    }

    const workflowPutMatch = method === 'PUT' && pathname.match(/^\/api\/catalog\/workflows\/([^/]+)$/);
    if (workflowPutMatch) {
      const workflow = workflows.get(workflowPutMatch[1]);
      if (!workflow) return respond({ error: 'not found' }, 404);
      Object.assign(workflow, {
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.description !== undefined && { description: body.description.trim() }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        ...(body.steps !== undefined && { steps: body.steps }),
      });
      return respond(workflow);
    }

    const workflowDeleteMatch = method === 'DELETE' && pathname.match(/^\/api\/catalog\/workflows\/([^/]+)$/);
    if (workflowDeleteMatch) {
      if (!workflows.has(workflowDeleteMatch[1])) return respond({ error: 'not found' }, 404);
      workflows.delete(workflowDeleteMatch[1]);
      // Mirrors workflowService.ts's deleteWorkflow: resets every Project that had selected it back to the Catalog default.
      for (const project of projects.values()) if (project.workflowId === workflowDeleteMatch[1]) project.workflowId = null;
      return respond(undefined, 204);
    }

    // ---- Global Google OAuth client (mirrors server/src/api/seoRoutes.ts; write-only) ----

    if (pathname === '/api/settings/google-oauth-client') {
      googleClient.requests.push({ method, body });
      if (googleClient.fail) { const status = googleClient.fail; googleClient.fail = null; return respond({ error: 'The daemon refused the request' }, status); }
      if (method === 'GET') return respond({ saved: googleClient.saved });
      if (method === 'PUT') {
        if (typeof body?.clientId !== 'string' || !body.clientId.trim() || typeof body?.clientSecret !== 'string' || !body.clientSecret.trim()) return respond({ error: 'clientId and clientSecret are required' }, 400);
        googleClient.saved = true;
        return respond({ saved: true });
      }
      if (method === 'DELETE') { googleClient.saved = false; return respond(undefined, 204); }
    }

    // ---- GitHub accounts (mirrors server/src/api/router.ts; no route ever carries a token) ----

    if (method === 'GET' && pathname === '/api/github/accounts') return respond(githubAccounts);
    const githubIdentityMatch = pathname.match(/^\/api\/github\/accounts\/([^/]+)\/identity$/);
    if (githubIdentityMatch && (method === 'PUT' || method === 'DELETE')) {
      const account = githubAccounts.accounts.find((candidate) => candidate.login === githubIdentityMatch[1]);
      if (!account) return respond({ error: 'That is not a valid GitHub username.' }, 400);
      if (method === 'PUT') {
        if (!String(body.name ?? '').trim() || !String(body.email ?? '').includes('@')) return respond({ error: 'Enter a valid commit email address.' }, 400);
        account.identity = { name: body.name.trim(), email: body.email.trim() };
        account.hasCustomIdentity = true;
      } else {
        account.identity = { name: account.login, email: `${account.login}@users.noreply.github.com` };
        account.hasCustomIdentity = false;
      }
      return respond(githubAccounts);
    }
    const projectGithubMatch = method === 'PATCH' && pathname.match(/^\/api\/projects\/([^/]+)\/github-account$/);
    if (projectGithubMatch) {
      const project = projects.get(projectGithubMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      if (body.githubAccount !== null && !githubAccounts.accounts.some((account) => account.login === body.githubAccount)) return respond({ error: 'GitHub account was not found in the GitHub CLI.' }, 400);
      project.githubAccount = body.githubAccount;
      return respond(project);
    }
    const projectGithubCheckMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/github-account\/check$/);
    if (projectGithubCheckMatch) {
      const project = projects.get(projectGithubCheckMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      return respond(githubAccountChecks.get(project.id) ?? { status: 'ok', account: project.githubAccount ?? null, repository: 'o/r', ownerMismatch: false, blocks: false, message: 'ok', checkedAt: 'now' });
    }

    const projectGitProviderMatch = method === 'PATCH' && pathname.match(/^\/api\/projects\/([^/]+)\/git-provider$/);
    if (projectGitProviderMatch) {
      const project = projects.get(projectGitProviderMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      if (body.gitProvider !== 'github') return respond({ error: `Unsupported Git provider: ${body.gitProvider}` }, 400);
      project.gitProvider = body.gitProvider;
      return respond(project);
    }

    const projectAutoPullMatch = method === 'PATCH' && pathname.match(/^\/api\/projects\/([^/]+)\/auto-pull$/);
    if (projectAutoPullMatch) {
      const project = projects.get(projectAutoPullMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      if (typeof body.autoPullEnabled !== 'boolean') return respond({ error: 'autoPullEnabled must be a boolean' }, 400);
      project.autoPullEnabled = body.autoPullEnabled;
      return respond(project);
    }

    // ---- Project workflow selection (task 3.012) ----

    const projectWorkflowMatch = method === 'PATCH' && pathname.match(/^\/api\/projects\/([^/]+)\/workflow$/);
    if (projectWorkflowMatch) {
      const project = projects.get(projectWorkflowMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      if (body.workflowId !== null && !workflows.has(body.workflowId)) return respond({ error: 'not found' }, 404);
      project.workflowId = body.workflowId;
      return respond(project);
    }

    // ---- Workflow runs (task 3.012), mirrors server/src/domain/types.ts's WorkflowRunRecord/StepRunRecord shape ----

    const workflowRunsListMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/workflow-runs$/);
    if (workflowRunsListMatch) {
      if (!projects.has(workflowRunsListMatch[1])) return respond({ error: 'not found' }, 404);
      return respond([...workflowRuns.values()]
        .filter((r) => r.projectId === workflowRunsListMatch[1])
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }

    const workflowRunGetMatch = method === 'GET' && pathname.match(/^\/api\/workflow-runs\/([^/]+)$/);
    if (workflowRunGetMatch) {
      const run = workflowRuns.get(workflowRunGetMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      const steps = (run.workflowSnapshot?.steps ?? []).map((step) => ({
        step,
        rounds: [...stepRuns.values()].filter((s) => s.runId === run.id && s.stepId === step.id),
      }));
      return respond({ run, steps });
    }

    const reopenOptionsMatch = method === 'GET' && pathname.match(/^\/api\/tasks\/([^/]+)\/reopen-session\/options$/);
    const reopenMatch = method === 'POST' && pathname.match(/^\/api\/tasks\/([^/]+)\/reopen-session$/);
    const closeReopenMatch = method === 'DELETE' && pathname.match(/^\/api\/tasks\/([^/]+)\/reopen-session$/);
    if (reopenOptionsMatch || reopenMatch || closeReopenMatch) {
      const taskId = (reopenOptionsMatch || reopenMatch || closeReopenMatch)[1];
      const task = tasksById.get(taskId);
      const run = task?.workflowRunId ? workflowRuns.get(task.workflowRunId) : null;
      if (!task || !run) return respond({ error: 'not found' }, 404);
      if (closeReopenMatch) {
        if (!reopenedTasks.delete(taskId)) return respond({ error: 'no reopened session' }, 409);
        return respond(null, 204);
      }
      if (!task.sessionId || task.status === 'developing' || task.status === 'blocked' || run.pendingInspectChanges) return respond({ error: 'step session cannot be reopened' }, 409);
      const step = run.workflowSnapshot.steps.find((entry) => entry.id === task.workflowStepId);
      const choiceRequired = run.status === 'completed' && !!step?.canEditCode;
      const permissionsAvailable = !run.branchMissing;
      if (reopenOptionsMatch) return respond({ choiceRequired, permissionsAvailable, ...(permissionsAvailable ? {} : { reason: `Branch "${run.branch}" is gone locally and on the remote.` }) });
      if (body?.mode !== undefined && body.mode !== 'permissions' && body.mode !== 'read-only') return respond({ error: 'mode must be permissions or read-only' }, 400);
      if (choiceRequired && !body?.mode) return respond({ error: 'choose a reopen mode' }, 409);
      if (body?.mode === 'permissions' && !permissionsAvailable) return respond({ error: `Branch "${run.branch}" is gone` }, 409);
      if (reopenedTasks.has(taskId)) return respond({ error: 'already open' }, 409);
      reopenedTasks.add(taskId);
      return respond({ location: run.worktreePath && permissionsAvailable ? 'recreated-worktree' : 'project', mode: body?.mode ?? (step?.canEditCode && permissionsAvailable ? 'permissions' : 'read-only') }, 201);
    }

    const reopenChangesMatch = method === 'POST' && pathname.match(/^\/api\/workflow-runs\/([^/]+)\/reopen-changes$/);
    if (reopenChangesMatch) {
      const run = workflowRuns.get(reopenChangesMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      if (body?.decision !== 'commit-push' && body?.decision !== 'discard') return respond({ error: 'decision must be commit-push or discard' }, 400);
      if (!run.pendingInspectChanges) return respond({ error: 'no reopened changes' }, 409);
      run.pendingInspectChanges = null;
      return respond(run);
    }

    const workflowRunApproveMatch = method === 'POST' && pathname.match(/^\/api\/workflow-runs\/([^/]+)\/approve$/);
    if (workflowRunApproveMatch) {
      const run = workflowRuns.get(workflowRunApproveMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      run.status = 'running';
      run.updatedAt = new Date().toISOString();
      return respond(run);
    }

    const workflowRunRequestChangesMatch = method === 'POST' && pathname.match(/^\/api\/workflow-runs\/([^/]+)\/request-changes$/);
    if (workflowRunRequestChangesMatch) {
      const run = workflowRuns.get(workflowRunRequestChangesMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      if (!body.comment || !body.comment.trim()) return respond({ error: 'comment is required' }, 400);
      run.status = 'running';
      run.updatedAt = new Date().toISOString();
      return respond(run);
    }

    const workflowRunLoopMatch = method === 'POST' && pathname.match(/^\/api\/workflow-runs\/([^/]+)\/loop$/);
    if (workflowRunLoopMatch) {
      const run = workflowRuns.get(workflowRunLoopMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      if (body.action === 'another-round') run.loopRoundAllowance += 1;
      run.status = 'running';
      run.updatedAt = new Date().toISOString();
      return respond(run);
    }

    const workflowRunRetryMatch = method === 'POST' && pathname.match(/^\/api\/workflow-runs\/([^/]+)\/retry-step$/);
    if (workflowRunRetryMatch) {
      const run = workflowRuns.get(workflowRunRetryMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      run.status = 'running';
      run.updatedAt = new Date().toISOString();
      return respond(run);
    }

    const workflowRunStopMatch = method === 'POST' && pathname.match(/^\/api\/workflow-runs\/([^/]+)\/stop$/);
    if (workflowRunStopMatch) {
      const run = workflowRuns.get(workflowRunStopMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      if (run.status === 'completed' || run.status === 'stopped') return respond({ error: `run cannot be stopped while ${run.status}` }, 409);
      run.status = 'stopped';
      run.updatedAt = new Date().toISOString();
      return respond(run);
    }

    // Mirrors the resume route: only a stopped run resumes (409 otherwise), back to running.
    const workflowRunResumeMatch = method === 'POST' && pathname.match(/^\/api\/workflow-runs\/([^/]+)\/resume$/);
    if (workflowRunResumeMatch) {
      const run = workflowRuns.get(workflowRunResumeMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      if (run.status !== 'stopped') return respond({ error: `run cannot be resumed while ${run.status}` }, 409);
      run.status = 'running';
      run.updatedAt = new Date().toISOString();
      return respond(run);
    }

    // ---- Notifications (docs/milestones/milestone-5-notification-system.md) ----

    if (method === 'GET' && pathname === '/api/notifications') {
      const resolvedParam = searchParams.get('resolved');
      const readParam = searchParams.get('read');
      const severity = searchParams.get('severity');
      const projectId = searchParams.get('projectId');
      const filter = {
        resolved: resolvedParam === 'true' ? true : resolvedParam === 'false' ? false : undefined,
        read: readParam === 'true' ? true : readParam === 'false' ? false : undefined,
        severity: severity || undefined,
        projectId: projectId || undefined,
      };
      return respond([...notifications.values()]
        .filter((n) => matchesNotificationFilter(n, filter))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }

    if (method === 'POST' && pathname === '/api/notifications') {
      if (!body.kind) return respond({ error: 'kind is required' }, 400);
      if (!body.subject) return respond({ error: 'subject is required' }, 400);
      if (!body.title || !body.title.trim()) return respond({ error: 'title is required' }, 400);
      if (!body.description || !body.description.trim()) return respond({ error: 'description is required' }, 400);
      return respond(raiseNotification({ kind: body.kind, subject: body.subject, title: body.title.trim(), description: body.description.trim() }), 201);
    }

    if (method === 'POST' && pathname === '/api/notifications/read') {
      let ids = body.ids;
      if (!ids && body.subject) ids = [...notifications.values()].filter((n) => sameSubjectIdentity(n.subject, body.subject)).map((n) => n.id);
      if (!ids) return respond({ error: 'either ids or subject is required' }, 400);
      const now = new Date().toISOString();
      for (const id of ids) {
        const n = notifications.get(id);
        if (!n) continue;
        n.readAt = n.readAt ?? now;
        if (n.kind === 'task.completed' && n.resolvedAt === null) n.resolvedAt = now;
        n.updatedAt = now;
      }
      return respond(undefined, 204);
    }

    const notificationUnreadMatch = method === 'POST' && pathname.match(/^\/api\/notifications\/([^/]+)\/unread$/);
    if (notificationUnreadMatch) {
      const notification = notifications.get(notificationUnreadMatch[1]);
      if (!notification) return respond({ error: 'not found' }, 404);
      notification.readAt = null;
      notification.updatedAt = new Date().toISOString();
      return respond(undefined, 204);
    }

    if (method === 'POST' && pathname === '/api/notifications/read-all') {
      const now = new Date().toISOString();
      for (const n of notifications.values()) {
        if (!matchesNotificationFilter(n, body ?? {})) continue;
        n.readAt = n.readAt ?? now;
        if (n.kind === 'task.completed' && n.resolvedAt === null) n.resolvedAt = now;
        n.updatedAt = now;
      }
      return respond(undefined, 204);
    }

    // ---- Testing tab (task 2.006), backed by testing/setup.ts (task 2.005) and testing/testRunner.ts ----

    const testingConfigMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/testing\/config$/);
    if (testingConfigMatch) {
      if (!projects.has(testingConfigMatch[1])) return respond({ error: 'not found' }, 404);
      return respond(testingConfigState(testingConfigMatch[1]));
    }

    const testingOverviewMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/testing$/);
    if (testingOverviewMatch) {
      if (!projects.has(testingOverviewMatch[1])) return respond({ error: 'not found' }, 404);
      return respond(buildTestingOverview(testingOverviewMatch[1]));
    }

    const testingSetupGetMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/testing\/setup$/);
    if (testingSetupGetMatch) {
      const project = projects.get(testingSetupGetMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      const planItem = testingSetupPlanItem(project.id);
      if (!planItem) return respond(null);
      const run = [...workflowRuns.values()].find((r) => r.planItemId === planItem.id) ?? null;
      const active = run ? !['completed', 'failed', 'stopped'].includes(run.status) : true;
      return respond({ planItem, run, queueEntry: null, active });
    }

    const testingSetupStartMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/testing\/setup$/);
    if (testingSetupStartMatch) {
      const project = projects.get(testingSetupStartMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      const existingItem = testingSetupPlanItem(project.id);
      const existingRun = existingItem ? [...workflowRuns.values()].find((r) => r.planItemId === existingItem.id) : null;
      if (existingItem && existingRun && !['completed', 'failed', 'stopped'].includes(existingRun.status)) {
        return respond({ existing: true, planItem: existingItem, run: existingRun, queueEntry: null });
      }
      const configBefore = testingConfigState(project.id);
      const mode = configBefore.state === 'valid' ? 'reconfigure' : configBefore.state === 'invalid' ? 'repair' : 'setup';
      const planItem = {
        id: `test-plan-item-${nextId++}`,
        projectId: project.id,
        title: 'Set up testing',
        description: '',
        status: 'developing',
        order: [...planItems.values()].filter((i) => i.projectId === project.id).length,
        taskIds: [],
        testingSetup: { mode },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      planItems.set(planItem.id, planItem);
      const run = {
        id: `test-workflow-run-${nextId++}`,
        projectId: project.id,
        planItemId: planItem.id,
        workflowId: 'testing-setup',
        workflowSnapshot: { steps: TESTING_SETUP_STEPS },
        status: 'awaiting-approval',
        currentStepId: 'proposal',
        branch: null,
        prUrl: null,
        completionReport: null,
        attentionReason: null,
        attentionNotificationId: null,
        loopRoundAllowance: 0,
        testingSetup: { mode, evidence: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
      };
      workflowRuns.set(run.id, run);
      stepRuns.set(`${run.id}:proposal:1`, {
        id: `${run.id}:proposal:1`, runId: run.id, stepId: 'proposal', round: 1, taskId: null, status: 'awaiting-approval',
        summary: `Detected \`npm test\` under the project root.\n\nAdds \`${TESTING_CONFIG_PATH}\` mapping 1 suite: **Unit tests**, with primary action \`npm test\`.\n\nNo files will change on disk until you approve.`,
        outputs: [], verdict: null, skippedReason: null, approval: null, createdAt: new Date().toISOString(), completedAt: null,
      });
      return respond({ existing: false, planItem, run, queueEntry: null }, 201);
    }

    function requireTestingSetupRun(runId) {
      const run = workflowRuns.get(runId);
      if (!run) return { error: respond({ error: 'not found' }, 404) };
      if (!run.testingSetup) return { error: respond({ error: `Workflow run "${runId}" is not a testing setup.` }, 409) };
      return { run };
    }

    const testingSetupApproveMatch = method === 'POST' && pathname.match(/^\/api\/testing-setup\/([^/]+)\/approve$/);
    if (testingSetupApproveMatch) {
      const { run, error } = requireTestingSetupRun(testingSetupApproveMatch[1]);
      if (error) return error;
      if (run.status !== 'awaiting-approval') return respond({ error: `Workflow run "${run.id}" is not awaiting approval.` }, 409);
      const currentRound = [...stepRuns.values()].filter((s) => s.runId === run.id && s.stepId === 'proposal').length;
      if (body.proposalRound !== currentRound) return respond({ error: `Proposal round ${body.proposalRound} is not the one awaiting approval (round ${currentRound} is).` }, 409);
      // Approving a read-only proposal step, in this stub, completes the whole setup immediately
      // (implementation has nothing async to simulate) — the project's testing config becomes valid.
      testingConfigs.set(run.projectId, { state: 'valid', path: TESTING_CONFIG_PATH, config: DEFAULT_TESTING_CONFIG });
      run.status = 'completed';
      run.currentStepId = null;
      run.branch = 'task/set-up-testing';
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      run.testingSetup = { ...run.testingSetup, evidence: { ok: true, checkedAt: run.completedAt, config: { state: 'valid', suiteCount: 1, issues: [] }, actions: [], problems: [] } };
      const planItem = planItems.get(run.planItemId);
      if (planItem) { planItem.status = 'done'; planItem.updatedAt = run.completedAt; }
      return respond(run);
    }

    const testingSetupReviseMatch = method === 'POST' && pathname.match(/^\/api\/testing-setup\/([^/]+)\/revise$/);
    if (testingSetupReviseMatch) {
      const { run, error } = requireTestingSetupRun(testingSetupReviseMatch[1]);
      if (error) return error;
      if (!body.comment || !body.comment.trim()) return respond({ error: 'comment is required' }, 400);
      if (run.status !== 'awaiting-approval') return respond({ error: `Workflow run "${run.id}" is not awaiting approval.` }, 409);
      const nextRound = [...stepRuns.values()].filter((s) => s.runId === run.id && s.stepId === 'proposal').length + 1;
      stepRuns.set(`${run.id}:proposal:${nextRound}`, {
        id: `${run.id}:proposal:${nextRound}`, runId: run.id, stepId: 'proposal', round: nextRound, taskId: null, status: 'awaiting-approval',
        summary: `Revised per feedback: "${body.comment.trim()}".\n\nStill read-only — no files will change on disk until you approve.`,
        outputs: [], verdict: null, skippedReason: null, approval: { decision: 'changes-requested', comment: body.comment.trim(), at: new Date().toISOString() },
        createdAt: new Date().toISOString(), completedAt: null,
      });
      run.updatedAt = new Date().toISOString();
      return respond(run);
    }

    const testingSetupRejectMatch = method === 'POST' && pathname.match(/^\/api\/testing-setup\/([^/]+)\/reject$/);
    if (testingSetupRejectMatch) {
      const { run, error } = requireTestingSetupRun(testingSetupRejectMatch[1]);
      if (error) return error;
      run.status = 'stopped';
      run.updatedAt = new Date().toISOString();
      const planItem = planItems.get(run.planItemId);
      if (planItem) { planItem.status = 'stopped'; planItem.updatedAt = run.updatedAt; }
      return respond(run);
    }

    const testRunsListMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/test-runs$/);
    if (testRunsListMatch) {
      const projectId = testRunsListMatch[1];
      if (!projects.has(projectId)) return respond({ error: 'not found' }, 404);
      const status = searchParams.get('status');
      const suiteId = searchParams.get('suiteId');
      const actionId = searchParams.get('actionId');
      const limit = Number(searchParams.get('limit') ?? 10);
      const offset = Number(searchParams.get('offset') ?? 0);
      const unopened = searchParams.get('failureUnopened');
      if (unopened !== null && unopened !== 'true') return respond({ error: 'failureUnopened must be "true"' }, 400);
      if (unopened) await unopenedListGate.wait?.();
      const matching = [...testRuns.values()]
        .filter((r) => r.projectId === projectId
          && (!unopened || r.failureUnopened === true)
          && (!status || r.status === status)
          && (!suiteId || r.suite.id === suiteId)
          && (!actionId || r.action.id === actionId))
        .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
      const runs = matching.slice(offset, offset + limit).map(({ output: _output, result: _result, ...run }) => run);
      return respond({ runs, total: matching.length, limit, offset });
    }

    const testRunCreateMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/test-runs$/);
    if (testRunCreateMatch) {
      const project = projects.get(testRunCreateMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      const config = testingConfigState(project.id);
      const found = findSuiteAction(config, body.suiteId, body.actionId);
      if (!found) return respond({ error: `No action "${body.actionId}" on suite "${body.suiteId}"` }, 404);
      const alreadyActive = [...testRuns.values()].some((r) => r.projectId === project.id && r.suite.id === found.suite.id && r.action.id === found.action.id && (r.status === 'queued' || r.status === 'running'));
      if (alreadyActive) return respond({ error: `${found.suite.id}/${found.action.id} is already queued or running` }, 409);
      const { output: _output, result: _result, ...run } = makeTestRun(project, found.suite, found.action, { trigger: body.trigger ?? 'manual', taskId: body.taskId ?? null });
      return respond(run, 201);
    }

    const testRunAllMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/test-runs\/run-all$/);
    if (testRunAllMatch) {
      const project = projects.get(testRunAllMatch[1]);
      if (!project) return respond({ error: 'not found' }, 404);
      const config = testingConfigState(project.id);
      if (config.state !== 'valid') return respond({ error: 'The testing config is not valid' }, 409);
      const batchId = `test-batch-${nextId++}`;
      const runs = [];
      for (const suite of config.config.suites) {
        if (!suite.enabled) continue;
        const action = suite.actions.find((a) => a.id === suite.primaryActionId);
        if (!action || !action.enabled) continue;
        const alreadyActive = [...testRuns.values()].some((r) => r.projectId === project.id && r.suite.id === suite.id && r.action.id === action.id && (r.status === 'queued' || r.status === 'running'));
        if (alreadyActive) continue;
        const { output: _output, result: _result, ...run } = makeTestRun(project, suite, action, { trigger: body.trigger ?? 'manual' });
        run.batchId = batchId;
        testRuns.get(run.id).batchId = batchId;
        runs.push(run);
      }
      return respond({ batchId, runs }, 201);
    }

    const testRunGetMatch = method === 'GET' && pathname.match(/^\/api\/test-runs\/([^/]+)$/);
    if (testRunGetMatch) {
      const run = testRuns.get(testRunGetMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      return respond(run);
    }

    const testRunOpenedMatch = method === 'POST' && pathname.match(/^\/api\/test-runs\/([^/]+)\/opened$/);
    if (testRunOpenedMatch) {
      const run = testRuns.get(testRunOpenedMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      openedRequests.push(run.id);
      if (openedFailure) return respond({ error: openedFailure }, 500);
      delete run.failureUnopened;
      const { output: _output, result: _result, ...record } = run;
      return respond(record);
    }

    const testRunStopMatch = method === 'POST' && pathname.match(/^\/api\/test-runs\/([^/]+)\/stop$/);
    if (testRunStopMatch) {
      const run = testRuns.get(testRunStopMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      if (run.status !== 'running' && run.status !== 'queued') return respond({ error: `Test run "${run.id}" is not running.` }, 409);
      run.status = 'stopped';
      run.completedAt = new Date().toISOString();
      run.durationMs = run.startedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : null;
      return respond(run);
    }

    const testRunDeleteMatch = method === 'DELETE' && pathname.match(/^\/api\/test-runs\/([^/]+)$/);
    if (testRunDeleteMatch) {
      const run = testRuns.get(testRunDeleteMatch[1]);
      if (!run) return respond({ error: 'not found' }, 404);
      if (run.status !== 'queued') return respond({ error: `Test run "${run.id}" is not queued.` }, 409);
      testRuns.delete(testRunDeleteMatch[1]);
      return respond(undefined, 204);
    }

    const contentMatch = pathname.match(/^\/api\/projects\/([^/]+)\/content\/(.+)$/);
    if (contentMatch) {
      const answer = await contentStudioRoute(content, contentMatch[1], method, contentMatch[2], body, searchParams);
      return respond(answer.body, answer.status);
    }

    const seoMatch = pathname.match(/^\/api\/projects\/([^/]+)\/seo\/(.+)$/);
    if (seoMatch) {
      const [, projectId, rest] = seoMatch;
      const st = seo.byProject.get(projectId);
      if (!st) return respond({ error: 'This is not an SEO Building' }, 404);
      seo.requests.push({ method, rest, body });
      const backlinksAnswer = await seoBacklinksRoute(st, method, rest, body, searchParams);
      if (backlinksAnswer) return respond(backlinksAnswer.body, backlinksAnswer.status);
      const linksAnswer = await seoLinksRoute(st, method, rest, body, searchParams);
      if (linksAnswer) return respond(linksAnswer.body, linksAnswer.status);
      const keywordsAnswer = await seoKeywordsRoute(st, method, rest, body, searchParams);
      if (keywordsAnswer) return respond(keywordsAnswer.body, keywordsAnswer.status);
      const reportsAnswer = await seoReportsRoute(st, method, rest, body, searchParams);
      if (reportsAnswer) return respond(reportsAnswer.body, reportsAnswer.status);
      const coverage = (state = 'full') => ({ current: { covered: 28, total: 28, state }, previous: { covered: 28, total: 28, state } });
      const metrics = (clicks) => ({ clicks, impressions: clicks === null ? null : clicks * 10, ctr: clicks === null ? null : 0.1, position: clicks === null ? null : 4.2, sessions: null, keyEvents: null });
      if (method === 'GET' && rest === 'pages') {
        await seo.pagesGate?.(searchParams);
        const sort = searchParams.get('sort') ?? 'clicks';
        const row = (path, clicks) => ({ url: `https://example.com${path}`, path, sources: { gsc: true, ga4: false, sitemaps: 1 }, current: metrics(clicks), previous: metrics(clicks === null ? null : 5), delta: { clicks: clicks === null ? null : { abs: clicks - 5, pct: (clicks - 5) / 5, isNew: false }, impressions: null, ctr: null, position: null, sessions: null, keyEvents: null } });
        return respond({ range: { from: '2026-02-15', to: '2026-03-14' }, previousRange: { from: '2026-01-18', to: '2026-02-14' }, gsc: { connected: Boolean(st.property), coverage: coverage() }, ga4: { connected: false, coverage: coverage('none') }, total: 2, offset: 0, limit: 50, capped: false, rows: [row(`/${sort}`, 12), row('/gap', null)] });
      }
      if (method === 'GET' && rest === 'pages/detail') {
        const trend = Array.from({ length: 4 }, (_, i) => ({ day: `2026-03-0${i + 1}`, period: 'current', ...metrics(i === 2 ? null : i) }));
        return respond({ url: searchParams.get('url'), path: '/a', range: { from: '2026-02-15', to: '2026-03-14' }, previousRange: null, gsc: { connected: true, coverage: coverage() }, ga4: { connected: false, coverage: coverage('none') }, current: metrics(8), previous: null, delta: {}, trend, queries: { rows: [{ query: 'alpha', clicks: 5, impressions: 50, ctr: 0.1, position: 3 }], total: 1, showingFirst: null }, crawl: { available: false, title: null, description: null }, sitemaps: [{ url: 'https://example.com/sitemap.xml', lastmod: null }], indexing: { state: 'never', reason: null, raw: null, inspectedAt: null, waitingForQuota: false, error: null } });
      }
      const quota = { day: '2026-03-15', used: 1850, limit: 2000, manualReserve: 200, backgroundLimit: 1800, remaining: 150, exhausted: false, resetsAt: '2026-03-16T07:00:00.000Z' };
      if (method === 'GET' && rest === 'sitemaps') return respond({ notes: [], gsc: { state: st.property ? 'connected' : 'not-connected', error: null }, siteUrl: st.siteUrl, lastReadAt: null, quota, sitemaps: [{ url: 'https://example.com/sitemap.xml', kind: 'urlset', parent: null, sources: ['default'], status: 'ok', error: null, warnings: [], warningCount: 0, urlCount: 2, showingFirst: null, otherHostCount: 0, children: [], fetchedAt: '2026-03-15T00:00:00Z', gsc: null }] });
      if (method === 'POST' && (rest === 'sitemaps/read' || rest === 'sitemaps/reread')) {
        if (seo.sitemapsBusy) return respond({ error: 'Another sitemap action is running; try again when it finishes' }, 409);
        return respond({ read: 1, found: 1, gsc: 'connected', gscError: null, capped: false });
      }
      if (method === 'GET' && rest === 'sitemaps/urls') return respond({ total: 1, offset: 0, limit: 100, rows: [{ url: 'https://example.com/a', sitemaps: ['https://example.com/sitemap.xml'], lastmod: null, indexing: { state: 'never', reason: null, raw: null, inspectedAt: null, waitingForQuota: false, error: null }, indexNow: null, bing: { state: 'not-connected' } }] });
      if (method === 'POST' && rest === 'sitemaps/urls/inspect') return respond({ results: body.urls.map((url) => ({ url, status: 'inspected' })), quota });
      if (method === 'POST' && rest === 'sitemaps/bing-check') { seo.bingChecked = body.urls; return respond({ results: {} }); }
      if (rest === 'indexnow/key-check') return respond({ status: 'reachable', httpStatus: 200, keyFileName: 'abcd…ef.txt', checkedAt: '2026-03-15T00:00:00Z' });
      if (method === 'POST' && rest === 'indexnow/submit') {
        if (seo.submitRefused) return respond({ error: 'IndexNow submissions are limited to one per minute; try again shortly' }, 429);
        seo.log.unshift(...(body.urls ?? ['https://example.com/a']).map((url) => ({ at: '2026-03-15T12:00:00Z', batchId: 'b1', url, endpoint: 'api.indexnow.org', httpStatus: 200, result: 'accepted', message: 'Received by IndexNow. This is not a confirmation that the pages were indexed.' })));
        return respond({ total: seo.log.length, batches: 1, accepted: seo.log.length, rejected: 0, errors: 0, skippedOtherHost: 0, keyFile: 'reachable', keyFileWarning: false, retryAt: null });
      }
      if (method === 'GET' && rest === 'indexnow/log') return respond({ entries: seo.log, hasMore: false });
      if (method === 'GET' && rest === 'connections') return respond(seoView(projectId));
      if (method === 'POST' && /^connections\/(gsc|ga4|ads)\/connect$/.test(rest)) return respond({ authUrl: 'https://accounts.example/auth?state=abc' });
      if (method === 'GET' && rest === 'connections/gsc/properties') return respond({ properties: [{ id: 'https://example.com/', label: 'https://example.com/' }, { id: 'sc-domain:example.com', label: 'sc-domain:example.com' }] });
      if (method === 'PUT' && rest === 'connections/gsc/property') {
        if (st.property && st.property !== body.property && body.confirm !== true) return respond({ error: 'Changing the property needs confirmation.', requiresConfirmation: true }, 409);
        if (st.property && st.property !== body.property) st.previous = [...(st.previous ?? []), { service: 'gsc', property: st.property, replacedAt: new Date().toISOString() }];
        st.property = body.property;
        return respond(seoView(projectId));
      }
      if (method === 'DELETE' && rest.startsWith('connections/')) { st.property = null; st.syncing = false; return respond(seoView(projectId)); }
      if (method === 'POST' && rest === 'sync') {
        if (st.syncing) return respond({ error: 'A sync is already running for this Building' }, 409);
        st.syncing = true;
        return respond({ id: 'job-1', status: 'running' }, 202);
      }
      if (method === 'POST' && rest === 'sync/on-open') return respond({ started: false });
      if (method === 'GET' && rest === 'data') return respond({ bytes: 4096, warningBytes: 2 * 1024 ** 3, level: 'ok', ingestionStoppedReason: null, datasets: [{ id: 'gsc', label: 'Search Console', rows: 12, oldestDay: '2025-03-15', lastSyncAt: null }, { id: 'ga4', label: 'Analytics', rows: 0, oldestDay: null, lastSyncAt: null }], sync: null, retention: { months: 12, ackedMonths: st.acknowledged ? 12 : null, needsNotice: !st.acknowledged, description: 'Search Console and Analytics rows dated more than 12 months ago are discarded.', discarding: false, lastDiscardAt: null }, previousProperties: [] });
      if (method === 'GET' && rest === 'data/discard/preview') return respond({ months: 12, cutoff: '2025-03-15', total: 3, tables: [{ table: 'gsc_rows', label: 'Search Console rows', count: 3 }], acknowledged: st.acknowledged, note: 'Comparisons older than 12 months are not available.' });
      if (method === 'POST' && rest === 'data/discard/acknowledge') { st.acknowledged = true; return respond({ months: 12, cutoff: '2025-03-15', total: 3, tables: [], acknowledged: true, note: '' }); }
      if (method === 'POST' && rest === 'data/discard') {
        if (!st.acknowledged) return respond({ error: 'Review and acknowledge what will be discarded first', requiresAcknowledgement: true }, 409);
        return respond({ id: 'job-2', status: 'running' }, 202);
      }
      if (method === 'PATCH' && rest === 'data') {
        if (body.retentionMonths !== undefined && (!Number.isInteger(body.retentionMonths) || body.retentionMonths < 1 || body.retentionMonths > 36)) return respond({ error: 'retentionMonths must be a whole number from 1 to 36' }, 400);
        return respond({ bytes: 4096, warningBytes: body.warningBytes ?? 2 * 1024 ** 3, level: 'ok', ingestionStoppedReason: null, datasets: [], sync: null, retention: { months: body.retentionMonths ?? 12, ackedMonths: null, needsNotice: true, description: '', discarding: false, lastDiscardAt: null }, previousProperties: [] });
      }
      return respond({ error: 'not found' }, 404);
    }

    if (method === 'GET' && pathname === '/api/building-types') return respond(buildings.types);

    const typeConfigMatch = pathname.match(/^\/api\/building-types\/([^/]+)\/(config|slots\/([^/]+))$/);
    if (typeConfigMatch) {
      const type = buildings.types.find((t) => t.id === typeConfigMatch[1]);
      if (!type) return respond({ error: `Unknown Building type "${typeConfigMatch[1]}"` }, 404);
      const saved = buildings.configs.get(type.id) ?? {};
      const resolve = () => type.slots.map((slot) => {
        const mine = saved[slot.id] ?? { workflowId: null, stepAgents: {} };
        return { slot, configuredWorkflowId: mine.workflowId, effectiveWorkflowId: mine.workflowId ?? slot.defaultWorkflowId, fellBack: null,
          customised: mine.workflowId !== null || Object.keys(mine.stepAgents).length > 0, workflow: null, steps: [] };
      });
      if (method === 'GET') return respond({ type, slots: resolve() });
      const slot = type.slots.find((s) => s.id === typeConfigMatch[3]);
      if (!slot) return respond({ error: `"${type.name}" has no workflow slot "${typeConfigMatch[3]}"` }, 404);
      if (method === 'DELETE') delete saved[slot.id];
      else saved[slot.id] = { workflowId: body.workflowId ?? saved[slot.id]?.workflowId ?? null, stepAgents: { ...saved[slot.id]?.stepAgents, ...body.stepAgents } };
      buildings.configs.set(type.id, saved);
      return respond({ slots: resolve() });
    }

    const dataMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/data\/([^/]+)$/);
    if (dataMatch) {
      // Mirrors server/src/buildings/query.ts: no limit means the default page, never everything; above the maximum is clamped; junk is a 400.
      buildings.dataRequests.push(`?${searchParams}`);
      const raw = searchParams.get('limit');
      if (raw !== null && !/^\d+$/.test(raw)) return respond({ error: 'limit must be a positive whole number' }, 400);
      const limit = Math.min(raw === null ? 50 : Number(raw), 200);
      if (limit < 1) return respond({ error: 'limit must be a positive whole number' }, 400);
      const all = buildings.rows.get(dataMatch[1]) ?? [];
      const start = searchParams.get('cursor') ? Number(Buffer.from(searchParams.get('cursor'), 'base64url').toString()) : 0;
      const rows = all.slice(start, start + limit);
      return respond({ rows, nextCursor: start + limit < all.length ? Buffer.from(String(start + limit)).toString('base64url') : null, total: null });
    }

    const storageMatch = pathname.match(/^\/api\/projects\/([^/]+)\/storage$/);
    if (storageMatch) {
      const status = buildings.storage.get(storageMatch[1]) ?? { bytes: 4096, warningBytes: 2 * 1024 ** 3, level: 'ok', retention: { rule: null, description: 'Nothing is discarded automatically.' }, lastBackup: null, readOnlyReason: null, ingestionStoppedReason: null, secrets: [] };
      if (method === 'PATCH') {
        if (typeof body.warningBytes !== 'number' || body.warningBytes <= 0) return respond({ error: 'warningBytes must be a positive number' }, 400);
        status.warningBytes = body.warningBytes;
        status.level = status.bytes >= status.warningBytes ? 'warning' : 'ok';
      }
      buildings.storage.set(storageMatch[1], status);
      return respond(status);
    }

    // Agent terminal sessions — see `agentSessions` above.
    const agentListMatch = pathname.match(/^\/api\/projects\/([^/]+)\/agent-sessions$/);
    if (agentListMatch) {
      const projectId = agentListMatch[1];
      if (!projects.has(projectId)) return respond({ error: 'This project no longer exists' }, 404);
      agentSessions.requests.push({ method, pathname, body });
      if (method === 'GET') return respond([...agentSessions.byId.values()].filter((s) => s.projectId === projectId));
      if (agentSessions.failStart) return respond({ error: agentSessions.failStart }, 422);
      if (!executors.has(body.executorId)) return respond({ error: 'Coding agent not found' }, 404);
      const number = (agentSessions.counters.get(projectId) ?? 0) + 1;
      agentSessions.counters.set(projectId, number);
      const session = { id: `agent-session-${nextId++}`, projectId, executorId: body.executorId, name: `Terminal ${number}`, state: 'running', createdAt: new Date(Date.parse('2026-10-19T00:00:00.000Z') + nextId * 1000).toISOString(), updatedAt: '2026-10-19T00:00:00.000Z' };
      agentSessions.byId.set(session.id, session);
      return respond(session, 201);
    }
    const agentItemMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)(?:\/(resume|end))?$/);
    if (agentItemMatch) {
      const [, sessionId, action] = agentItemMatch;
      const session = agentSessions.byId.get(sessionId);
      if (!session) return respond({ error: 'Agent session not found' }, 404);
      agentSessions.requests.push({ method, pathname, body });
      if (method === 'DELETE') { agentSessions.byId.delete(sessionId); return respond(undefined, 204); }
      if (method === 'PATCH') {
        const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : '';
        if (!name) return respond({ error: 'name must not be empty' }, 400);
        if (name.length > 80) return respond({ error: 'name must be at most 80 characters' }, 400);
        session.name = name;
      }
      if (action === 'resume') session.state = 'running';
      if (action === 'end') session.state = 'ended';
      return respond(session);
    }

    // The Schedules area — see `schedules` above. Mirrors server/src/api/scheduleRoutes.ts: reads work on a read-only
    // Building, every change answers 409 with its reason.
    const schedulesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/schedules(?:\/(cron-preview|restore-defaults|jobs)(?:\/([^/]+)(?:\/(run|history))?)?)?$/);
    if (schedulesMatch) {
      const [, projectId, section, jobId, action] = schedulesMatch;
      const project = projects.get(projectId);
      if (!project) return respond({ error: 'This project no longer exists' }, 404);
      schedules.requests.push({ method, pathname, body });
      if (method !== 'GET' && project.readOnly) return respond({ error: project.readOnlyReason }, 409);
      const state = scheduleState(projectId);
      if (!section) {
        if (method === 'PATCH') {
          const known = body.timezone === null || body.timezone === 'UTC' || (typeof body.timezone === 'string' && /^[A-Za-z_]+\/[A-Za-z_\/+-]+$/.test(body.timezone));
          if (!known) return respond({ error: 'timezone must be an IANA timezone name such as Asia/Kolkata, or null for this computer\'s', field: 'timezone' }, 400);
          state.timezone = body.timezone;
          for (const job of state.jobs) if (job.trigger.kind === 'cron') job.nextRunAt = nextRunAt(state, job);
        }
        return respond(schedulesView(projectId));
      }
      if (section === 'cron-preview') {
        const cron = (searchParams.get('cron') ?? '').trim();
        if (!cronIsValid(cron)) return respond({ error: 'Invalid cron expression: it needs 5 fields (minute hour day month weekday)', field: 'cron' }, 400);
        const first = Date.parse(nextRunAt(state, { enabled: true, trigger: { kind: 'cron', cron } }));
        return respond({ cron, timezone: state.timezone ?? schedules.hostTimezone, runs: [0, 1, 2].map((days) => new Date(first + days * 86_400_000).toISOString()) });
      }
      if (section === 'restore-defaults') {
        for (const declaration of schedules.declared.get(project.typeId) ?? []) {
          if (!state.jobs.some((job) => job.declaredJobId === declaration.id)) state.jobs.push(scheduledJob(projectId, state, declaredSettings(declaration), declaration.id));
        }
        return respond(schedulesView(projectId));
      }
      if (!jobId) {
        const checked = validateScheduleJob(body, project);
        if (checked.error) return respond(checked, 400);
        const job = scheduledJob(projectId, state, checked.value);
        state.jobs.push(job);
        return respond(jobView(state, job), 201);
      }
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (!job) return respond({ error: 'This job no longer exists' }, 404);
      const entries = state.history.get(job.id) ?? [];
      if (action === 'history') {
        const cursor = searchParams.get('cursor');
        if (cursor !== null && !/^[1-9]\d*$/.test(cursor)) return respond({ error: 'cursor is not valid', field: 'cursor' }, 400);
        const older = entries.filter((entry) => cursor === null || entry.seq < Number(cursor));
        const page = older.slice(0, 50);
        return respond({ entries: page, nextCursor: older.length > 50 ? String(page.at(-1).seq) : null });
      }
      if (action === 'run') {
        const going = entries.some((entry) => GOING.includes(entry.outcome));
        const queued = entries.some((entry) => entry.outcome === 'queued');
        if (job.overlap !== 'parallel' && queued) return respond({ error: `A run is already waiting to start (overlap rule: ${job.overlap})` }, 409);
        if (job.overlap === 'skip' && going) return respond({ error: 'The previous run is still going (overlap rule: skip)' }, 409);
        if (job.overlap === 'queue' && going) {
          const entry = historyEntry(state, job, { startedBy: 'run-now', outcome: 'queued', note: 'Waiting for the previous run to finish' });
          return respond({ entry, job: jobView(state, job) }, 202);
        }
        if (schedules.failStart) {
          // A start that fails at set-up: the failed entry is kept, counted, and the reason answered as a 409.
          const reason = schedules.failStart;
          schedules.failStart = null;
          historyEntry(state, job, { startedBy: 'run-now', outcome: 'failed', note: reason, finishedAt: schedules.now });
          job.consecutiveFailures += 1;
          return respond({ error: reason }, 409);
        }
        const entry = historyEntry(state, job, { startedBy: 'run-now', outcome: 'running', runId: `scheduled-run-${nextId++}`, runStartedAt: schedules.now });
        return respond({ entry, job: jobView(state, job) }, 201);
      }
      if (method === 'DELETE') {
        state.jobs = state.jobs.filter((candidate) => candidate.id !== job.id);
        state.history.delete(job.id);
        return respond(undefined, 204);
      }
      if (method === 'PATCH') {
        const settings = Object.fromEntries(['name', 'enabled', 'trigger', 'target', 'overlap', 'missedPolicy', 'maxRunsPerDay', 'maxFiveHourPercent', 'maxWeeklyPercent', 'needsApproval', 'failureThreshold']
          .map((key) => [key, body?.[key] !== undefined ? body[key] : job[key]]));
        const checked = validateScheduleJob(settings, project);
        if (checked.error) return respond(checked, 400);
        const turnedOn = !job.enabled && checked.value.enabled;
        const triggerChanged = JSON.stringify(job.trigger) !== JSON.stringify(checked.value.trigger);
        Object.assign(job, checked.value, { updatedAt: new Date().toISOString() });
        if (!job.enabled) job.nextRunAt = null;
        else if (turnedOn || triggerChanged) job.nextRunAt = nextRunAt(state, job);
        if (turnedOn) Object.assign(job, { consecutiveFailures: 0, autoDisabled: false });
        return respond(jobView(state, job));
      }
    }


    const linksAllMatch = method === 'GET' && pathname === '/api/links';
    if (linksAllMatch) return respond([...connections.links.values()].map(linkView));
    const linksOfMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/links$/);
    if (linksOfMatch) {
      const id = linksOfMatch[1];
      if (!projects.has(id)) return connectionFailure(404, 'Building not found');
      const all = [...connections.links.values()].map(linkView);
      return respond({ outgoing: all.filter((l) => l.fromBuildingId === id), incoming: all.filter((l) => l.toBuildingId === id) });
    }
    if (method === 'POST' && pathname === '/api/links') {
      if (!projects.has(body.fromBuildingId) || !projects.has(body.toBuildingId)) return connectionFailure(404, 'Building not found');
      if (body.fromBuildingId === body.toBuildingId) return connectionFailure(400, 'A Building cannot be linked to itself', 'toBuildingId');
      if ([...connections.links.values()].some((l) => l.fromBuildingId === body.fromBuildingId && l.toBuildingId === body.toBuildingId)) return connectionFailure(409, 'These Buildings are already linked');
      const refused = parseGrants(body.capabilities, typeOfProject(body.toBuildingId));
      if (refused) return connectionFailure(400, refused.error, refused.field);
      const link = { id: `link-${nextId++}`, fromBuildingId: body.fromBuildingId, toBuildingId: body.toBuildingId, capabilities: body.capabilities ?? [], events: body.events ?? [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      connections.links.set(link.id, link);
      return respond(linkView(link), 201);
    }
    const linkMatch = pathname.match(/^\/api\/links\/([^/]+)$/);
    if (linkMatch) {
      const link = connections.links.get(linkMatch[1]);
      if (!link) return connectionFailure(404, 'Link not found');
      if (method === 'DELETE') {
        connections.links.delete(link.id);
        for (const [id, sub] of connections.subscriptions) if (sub.subscriberBuildingId === link.fromBuildingId && sub.sourceBuildingId === link.toBuildingId) connections.subscriptions.delete(id);
        return new Response(null, { status: 204 });
      }
      if (method === 'PATCH') {
          const refused = parseGrants(body.capabilities, typeOfProject(link.toBuildingId));
        if (refused) return connectionFailure(400, refused.error, refused.field);
        Object.assign(link, { capabilities: body.capabilities ?? link.capabilities, events: body.events ?? link.events, updatedAt: new Date().toISOString() });
        return respond(linkView(link));
      }
    }
    const subsOfMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/subscriptions$/);
    if (subsOfMatch) return respond([...connections.subscriptions.values()].filter((s) => s.subscriberBuildingId === subsOfMatch[1] || s.sourceBuildingId === subsOfMatch[1]));
    if (method === 'POST' && pathname === '/api/subscriptions') {
      const link = [...connections.links.values()].find((l) => l.fromBuildingId === body.subscriberBuildingId && l.toBuildingId === body.sourceBuildingId);
      if (!link) return connectionFailure(403, 'The Buildings are not linked. Link them in Connections first.');
      if (!link.events.includes(body.eventId)) return connectionFailure(403, `The link does not grant the event "${body.eventId}".`);
      const sub = { id: `sub-${nextId++}`, subscriberBuildingId: body.subscriberBuildingId, sourceBuildingId: body.sourceBuildingId, eventId: body.eventId, jobId: body.jobId, enabled: true, autoDisabled: false };
      connections.subscriptions.set(sub.id, sub);
      return respond(sub, 201);
    }
    const subMatch = pathname.match(/^\/api\/subscriptions\/([^/]+)$/);
    if (subMatch) {
      const sub = connections.subscriptions.get(subMatch[1]);
      if (!sub) return connectionFailure(404, 'Subscription not found');
      if (method === 'DELETE') { connections.subscriptions.delete(sub.id); return new Response(null, { status: 204 }); }
      if (method === 'PATCH') { Object.assign(sub, { enabled: body.enabled, autoDisabled: false }); return respond(sub); }
    }
    const callMatch = method === 'POST' && pathname.match(/^\/api\/projects\/([^/]+)\/capability-calls$/);
    if (callMatch) {
      connections.requests.push({ projectId: callMatch[1], ...body });
      const base = { kind: 'call', callerKind: 'person', callerBuildingId: callMatch[1], targetBuildingId: body.targetBuildingId, name: body.capabilityId, inputsSummary: JSON.stringify(body.inputs ?? {}), depth: 1, chainId: 'c' };
      const refuse = (status, error, field) => { record({ ...base, result: 'refused', status, message: error }); return connectionFailure(status, error, field); };
      if (!projects.has(body.targetBuildingId)) return refuse(404, 'Building not found');
      const capability = (typeOfProject(body.targetBuildingId)?.capabilities ?? []).find((c) => c.id === body.capabilityId);
      const link = [...connections.links.values()].find((l) => l.fromBuildingId === callMatch[1] && l.toBuildingId === body.targetBuildingId);
      if (!capability) return refuse(404, `The Building has no capability "${body.capabilityId}"`);
      if (!link) return refuse(403, 'The Buildings are not linked. Link them in Connections first.');
      if (!link.capabilities.some((g) => g.capabilityId === capability.id)) return refuse(403, `The link does not grant "${capability.id}".`);
      for (const spec of capability.inputs ?? []) {
        const value = (body.inputs ?? {})[spec.name];
        if (spec.required && (value === undefined || value === null || value === '')) return refuse(400, `${spec.name} is required`, spec.name);
        if (spec.type === 'string' && typeof value === 'string' && spec.max !== undefined && [...value].length > spec.max) return refuse(400, `${spec.name} must be at most ${spec.max} characters`, spec.name);
      }
      if (connections.busy.has(`${body.targetBuildingId}|${capability.id}`)) return refuse(409, 'The Building is busy');
      if (capability.mode === 'write' && capability.requiresApproval !== false) {
        const held = record({ ...base, result: 'awaiting-approval', status: 202, message: 'Waiting for approval' });
        return respond({ callId: held.id, state: 'awaiting-approval' }, 202);
      }
      const done = record({ ...base, result: 'ok', status: 200 });
      return respond({ callId: done.id, state: 'done', outputs: { echoed: body.inputs ?? {} } });
    }
    const decisionMatch = method === 'POST' && pathname.match(/^\/api\/capability-calls\/([^/]+)\/decision$/);
    if (decisionMatch) {
      const entry = connections.activity.find((e) => e.id === decisionMatch[1]);
      if (!entry) return connectionFailure(404, 'Call not found');
      if (entry.result !== 'awaiting-approval') return connectionFailure(409, 'This call was already decided.');
      const { decision } = body;
      Object.assign(entry, { result: decision === 'approve' ? 'ok' : decision === 'stop' ? 'stopped' : 'changes-requested', status: decision === 'approve' ? 200 : 409 });
      return respond({ callId: entry.id, state: decision === 'approve' ? 'done' : entry.result });
    }
    const activityMatch = method === 'GET' && pathname.match(/^\/api\/projects\/([^/]+)\/activity$/);
    if (activityMatch) {
      const id = activityMatch[1];
      if (!projects.has(id)) return connectionFailure(404, 'Building not found');
      const q = searchParams;
      const entries = connections.activity.filter((e) => (e.callerBuildingId === id || e.targetBuildingId === id)
        && (!q.get('caller') || e.callerBuildingId === q.get('caller')) && (!q.get('capability') || e.name === q.get('capability')) && (!q.get('result') || e.result === q.get('result')))
        .map((e) => ({ ...e, role: e.callerBuildingId === id ? 'caller' : 'target' })).sort((a, b) => b.at.localeCompare(a.at));
      return respond({ entries });
    }

    return respond({ error: `serverStub: unhandled ${method} ${pathname}` }, 500);
  };

  return {
    projects, transcripts, planDocsByProject, planItems, executeRequests, regressionRequests, refuseRegressions: (message) => { regressionRefusal = message; }, tasksById, blueprintsByProject,
    commands, commandRuns, openedRequests, failOpened: (message) => { openedFailure = message; }, unopenedListGate, executors, defaultExecutor, catalogAgents, catalogSkills, skillInstallRuns, notifications,
    raiseNotification, content, githubAccounts, githubAccountChecks, workflows, workflowRuns, stepRuns, testingConfigs, testRuns, analytics, pullRequests, buildings, schedules, agentSessions, settleRun, connections, seo, googleClient,
  };
}

import type {
  TestingSetupActionEvidence, TestingSetupEvidence, TestingSetupMode, TestRunRecord, WorkflowRecord,
} from '../domain/types.ts';
import { TESTING_CONFIG_RELATIVE_PATH } from './types.ts';
import type { TestingConfigState } from './types.ts';

/**
 * The "Set up / Reconfigure / Repair testing" workflow (task 2.005). A setup is an ordinary PlanItem
 * whose WorkflowRun uses this built-in workflow instead of the Project's own, so it shows up and
 * queues like any other Open Task. Its safety rests on two things the daemon enforces, not on
 * prompt wording:
 *
 * 1. The proposal step is `canEditCode: false`, so its session gets the read-only tool denial
 *    (Claude) or read-only sandbox (Codex) and no testing tools, whatever the executor's autonomy.
 * 2. The implementation step is write-capable only while the latest proposal round carries an
 *    explicit approval from the testing-setup approve action (see workerManager.ts's
 *    `resolveStepPermissions`). A new proposal round — after feedback or a "materially different
 *    change" loop back — has no approval yet, so writes lock again until that round is approved.
 *
 * Defined in code rather than in the Catalog so a Catalog edit can never loosen it.
 */

export const TESTING_SETUP_WORKFLOW_ID = 'testing-setup';
export const SETUP_PROPOSAL_STEP_ID = 'proposal';
export const SETUP_IMPLEMENTATION_STEP_ID = 'implementation';
/** How many times the implementation step may send the setup back for a new proposal before the run needs a human. */
export const SETUP_MAX_REPROPOSALS = 3;
const SETUP_AGENT_ID = 'software-engineer';

export const SETUP_TITLES: Record<TestingSetupMode, string> = {
  setup: 'Set up testing',
  reconfigure: 'Reconfigure testing',
  repair: 'Repair testing',
};

const PROPOSAL_INSTRUCTIONS = `This step is READ-ONLY discovery for this project's testing setup. You may read the repository: package manifests, lockfiles, test files, existing test-runner configuration, CI configuration and the current ${TESTING_CONFIG_RELATIVE_PATH}. You must not write or delete files, install packages, or run commands that change anything; the session enforces this. If the config is missing or invalid, report that in the proposal instead of fixing it.

Produce a setup proposal as one markdown output named "Testing setup proposal", then call complete_step. The person reviews it and must approve it before anything changes. It must contain these sections:
1. Detected: the frameworks and test runners you found, where, and the suite kinds they map to (unit, integration, e2e, performance, security, accessibility, contract, custom).
2. Proposed suites: each suite with its actions (mark the primary result action), commands, working directories and collectors (junit-xml, lcov, cobertura-xml, sarif or avos-result) and where each report is written.
3. Exact changes: every file you will create or modify, every dependency you will add (with version), every script or runner config change, and the full ${TESTING_CONFIG_RELATIVE_PATH} you will write.
4. Validation: the commands you will run and the configured actions you will validate with the test tools after approval.
5. Benefits.
6. Consequences for this project: install size, runtime of each suite, browsers/containers/services it needs, credentials or environment variables, and any security or performance cost.
7. Not automated: any suite that cannot run locally, and why. Never invent configuration for it.
If the project has no tests, present both options and let the person choose: add a test foundation (with its cost), or record that no tests are configured (a config with no suites). Do not pick one yourself.
Do not call skip_step: this step cannot be skipped.`;

const IMPLEMENTATION_INSTRUCTIONS = `Carry out the testing setup proposal the person approved (the latest approved proposal round above) and nothing beyond it. You may install and configure test tooling and reporters, change project scripts and runner configuration, write ${TESTING_CONFIG_RELATIVE_PATH}, and add a small adapter if a suite needs one to produce a supported result format.

Rules:
- Never weaken, skip, delete or rewrite existing tests to get a pass. If existing tests fail, report the failures as they are.
- If you find that a materially different change is needed (another dependency, service, file or suite the approved proposal did not cover), stop changing things and call complete_step with verdict "issues" and the needed change in your summary. That sends the setup back to a read-only proposal that needs a fresh approval.
- Before you finish, run every enabled suite's primary action through the test tools (run_test_action or run_all_tests) until each one produces a normalized result.
- Call complete_step with verdict "pass" only when ${TESTING_CONFIG_RELATIVE_PATH} is valid and every enabled suite's primary action has a settled result from the test tools. The daemon checks this and refuses the completion otherwise, telling you what is missing.`;

/** The built-in testing-setup workflow — see this module's doc comment. */
export function testingSetupWorkflow(): WorkflowRecord {
  return {
    id: TESTING_SETUP_WORKFLOW_ID,
    name: 'Testing setup',
    description: 'Read-only discovery and a setup proposal, a required human approval, then the approved setup validated through the test tools.',
    enabled: true,
    steps: [
      {
        id: SETUP_PROPOSAL_STEP_ID,
        name: 'Setup Proposal',
        agentId: SETUP_AGENT_ID,
        canEditCode: false,
        requiresApproval: true,
        instructions: PROPOSAL_INSTRUCTIONS,
      },
      {
        id: SETUP_IMPLEMENTATION_STEP_ID,
        name: 'Setup & Validation',
        agentId: SETUP_AGENT_ID,
        canEditCode: true,
        requiresApproval: false,
        loopBack: { toStepId: SETUP_PROPOSAL_STEP_ID, maxRounds: SETUP_MAX_REPROPOSALS },
        instructions: IMPLEMENTATION_INSTRUCTIONS,
      },
    ],
  };
}

export class UnsafeTestingSetupWorkflowError extends Error {
  constructor(reason: string) {
    super(`The testing setup workflow is unsafe: ${reason}`);
    this.name = 'UnsafeTestingSetupWorkflowError';
  }
}

/** Refuses a setup workflow whose first approval gate is missing or comes after a write-capable step. */
export function assertSetupWorkflowSafe(workflow: Pick<WorkflowRecord, 'steps'>): void {
  const gateIndex = workflow.steps.findIndex((step) => step.requiresApproval);
  if (gateIndex === -1) throw new UnsafeTestingSetupWorkflowError('it has no approval step');
  const writer = workflow.steps.slice(0, gateIndex + 1).find((step) => step.canEditCode);
  if (writer) throw new UnsafeTestingSetupWorkflowError(`step "${writer.id}" can edit code before or at the approval gate`);
}

/** Absent config → set up, valid → reconfigure, invalid → repair. */
export function setupModeFor(state: TestingConfigState): TestingSetupMode {
  if (state.state === 'valid') return 'reconfigure';
  if (state.state === 'invalid') return 'repair';
  return 'setup';
}

/** The setup PlanItem's description: the Project's config state at start time, which the proposal step reads as its task. */
export function setupPlanItemDescription(state: TestingConfigState): string {
  const mode = setupModeFor(state);
  const lines = [`${SETUP_TITLES[mode]} for this project, following the testing contract in ${TESTING_CONFIG_RELATIVE_PATH}.`];
  if (state.state === 'absent') {
    lines.push('', `There is no ${TESTING_CONFIG_RELATIVE_PATH} yet.`);
  } else if (state.state === 'valid') {
    lines.push('', `The current config is valid and stays in use until the approved change is merged. It has ${state.config.suites.length} suite(s):`);
    for (const suite of state.config.suites) {
      lines.push(`- ${suite.id} (${suite.kind}${suite.enabled ? '' : ', disabled'}): primary action "${suite.primaryActionId}"; actions ${suite.actions.map((a) => `${a.id} → \`${a.command}\``).join(', ')}`);
    }
  } else {
    lines.push('', `The current config is invalid and cannot be used. Its problems:`);
    for (const issue of state.issues) lines.push(`- ${issue.path || '(document)'} [${issue.code}]: ${issue.message}`);
  }
  lines.push('', 'Nothing may change in the project until the person approves a setup proposal.');
  return lines.join('\n');
}

function diagnosticText(run: TestRunRecord): string {
  const first = run.diagnostics[0];
  return first ? `: ${first.message}` : '';
}

function actionProblem(label: string, run: TestRunRecord | undefined): string | null {
  if (!run) return `${label} was never run through the test tools.`;
  if (run.status === 'queued' || run.status === 'running') return `${label} is still ${run.status}; wait for it with get_test_run.`;
  if (run.status === 'error' || run.status === 'stopped') return `${label} ended ${run.status}${diagnosticText(run)}.`;
  if (!run.summary) return `${label} ran but produced no normalized result; give it a collector that reads its report.`;
  return null;
}

function newestFirst(runs: TestRunRecord[]): TestRunRecord[] {
  return runs.slice().sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
}

/**
 * Whether an implementation step may complete: the config in its working tree is valid, and every
 * enabled suite's primary action has a settled, result-producing run among `agentRuns` (the test-tool
 * runs this setup's implementation step made). A run whose tests failed still counts — it proves the
 * action produces results — and its counts are shown in the evidence. A valid config with no enabled
 * suites is accepted: that is the "record that no tests are configured" choice.
 */
export function evaluateSetupEvidence(config: TestingConfigState, agentRuns: TestRunRecord[], now = new Date()): TestingSetupEvidence {
  const checkedAt = now.toISOString();
  if (config.state === 'absent') {
    return { ok: false, checkedAt, config: { state: 'absent', suiteCount: 0, issues: [] }, actions: [], problems: [`No testing config at ${config.path}.`] };
  }
  if (config.state === 'invalid') {
    const issues = config.issues.map(({ path, message }) => ({ path, message }));
    return {
      ok: false,
      checkedAt,
      config: { state: 'invalid', suiteCount: 0, issues },
      actions: [],
      problems: [`The testing config at ${config.path} is invalid: ${issues.map((i) => `${i.path || '(document)'}: ${i.message}`).join('; ')}`],
    };
  }

  const ordered = newestFirst(agentRuns);
  const actions: TestingSetupActionEvidence[] = config.config.suites.filter((suite) => suite.enabled).map((suite) => {
    const run = ordered.find((r) => r.suite.id === suite.id && r.action.id === suite.primaryActionId);
    const problem = actionProblem(`${suite.id}/${suite.primaryActionId}`, run);
    return {
      suiteId: suite.id,
      actionId: suite.primaryActionId,
      runId: run?.id ?? null,
      status: run?.status ?? null,
      counts: run?.summary?.counts ?? null,
      problem,
    };
  });
  const problems = actions.flatMap((action) => (action.problem ? [action.problem] : []));
  return {
    ok: problems.length === 0,
    checkedAt,
    config: { state: 'valid', suiteCount: config.config.suites.length, issues: [] },
    actions,
    problems,
  };
}

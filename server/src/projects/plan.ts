import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DOCS_DIR } from './blueprint.ts';
import type { PlanDocKey, WorkflowRecord } from '../domain/types.ts';
import { PLAN_TASK_TOOLS } from '../terminal/planTaskTool.ts';
import { describeWorkflowSteps } from '../worker/workflowPrompt.ts';
import { PLANNING_NOTES_PATH, planningInterviewRules, specCompletenessChecklist } from './planningInterview.ts';
import type { PlanningFilingTerms } from './planningInterview.ts';

/**
 * The project plan's fixed markdown docs — the "Full-fledged Project
 * Popover"'s tab content (docs/roadmap.md). Human-readable, per-project,
 * editable by hand at any time (docs/architecture.md's "docs stay
 * per-project" split).
 */
export const PLAN_DIR = path.join(DOCS_DIR, 'plan');

export { PLANNING_NOTES_PATH };

export const PLAN_DOC_FILENAMES: Record<PlanDocKey, string> = {
  specifications: 'specifications.md',
  requirements: 'requirements.md',
  testCases: 'test-cases.md',
  e2eTesting: 'e2e-testing.md',
  performanceTesting: 'performance-testing.md',
};

/** Fixed display order — also the Project Popover's tab order. */
export const PLAN_DOC_KEYS: PlanDocKey[] = ['specifications', 'requirements', 'testCases', 'e2eTesting', 'performanceTesting'];

export const PLAN_DOC_TITLES: Record<PlanDocKey, string> = {
  specifications: 'Specifications',
  requirements: 'Requirements',
  testCases: 'Test Cases',
  e2eTesting: 'End-to-End Testing',
  performanceTesting: 'Performance Testing',
};

const PLAN_DOC_HINTS: Record<PlanDocKey, string> = {
  specifications: 'What this project is and what it does.',
  requirements: 'Features and roadmap — what should exist, in what order.',
  testCases: 'The test cases this project should be covered by.',
  e2eTesting: 'End-to-end scenarios: real user flows to exercise together.',
  performanceTesting: 'Performance targets, benchmarks, and load-testing notes.',
};

function isPlanDocKey(value: unknown): value is PlanDocKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PLAN_DOC_FILENAMES, value);
}

export function planDocPath(projectAbsolutePath: string, key: PlanDocKey): string {
  return path.join(projectAbsolutePath, PLAN_DIR, PLAN_DOC_FILENAMES[key]);
}

export function stubPlanDoc(key: PlanDocKey): string {
  return `# ${PLAN_DOC_TITLES[key]}\n\n${PLAN_DOC_HINTS[key]}\n\nNothing recorded yet — use the project's chat to ask the agent to draft this, or edit this file by hand at any time.\n`;
}

/**
 * Self-healing: a Project created before this feature existed (or one whose
 * plan file was deleted by hand) has no file to read yet — write the stub in
 * place and return it, rather than 500ing every plan-tab load forever.
 */
export async function readPlanDoc(projectAbsolutePath: string, key: PlanDocKey): Promise<string> {
  try {
    return await readFile(planDocPath(projectAbsolutePath, key), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const stub = stubPlanDoc(key);
    await mkdir(path.dirname(planDocPath(projectAbsolutePath, key)), { recursive: true });
    await writeFile(planDocPath(projectAbsolutePath, key), stub);
    return stub;
  }
}

export async function readAllPlanDocs(projectAbsolutePath: string): Promise<Record<PlanDocKey, string>> {
  const entries = await Promise.all(
    PLAN_DOC_KEYS.map(async (key) => [key, await readPlanDoc(projectAbsolutePath, key)] as const),
  );
  return Object.fromEntries(entries) as Record<PlanDocKey, string>;
}

export async function writePlanDoc(projectAbsolutePath: string, key: PlanDocKey, content: string): Promise<void> {
  await mkdir(path.dirname(planDocPath(projectAbsolutePath, key)), { recursive: true });
  await writeFile(planDocPath(projectAbsolutePath, key), content);
}

export class InvalidPlanDocKeyError extends Error {
  constructor(key: string) {
    super(`"${key}" is not a plan doc — expected one of: ${PLAN_DOC_KEYS.join(', ')}`);
    this.name = 'InvalidPlanDocKeyError';
  }
}

/** Throws InvalidPlanDocKeyError for anything else, so a bad route param 400s instead of writing an arbitrary path. */
export function requirePlanDocKey(key: string): PlanDocKey {
  if (!isPlanDocKey(key)) throw new InvalidPlanDocKeyError(key);
  return key;
}

/** How the shared interview rules and checklist name a planning session's filing: tasks only, through `create_task`. */
const PLAN_FILING_TERMS: PlanningFilingTerms = {
  items: 'task',
  filingTools: `\`${PLAN_TASK_TOOLS.create}\``,
  specTarget: "each task's description",
};

/**
 * What a planning session is for — the first half of PLAN_INSTRUCTIONS: the session gets the
 * user's own prompt, this purpose (including the shared interview rules and completeness checklist
 * from planningInterview.ts), and how to manage tasks — nothing else, so the conversation stays
 * about the user's topic. Paired with `PLAN_DISALLOWED_TOOLS` and Codex's read-only
 * sandbox so "don't change anything" isn't just a suggestion the model could ignore.
 */
const PLANNING_SESSION_PURPOSE = `This is a PLANNING session. Your job is to take the user's raw idea above and mature it into a detailed, unambiguous feature SPECIFICATION — not an implementation plan.
1. Research what exists today: first read ${PLANNING_NOTES_PATH} if it exists (house rules this project's earlier tasks taught about planning here; follow them), then the relevant parts of this codebase, and anything else you can reach, so the specification fits the product's current behaviour and vocabulary.
2. Have a dialogue with the user, following the interview rules below. Ask as many questions as it takes to remove every ambiguity, suggesting a recommended option wherever you can. Don't guess what the user can simply answer.
3. Once the user has confirmed your summary, write it up as tasks: ONE TASK PER FEATURE. Everything belonging to one feature — its backend, frontend, UI, tests and docs — goes into a single task, organised into sections if it's large. Never split a feature into separate implementation steps. Create two or more tasks only when the user is discussing genuinely different features, and create them in the order they should run when one depends on another.

${planningInterviewRules(PLAN_FILING_TERMS)}

${specCompletenessChecklist(PLAN_FILING_TERMS)}

Each task's description is a specification of WHAT should happen and WHY:
- the problem and the goal
- user-visible behaviour and flows
- rules and states
- every decision made with the user in this session, including every item of the completeness checklist
- edge cases and error cases
- what's in scope and what isn't
- clear acceptance criteria

Do NOT prescribe the implementation: no file paths, no function, component or module names, no data structures, no code snippets, and no step-by-step coding instructions — the coding agent picks those. The one exception is the contract from the completeness checklist above: an agreed database schema and API contract are decisions taken with the user, so they belong in the task. Naming existing product concepts and user-facing features is fine and encouraged. Reading the code to understand current behaviour is part of your research, but it must not turn into implementation instructions in the task.

Each task is picked up later by a coding agent that sees only that task's title and description, never this conversation. Make every description self-contained: restate whatever context and decisions it depends on, including what an earlier task will already have delivered. Each title is numbered automatically so the sequence is easy to follow.

This session is read-only: it cannot write or change any project file. Its only output is the tasks you create with the tools below.`;

/** A task a planning session asks to create — see workerManager.ts's `createPlanningTask`. */
export interface PlanningTaskDraft {
  title: string;
  description: string;
}

/** A planning session's change to one of its tasks: any of the draft's fields, and the "UI planning waits for parent" setting. */
export type PlanningTaskPatch = Partial<PlanningTaskDraft> & { uiPlanningWaitsForParent?: boolean };

/** The planning prompt, run in an interactive CLI whose tasks are managed live through the session's MCP tools (terminal/planTaskTool.ts). */
export const PLAN_INSTRUCTIONS = `${PLANNING_SESSION_PURPOSE}

Manage the project's tasks with these tools:
- \`${PLAN_TASK_TOOLS.create}\` (a title and a description) creates the next task. Call it once per task, in execution order; each one appears in this project's open tasks immediately.
- \`${PLAN_TASK_TOOLS.list}\` shows the project's current tasks with their ids and status.
- \`${PLAN_TASK_TOOLS.update}\` changes a task's title or description, or its \`uiPlanningWaitsForParent\` setting, and \`${PLAN_TASK_TOOLS.delete}\` removes one. Use them whenever the user wants a task changed or dropped, including ones created earlier in this session.
- A task with status "done" has already been completed and can't be changed: for further or reworked work, create a new task.
- A task that waits for a parent task runs its UI Planning early by default (\`uiPlanningWaitsForParent\` off), so its UI plan reaches the user for approval right away. Propose it on only when the task's UI genuinely builds on or reuses UI that the parent introduces, otherwise leave it off, and briefly confirm the value with the user for each dependent task.`;

/**
 * A Project's very first board item, created and started right after the
 * Project itself (blank or cloned alike; see projectService.ts's
 * startDocsBootstrapTask and its one caller, api/router.ts). It runs through
 * the normal start path like any user-started task. The prompt asks for the
 * `maintain-project-context` skill, which infers bootstrap vs. migrate mode
 * from what it actually finds, so this text only frames the run.
 */
/**
 * The fixed one-step Workflow the setup item runs, whatever Workflow the Project
 * uses for ordinary tasks: the documentation agent with `maintain-project-context`
 * preloaded, editing files and nothing else. Not in the Catalog, so it cannot be
 * disabled or edited away; it is passed to the start as an already-resolved
 * Workflow and travels with the item's queue entry when it has to wait for a slot.
 */
export const DOCS_BOOTSTRAP_WORKFLOW: WorkflowRecord = {
  id: 'project-docs-setup',
  name: 'Set up project documentation',
  description: 'One step: the documentation agent sets up the Project\'s .docs from what the repository already has.',
  enabled: true,
  steps: [{
    id: 'set-up-docs',
    name: 'Set up documentation',
    agentId: 'documentation-n-retro-agent',
    skillIds: ['maintain-project-context'],
    preloadSkillIds: ['maintain-project-context'],
    canEditCode: true,
    requiresApproval: false,
    instructions: 'Set up this Project\'s documentation as the task describes, using the maintain-project-context skill.',
  }],
};

export const DOCS_BOOTSTRAP_TITLE = 'Set up project documentation';
export const DOCS_BOOTSTRAP_DESCRIPTION = `Using the maintain-project-context skill, determine whether this is a bootstrap run (a blank or near-empty project) or a migrate run (an existing repository that already carries its own documentation), and set up ${DOCS_DIR} accordingly. For a migrate run, read whatever documentation already exists (README, CONTRIBUTING, an existing docs/ folder, package manifests, code comments, etc.) and skim the codebase's actual structure before writing anything. Consolidate genuinely current, useful information into the skill's documented file shapes; leave outdated history, changelog-style narrative, and superseded content out of ${DOCS_DIR} entirely. Don't invent facts the repository doesn't support — where something genuinely isn't knowable yet, say so briefly rather than filling space.`;

/**
 * `PLAN_INSTRUCTIONS` plus the Project's resolved Workflow's step list (task 3.012) — the planner
 * needs to know what steps each task it creates will go through so it can write specifications
 * (each item's description, the first step's input) those steps can use.
 */
export function buildPlanInstructions(workflow: Pick<WorkflowRecord, 'name' | 'steps'>): string {
  const stepNames = describeWorkflowSteps(workflow);
  if (!stepNames.length) return PLAN_INSTRUCTIONS;
  return `${PLAN_INSTRUCTIONS}\n\nEach task you create will run through this project's "${workflow.name}" workflow, in this order: ${stepNames.join(' → ')}. Write each task's specification so those steps have what they need to do their jobs.`;
}

/**
 * Tool names denied outright for a 'plan'-kind turn — the enforcement half of PLAN_INSTRUCTIONS.
 * A planning session's only output is tasks, so every shell and file-editing tool is denied: it can
 * read the codebase but never change it. Honoured by Claude CLI; Codex CLI has no per-tool deny
 * flag, so there a read-only sandbox does the same job (terminalSessionManager.ts's `readOnly`).
 */
export const PLAN_DISALLOWED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Edit', 'Write', 'NotebookEdit'];

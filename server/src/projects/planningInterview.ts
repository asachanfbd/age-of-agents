import path from 'node:path';
import { DOCS_DIR } from './blueprint.ts';

/**
 * Agent-authored house rules for planning this Project — a plain ad hoc `.docs` file (not a
 * PlanDocKey slot), written by a workflow's Docs & Retro step whenever a later step flags a
 * `planningGap`, with no approval gate (same trust level as blueprint.md). Every planning session is
 * told to read it first — see plan.ts's PLANNING_SESSION_PURPOSE.
 */
export const PLANNING_NOTES_PATH = path.join(DOCS_DIR, 'planning-notes.md');

/** The Project's testing doc, whose known gaps tell a planning session which checks already fail. */
export const TESTING_DOC_PATH = path.join(DOCS_DIR, 'testing.md');

/** What a planning-capable session files and the tool calls that file it, so one rule text fits both sessions. */
export interface PlanningFilingTerms {
  /** e.g. "task" or "task, bug or dependency". */
  items: string;
  /** The filing tool calls, already formatted, e.g. "`create_task`". */
  filingTools: string;
  /** Where the checklist answers go, e.g. "each task's description". */
  specTarget: string;
}

/**
 * The interview-first and confirm-before-filing rules shared by the Planning and Plan and bugs
 * sessions. Later workflow steps (Test Case Planning above all) can only work from what the filed
 * spec says, so the session must gather it before filing rather than turn a short request straight
 * into items.
 */
export function planningInterviewRules(terms: PlanningFilingTerms): string {
  return `Interview first. Before you file any ${terms.items}, interview the user, even when the request is short and seems clear: a two-line request still hides decisions.
- Walk the decision tree one decision at a time, settling each decision before the ones that depend on it. You may group independent decisions in one round.
- Give a recommended answer for each question, with a short reason, so the user can simply agree or correct it.
- Answer from the code and git history whatever they can answer instead of asking. Ask the user what only they can decide: intent, priorities, trade-offs and wording.

Confirm before filing. Before your first ${terms.filingTools}, summarise back to the user the scope as you understand it (what is in and what is out), every decision taken, and the open assumptions you would otherwise make. Then wait for an explicit go-ahead. A short request still gets this confirmation round: never file silently. If the user changes anything, update the summary and confirm again.`;
}

/**
 * The specification completeness checklist: every item a later workflow step would otherwise have
 * to come back to the owner for. A planning session has no shell (PLAN_DISALLOWED_TOOLS), so its
 * baseline check reads docs and package scripts instead of running anything.
 */
export function specCompletenessChecklist(terms: PlanningFilingTerms): string {
  return `Specification completeness. Before filing, settle each of these with the user, or from the code and docs where they answer it, and write the result into ${terms.specTarget}, not only into this conversation:
1. Testing expectations: which kinds of tests the work needs (unit, integration, component) and whether tests ship with this task.
2. Data and APIs, for any work that stores data or adds or changes an API: the finalised database schema and table structures, and the API contracts, meaning which fields are present, omitted or null, the error body format, case sensitivity, limits, input ranges and units.
3. Environment and baseline: which tools are available in this environment (for example git or Docker), whether lint, build and tests pass today, and whether the acceptance criteria should read "no new failures" against a known count. Check this yourself by reading ${TESTING_DOC_PATH} (its known gaps), ${PLANNING_NOTES_PATH} and the package scripts, and write what you found into the spec; ask the user only for what they do not show.
4. UI behaviour: every UI behaviour decision, such as states, empty and error states, and what each action does.
5. What stays: which existing user-visible wording and behaviour must stay unchanged.
6. Verifiable acceptance criteria: every acceptance criterion can be verified in this environment; reword any that depends on a tool that is not available here.`;
}

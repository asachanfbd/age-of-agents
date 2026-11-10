import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLAN_DISALLOWED_TOOLS, PLAN_INSTRUCTIONS, PLANNING_NOTES_PATH, buildPlanInstructions } from '../src/projects/plan.ts';
import { TESTING_DOC_PATH, planningInterviewRules, specCompletenessChecklist } from '../src/projects/planningInterview.ts';
import { BUG_REPORT_INSTRUCTIONS, PLAN_AND_BUGS_INSTRUCTIONS, PLAN_AND_BUGS_TOOLS } from '../src/terminal/bugReportTool.ts';
import { PLAN_TASK_TOOLS } from '../src/terminal/planTaskTool.ts';

/**
 * Task 38.003: both planning-capable sessions interview the owner before filing anything, confirm
 * the understood scope first, and settle a fixed specification completeness checklist, so later
 * workflow steps (Test Case Planning above all) get a complete spec.
 */

const PROMPTS = { 'Planning': PLAN_INSTRUCTIONS, 'Plan and bugs': PLAN_AND_BUGS_INSTRUCTIONS };

/** The key phrases each rule must carry; shared so both prompts are held to the same text (SH01). */
const INTERVIEW_PHRASES = [
  /Interview first\. Before you file any [^.]+, interview the user, even when the request is short and seems clear/,
  /Walk the decision tree one decision at a time/,
  /You may group independent decisions in one round/,
  /Give a recommended answer for each question/,
  /Answer from the code and git history whatever they can answer instead of asking/,
];
const CONFIRM_PHRASES = [
  /Confirm before filing\. Before your first [^,]+/,
  /summarise back to the user the scope as you understand it \(what is in and what is out\), every decision taken, and the open assumptions/,
  /wait for an explicit go-ahead/,
  /A short request still gets this confirmation round: never file silently/,
];
const CHECKLIST_PHRASES = [
  /Testing expectations: which kinds of tests the work needs \(unit, integration, component\) and whether tests ship with this task/,
  /the finalised database schema and table structures/,
  /which fields are present, omitted or null, the error body format, case sensitivity, limits, input ranges and units/,
  /which tools are available in this environment \(for example git or Docker\), whether lint, build and tests pass today, and whether the acceptance criteria should read "no new failures"/,
  /every UI behaviour decision/,
  /which existing user-visible wording and behaviour must stay unchanged/,
  /every acceptance criterion can be verified in this environment/,
];

for (const [name, text] of Object.entries(PROMPTS)) {
  test(`PP01 PB01 PP02 PB02 PP03 SH01 the ${name} prompt requires a grilling-style interview first`, () => {
    for (const phrase of INTERVIEW_PHRASES) assert.match(text, phrase, phrase.source);
  });

  test(`PP04 PB03 SH01 the ${name} prompt requires a confirmation round before filing`, () => {
    for (const phrase of CONFIRM_PHRASES) assert.match(text, phrase, phrase.source);
  });

  test(`PP05-PP09 PB04 SH01 the ${name} prompt carries the whole completeness checklist`, () => {
    for (const phrase of CHECKLIST_PHRASES) assert.match(text, phrase, phrase.source);
  });

  test(`PP10 PB05 the ${name} prompt checks the baseline from docs and scripts, never by running anything`, () => {
    assert.ok(text.includes(`Check this yourself by reading ${TESTING_DOC_PATH} (its known gaps), ${PLANNING_NOTES_PATH} and the package scripts`));
    assert.doesNotMatch(text, /\brun (the )?(tests|lint|build|commands?)\b/i, 'the session has no shell');
  });

  test(`PP11 PB04 the ${name} prompt says the checklist is written into the spec, not only discussed`, () => {
    assert.match(text, /write the result into each task's description[^:]*, not only into this conversation/);
  });

  test(`PP12 the ${name} prompt puts the interview and confirmation before the tool section`, () => {
    const tools = text.indexOf('with these tools:');
    assert.ok(tools > 0);
    assert.ok(text.indexOf('Interview first.') < tools);
    assert.ok(text.indexOf('Confirm before filing.') < tools);
    assert.ok(text.indexOf('Specification completeness.') < tools);
  });
}

test('SH01 both prompts embed the shared rule text word for word', () => {
  const planTerms = { items: 'task', filingTools: `\`${PLAN_TASK_TOOLS.create}\``, specTarget: "each task's description" };
  assert.ok(PLAN_INSTRUCTIONS.includes(planningInterviewRules(planTerms)));
  assert.ok(PLAN_INSTRUCTIONS.includes(specCompletenessChecklist(planTerms)));
  const bugTerms = {
    items: 'task, bug or dependency',
    filingTools: `\`${PLAN_AND_BUGS_TOOLS.create}\`, \`${PLAN_AND_BUGS_TOOLS.createTask}\` or \`${PLAN_AND_BUGS_TOOLS.setDependencies}\``,
    specTarget: "each task's description and, wherever it applies, each bug report",
  };
  assert.ok(PLAN_AND_BUGS_INSTRUCTIONS.includes(planningInterviewRules(bugTerms)));
  assert.ok(PLAN_AND_BUGS_INSTRUCTIONS.includes(specCompletenessChecklist(bugTerms)));
});

test('PP04 the Planning prompt names create_task as the call that waits for the go-ahead, and files only after confirmation', () => {
  assert.match(PLAN_INSTRUCTIONS, /Before your first `create_task`, summarise/);
  assert.match(PLAN_INSTRUCTIONS, /Once the user has confirmed your summary, write it up as tasks/);
});

test('PB01 PB03 the Plan and bugs prompt covers bugs and dependencies too', () => {
  assert.match(PLAN_AND_BUGS_INSTRUCTIONS, /Before you file any task, bug or dependency, interview the user/);
  assert.match(PLAN_AND_BUGS_INSTRUCTIONS, /Before your first `create_bug`, `create_task` or `set_dependencies`, summarise/);
  assert.match(PLAN_AND_BUGS_INSTRUCTIONS, /Once the user has confirmed your summary, file every defect/);
  assert.match(PLAN_AND_BUGS_INSTRUCTIONS, /wherever it applies, each bug report/);
});

test('PB06 a thin bug is still filed, after the confirmation round', () => {
  assert.match(PLAN_AND_BUGS_INSTRUCTIONS, /A thin report is still filed, with the parts you could not establish written as "Unknown"/);
  assert.match(PLAN_AND_BUGS_INSTRUCTIONS, /goes through the same confirmation round, and is filed after it, never refused/);
});

test('PB08 the bug report session prompt is unchanged by this task', () => {
  for (const marker of ['Interview first.', 'Confirm before filing.', 'Specification completeness.', 'decision tree']) {
    assert.ok(!BUG_REPORT_INSTRUCTIONS.includes(marker), marker);
  }
});

test('PP13 the workflow-resolved planning prompt carries every new rule with the step list still last', () => {
  const text = buildPlanInstructions({ name: 'Flow', steps: [
    { id: 'a', agentId: 'software-engineer', name: 'UI Planning', canEditCode: false, requiresApproval: true, instructions: 'x' },
    { id: 'b', agentId: 'software-engineer', name: 'Development', canEditCode: true, requiresApproval: false, instructions: 'y' },
  ] });
  for (const phrase of [...INTERVIEW_PHRASES, ...CONFIRM_PHRASES, ...CHECKLIST_PHRASES]) assert.match(text, phrase, phrase.source);
  assert.ok(text.trimEnd().endsWith('Write each task\'s specification so those steps have what they need to do their jobs.'));
  assert.ok(text.indexOf('UI Planning → Development') > text.indexOf('Specification completeness.'));
});

test('PP06 the Planning prompt lets the agreed contract into the task despite the no-data-structures rule', () => {
  assert.match(PLAN_INSTRUCTIONS, /no data structures/);
  assert.match(PLAN_INSTRUCTIONS, /an agreed database schema and API contract are decisions taken with the user, so they belong in the task/);
});

test('PP10 the planning session still has its shell and editing tools denied', () => {
  assert.deepEqual(PLAN_DISALLOWED_TOOLS, ['Bash', 'BashOutput', 'KillShell', 'Edit', 'Write', 'NotebookEdit']);
});

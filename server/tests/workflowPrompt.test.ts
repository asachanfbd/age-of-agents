import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChangesRequestedMessage, buildRerunMessage, buildReviewFixMessage, buildStepPrompt, describeOutputSize, describeWorkflowSteps } from '../src/worker/workflowPrompt.ts';
import { APPROVAL_BRIEF_STYLE, REVIEW_SUMMARY_STYLE, SUMMARY_HOUSE_STYLE, SUMMARY_HOUSE_STYLE_REMINDER } from '../src/worker/summaryStyle.ts';
import type { BuildStepPromptInput, StagePromptHistory } from '../src/worker/workflowPrompt.ts';

const BASE_INPUT: BuildStepPromptInput = {
  taskTitle: 'Add CSV export',
  taskDescription: 'Let users export their data as CSV.',
  stepName: 'Development',
  instructions: 'Implement the task and its tests.',
  canEditCode: true,
  requiresVerdict: false,
  history: [],
};

test('buildStepPrompt includes the task title/description and the step instructions', () => {
  const prompt = buildStepPrompt(BASE_INPUT);
  assert.match(prompt, /Add CSV export/);
  assert.match(prompt, /Let users export their data as CSV\./);
  assert.match(prompt, /Implement the task and its tests\./);
});

test('buildStepPrompt says the step may edit code when canEditCode is true, and forbids it otherwise', () => {
  const editable = buildStepPrompt(BASE_INPUT);
  assert.match(editable, /may edit code and run commands normally/);

  const readOnly = buildStepPrompt({ ...BASE_INPUT, canEditCode: false });
  assert.match(readOnly, /READ-ONLY/);
  assert.doesNotMatch(readOnly, /may edit code and run commands normally/);
});

test('buildStepPrompt mentions complete_step/skip_step and the diff tools, and only demands a verdict when requiresVerdict is set', () => {
  const withoutVerdict = buildStepPrompt(BASE_INPUT);
  assert.match(withoutVerdict, /complete_step/);
  assert.match(withoutVerdict, /skip_step/);
  assert.match(withoutVerdict, /diff_summary/);
  assert.doesNotMatch(withoutVerdict, /MUST also include `verdict`/);

  const withVerdict = buildStepPrompt({ ...BASE_INPUT, requiresVerdict: true });
  assert.match(withVerdict, /MUST also include `verdict`/);
});

test('buildStepPrompt tells every step to call report_progress at the start and keep it current, whether or not it edits code, requires a verdict, or can be skipped', () => {
  for (const input of [
    BASE_INPUT,
    { ...BASE_INPUT, canEditCode: false },
    { ...BASE_INPUT, requiresVerdict: true },
    { ...BASE_INPUT, canEditCode: false, requiresVerdict: true },
    { ...BASE_INPUT, skippable: false },
  ]) {
    const prompt = buildStepPrompt(input);
    assert.match(prompt, /report_progress/);
    assert.match(prompt, /1-2 word `short` label/, 'IS07: asks for a short label per checklist item');
    assert.match(prompt, /At the start of this step/);
    assert.match(prompt, /currentActivity/);
    assert.match(prompt, /never replaces `complete_step`/);
  }
});

test('buildStepPrompt includes the branch and base when given, and omits the section otherwise', () => {
  const withBranch = buildStepPrompt({ ...BASE_INPUT, branch: 'task/3-004-export-csv', baseBranch: 'main' });
  assert.match(withBranch, /task\/3-004-export-csv/);
  assert.match(withBranch, /based on `main`/);
  assert.match(withBranch, /Do not switch branches, commit, or push/);

  const withoutBranch = buildStepPrompt(BASE_INPUT);
  assert.doesNotMatch(withoutBranch, /# Branch/);
});

test('buildStepPrompt folds in every earlier stage, showing only the latest round unless there are several or the caller marks it a loop target', () => {
  const history: StagePromptHistory[] = [
    {
      stageName: 'Test Case Planning',
      rounds: [{ round: 1, summary: 'Cover happy path and empty-input edge case.', outputs: [] }],
    },
    {
      stageName: 'Development',
      rounds: [
        { round: 1, summary: 'First attempt.', outputs: [], verdict: undefined },
        { round: 2, summary: 'Fixed the null-check issue.', outputs: [], verdict: undefined },
      ],
    },
  ];
  const prompt = buildStepPrompt({ ...BASE_INPUT, stepName: 'Code Review', history });
  assert.match(prompt, /## Test Case Planning/);
  assert.match(prompt, /Cover happy path/);
  assert.match(prompt, /## Development/);
  assert.match(prompt, /First attempt\./, 'a step with more than one round shows every round');
  assert.match(prompt, /Fixed the null-check issue\./);
  assert.match(prompt, /round 1/);
  assert.match(prompt, /round 2/);
});

// ---- Outputs referenced by file path (task 5.020) ----

const MOCKUP = '<html><body><div id="mock-marker">Settings</div></body></html>';
const MOCKUP_PATH = '/data/step-outputs/p1/r1/ui-planning/round-1/settings-screen.html';
const READ_HINT = 'Read it only if it is relevant to this step; if it is large, read just the parts you need with a partial read (offset/limit).';

test('buildStepPrompt references a saved HTML output by name, format, size and labelled absolute path, with none of its content', () => {
  const history: StagePromptHistory[] = [{
    stageName: 'UI Planning',
    rounds: [{ round: 1, summary: 'One mockup for the settings screen.', outputs: [{ name: 'Settings screen', format: 'html', content: MOCKUP, path: MOCKUP_PATH }] }],
  }];
  const prompt = buildStepPrompt({ ...BASE_INPUT, history });
  assert.ok(prompt.includes(`Output: Settings screen (html, ~1 line)\nAbsolute path: ${MOCKUP_PATH}\n${READ_HINT}`), prompt);
  assert.doesNotMatch(prompt, /mock-marker/);
  assert.doesNotMatch(prompt, /--- Output:|--- End output ---/);
});

test('buildStepPrompt references a saved Markdown output the same way', () => {
  const content = '# Test cases\n\n- [ ] U1 hidden-case-marker\n';
  const history: StagePromptHistory[] = [{
    stageName: 'Test Case Planning',
    rounds: [{ round: 1, summary: 'Cases listed.', outputs: [{ name: 'Test cases', format: 'markdown', content, path: '/d/r/test-case-planning/round-1/test-cases.md' }] }],
  }];
  const prompt = buildStepPrompt({ ...BASE_INPUT, history });
  assert.match(prompt, /Output: Test cases \(markdown, ~3 lines\)\nAbsolute path: \/d\/r\/test-case-planning\/round-1\/test-cases\.md\n/);
  assert.doesNotMatch(prompt, /hidden-case-marker/);
});

test('describeOutputSize gives lines for a small output, KB and lines for a large one, and 0 lines for an empty one', () => {
  assert.equal(describeOutputSize('a\nb\nc'), '~3 lines');
  assert.equal(describeOutputSize('one line'), '~1 line');
  assert.equal(describeOutputSize(''), '0 lines');
  assert.equal(describeOutputSize('a\nb\n'), '~2 lines', 'a trailing newline is not another line');
  const large = `${'x'.repeat(99)}\n`.repeat(490);
  assert.equal(describeOutputSize(large), '~48 KB, ~490 lines');
});

test('every referenced output carries the read-only-if-relevant hint; summary, verdict and decision stay inline beside it', () => {
  const history: StagePromptHistory[] = [{
    stageName: 'Human Code Review',
    rounds: [{
      round: 1, summary: 'Brief ready.', verdict: 'issues',
      approval: { decision: 'changes-requested', comment: 'Rename it.', at: 't' },
      outputs: [
        { name: 'Brief', format: 'markdown', content: '# a', path: '/d/brief.md' },
        { name: 'Notes', format: 'markdown', content: '# b', path: '/d/notes.md' },
      ],
    }],
  }];
  const prompt = buildStepPrompt({ ...BASE_INPUT, history, planningGaps: [{ stageName: 'Test Case Planning', round: 1, note: 'Baseline not checked.' }] });
  assert.equal(prompt.split(READ_HINT).length - 1, 2);
  assert.match(prompt, /Summary: Brief ready\.\nVerdict: issues\nDecision: changes requested by the person — Rename it\.\nOutput: Brief/);
  assert.match(prompt, /# Planning gaps raised this run[\s\S]*Baseline not checked\./);
});

test('several outputs of one round are each listed with their own path, in order', () => {
  const outputs = ['Home', 'Settings', 'Profile'].map((name) => ({ name, format: 'html' as const, content: `<p>${name}</p>`, path: `/d/ui/round-1/${name.toLowerCase()}.html` }));
  const prompt = buildStepPrompt({ ...BASE_INPUT, history: [{ stageName: 'UI Planning', rounds: [{ round: 1, summary: 's', outputs }] }] });
  const paths = [...prompt.matchAll(/^Absolute path: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(paths, ['/d/ui/round-1/home.html', '/d/ui/round-1/settings.html', '/d/ui/round-1/profile.html']);
});

test('a multi-round stage shows each round\'s outputs under that round\'s own path', () => {
  const round = (n: number) => ({ round: n, summary: `v${n}`, outputs: [{ name: 'Notes', format: 'markdown' as const, content: `# v${n}`, path: `/d/development/round-${n}/notes.md` }] });
  const prompt = buildStepPrompt({ ...BASE_INPUT, history: [{ stageName: 'Development', rounds: [round(1), round(2)] }] });
  assert.match(prompt, /Summary \(round 1\): v1\nOutput: Notes \(markdown, ~1 line\)\nAbsolute path: \/d\/development\/round-1\/notes\.md/);
  assert.match(prompt, /Summary \(round 2\): v2\nOutput: Notes \(markdown, ~1 line\)\nAbsolute path: \/d\/development\/round-2\/notes\.md/);
});

test('an output whose file could not be written is pasted inline as before, while the others stay references', () => {
  const history: StagePromptHistory[] = [{
    stageName: 'UI Planning',
    rounds: [{
      round: 1, summary: 's',
      outputs: [
        { name: 'Export screen', format: 'html', content: '<html>inline-mock</html>', path: null },
        { name: 'Settings screen', format: 'html', content: MOCKUP, path: MOCKUP_PATH },
      ],
    }],
  }];
  const prompt = buildStepPrompt({ ...BASE_INPUT, history });
  assert.match(prompt, /--- Output: Export screen \(html\) ---\n<html>inline-mock<\/html>\n--- End output ---\nOutput: Settings screen \(html, ~1 line\)\nAbsolute path: /);
  assert.doesNotMatch(prompt, /mock-marker/);
});

test('buildStepPrompt renders a skipped round without a literal summary field, falling back to a placeholder for an empty one', () => {
  const history: StagePromptHistory[] = [
    { stageName: 'UI Planning', rounds: [{ round: 1, summary: '', outputs: [] }] },
  ];
  const prompt = buildStepPrompt({ ...BASE_INPUT, history });
  assert.match(prompt, /no summary recorded/);
});

test('describeWorkflowSteps returns step names in order', () => {
  const names = describeWorkflowSteps({
    steps: [
      { id: 'a', name: 'UI Planning' } as never,
      { id: 'b', name: 'Development' } as never,
    ],
  });
  assert.deepEqual(names, ['UI Planning', 'Development']);
});

test('describeWorkflowSteps returns an empty array for a workflow with no steps', () => {
  assert.deepEqual(describeWorkflowSteps({ steps: [] }), []);
});

test('buildStepPrompt shows the human decision on each earlier round, so a later step knows which proposal was approved', () => {
  const history: StagePromptHistory[] = [{
    stageName: 'Setup Proposal',
    rounds: [
      { round: 1, summary: 'v1', outputs: [], approval: { decision: 'changes-requested', comment: 'No Playwright.', at: 't' } },
      { round: 2, summary: 'v2', outputs: [], approval: { decision: 'approved', comment: null, at: 't' } },
    ],
  }];
  const prompt = buildStepPrompt({ ...BASE_INPUT, history });
  assert.match(prompt, /Decision \(round 1\): changes requested by the person — No Playwright\./);
  assert.match(prompt, /Decision \(round 2\): APPROVED by the person\n/);
});

test('buildStepPrompt leaves out skip_step for a step that cannot be skipped', () => {
  assert.doesNotMatch(buildStepPrompt({ ...BASE_INPUT, skippable: false }), /skip_step/);
  assert.match(buildStepPrompt({ ...BASE_INPUT, skippable: true }), /skip_step/);
});

test('buildStepPrompt lists every planning gap raised this run with its stage and round, and omits the section when there are none', () => {
  const withGaps = buildStepPrompt({
    ...BASE_INPUT,
    stepName: 'Docs & Retro',
    planningGaps: [
      { stageName: 'Test Case Planning', round: 1, note: 'No rule for empty CSV exports.' },
      { stageName: 'Development', round: 2, note: 'Date format was never decided.' },
    ],
  });
  assert.match(withGaps, /# Planning gaps raised this run/);
  assert.match(withGaps, /- Test Case Planning \(round 1\): No rule for empty CSV exports\./);
  assert.match(withGaps, /- Development \(round 2\): Date format was never decided\./);

  assert.doesNotMatch(buildStepPrompt(BASE_INPUT), /# Planning gaps raised this run/);
  assert.doesNotMatch(buildStepPrompt({ ...BASE_INPUT, planningGaps: [] }), /# Planning gaps raised this run/);
});

test('buildStepPrompt tells every step about complete_step\'s planningGap field and that it may ask the person directly when truly stuck', () => {
  const prompt = buildStepPrompt(BASE_INPUT);
  assert.match(prompt, /`planningGap`/);
  assert.match(prompt, /ask them a direct question here in this session/);
});

test('buildReviewFixMessage carries only the review\'s issues, verbatim, with a one-line framing', () => {
  const message = buildReviewFixMessage({ reviewStepName: 'Code Review', reviewRound: 2, reviewSummary: '1. Null guard missing.\n2. No test for prune.' });
  assert.equal(message, `Code Review round 2 found issues. Fix every point it raised, then call \`complete_step\` again.\n\n1. Null guard missing.\n2. No test for prune.\n\n${SUMMARY_HOUSE_STYLE_REMINDER}`);
  assert.doesNotMatch(message, /# Task:|# Your step:|# Permissions|# How to finish|Earlier stages/);
  assert.match(buildReviewFixMessage({ reviewStepName: 'Code Review', reviewRound: 1, reviewSummary: null }), /\(no summary recorded\)\n\nWrite your summary in the house style/);
});

test('buildReviewFixMessage adds a human override\'s comment, or the bare override line without one', () => {
  const base = { reviewStepName: 'Code Review', reviewRound: 3, reviewSummary: 'Still broken.' };
  assert.match(buildReviewFixMessage({ ...base, overrideComment: 'Look closer.' }), /Still broken\.\n\nHuman override: run another review round\. Look closer\.\n\nWrite your summary/);
  assert.match(buildReviewFixMessage({ ...base, overrideComment: null }), /Still broken\.\n\nHuman override: run another review round\.\n\nWrite your summary/);
  assert.doesNotMatch(buildReviewFixMessage(base), /Human override/);
});

test('buildChangesRequestedMessage keeps the person\'s comment verbatim, including multi-line and empty comments', () => {
  assert.equal(buildChangesRequestedMessage('Use the new wording.'), `The human reviewer requested changes: Use the new wording.\n\nAddress them, then call \`complete_step\` again.\n\n${SUMMARY_HOUSE_STYLE_REMINDER}`);
  assert.match(buildChangesRequestedMessage('Line one.\nLine two.'), /^The human reviewer requested changes: Line one\.\nLine two\./);
  assert.match(buildChangesRequestedMessage(''), /^The human reviewer requested changes: \n/);
});

test('buildRerunMessage asks a reviewing step for a new verdict and shows the fix step\'s latest round with its outputs by path', () => {
  const updates: StagePromptHistory[] = [{
    stageName: 'Development',
    rounds: [{ round: 2, summary: 'Fixed both findings.', outputs: [{ name: 'Notes', format: 'markdown', content: '# Notes-marker', path: '/d/development/round-2/notes.md' }] }],
  }];
  const message = buildRerunMessage({ requiresVerdict: true, updates });
  assert.match(message, /^Development has addressed your previous review\. Re-review the current changes and call `complete_step` with a new `verdict` \("pass" or "issues"\)\./);
  assert.ok(message.includes(`## Development (latest round)\n\nSummary: Fixed both findings.\nOutput: Notes (markdown, ~1 line)\nAbsolute path: /d/development/round-2/notes.md\n${READ_HINT}`), message);
  assert.doesNotMatch(message, /Notes-marker/);
  assert.doesNotMatch(buildRerunMessage({ requiresVerdict: false, updates }), /Notes-marker/);
  assert.doesNotMatch(message, /\(round 2\)/, 'one round per stage needs no round label');
  assert.doesNotMatch(message, /# Task:|# Your step:|# Permissions/);
});

test('buildRerunMessage names every re-run step, shows a decision, and renders a missing summary', () => {
  const updates: StagePromptHistory[] = [
    { stageName: 'Development', rounds: [{ round: 3, summary: '', outputs: [] }] },
    { stageName: 'Proposal', rounds: [{ round: 2, summary: 'v2', outputs: [], approval: { decision: 'approved', comment: 'ok', at: 'now' } }] },
  ];
  assert.match(buildRerunMessage({ requiresVerdict: true, updates }), /^Development, Proposal have addressed your previous review/);
  const plain = buildRerunMessage({ requiresVerdict: false, updates });
  assert.match(plain, /^Since your previous round, these steps have new results: Development, Proposal\. Redo this step against the current changes, then call `complete_step` again\./);
  assert.match(plain, /Summary: \(no summary recorded\)/);
  assert.match(plain, /Decision: APPROVED by the person — ok/);
});

test('buildRerunMessage still reads sensibly with no re-run steps', () => {
  assert.match(buildRerunMessage({ requiresVerdict: true, updates: [] }), /^Earlier steps have addressed your previous review/);
  assert.match(buildRerunMessage({ requiresVerdict: false, updates: [] }), /these steps have new results: none recorded\./);
});

test('a continued round\'s own messages never repeat the report_progress reminder — its session already holds the step\'s briefing', () => {
  assert.doesNotMatch(buildReviewFixMessage({ reviewStepName: 'Code Review', reviewRound: 2, reviewSummary: 'x' }), /report_progress/);
  assert.doesNotMatch(buildChangesRequestedMessage('Rename it.'), /report_progress/);
  assert.doesNotMatch(buildRerunMessage({ requiresVerdict: false, updates: [] }), /report_progress/);
});

test('review-fix and Request changes messages carry no outputs, and a fallback briefing with an appended re-run note has no pasted content', () => {
  assert.doesNotMatch(buildReviewFixMessage({ reviewStepName: 'Code Review', reviewRound: 1, reviewSummary: 'Broken.', overrideComment: 'Again.' }), /Output:|Absolute path:/);
  assert.doesNotMatch(buildChangesRequestedMessage('Rename it.'), /Output:|Absolute path:/);
  const updates: StagePromptHistory[] = [{ stageName: 'UI Planning', rounds: [{ round: 2, summary: 's', outputs: [{ name: 'Settings screen', format: 'html', content: MOCKUP, path: MOCKUP_PATH }] }] }];
  const prompt = buildStepPrompt({
    ...BASE_INPUT,
    instructions: `${BASE_INPUT.instructions}\n\n${buildRerunMessage({ requiresVerdict: false, updates })}`,
    history: updates,
  });
  assert.doesNotMatch(prompt, /mock-marker/);
  assert.equal(prompt.split(`Absolute path: ${MOCKUP_PATH}`).length - 1, 2, 'referenced in both the history and the appended note');
});

test('a fallback briefing carries the full step prompt with the new input appended to the instructions', () => {
  const prompt = buildStepPrompt({ ...BASE_INPUT, instructions: `${BASE_INPUT.instructions}\n\n${buildChangesRequestedMessage('Rename it.')}` });
  assert.match(prompt, /# Task: Add CSV export/);
  assert.match(prompt, /# Your step: Development\n\nImplement the task and its tests\.\n\nThe human reviewer requested changes: Rename it\./);
  assert.match(prompt, /# How to finish/);
});

// ---- House style for readable summaries (task 5.019) ----

test('buildStepPrompt gives every step the house style for its summary, skip reason and Markdown outputs, after the step instructions', () => {
  const prompt = buildStepPrompt({ ...BASE_INPUT, instructions: 'Write a concise brief.' });
  assert.ok(prompt.includes(SUMMARY_HOUSE_STYLE), 'the full shared style is embedded verbatim');
  assert.match(prompt, /# How to write your summary and outputs\n\nThese rules apply to your `complete_step` summary, any `skip_step` reason and every Markdown output, whatever the step instructions above say about format\./);
  assert.ok(prompt.indexOf('# How to write your summary') > prompt.indexOf('Write a concise brief.'), 'the style follows the step instructions, so it is not overridden by them');
  assert.ok(buildStepPrompt({ ...BASE_INPUT, skippable: false }).includes(SUMMARY_HOUSE_STYLE), 'an unskippable step (a testing setup\'s) gets the style too');
  for (const rule of [/TL;DR/, /`###` headings/, /\*\*Tables\*\*/, /\*\*Blockquotes\*\*/, /\*\*Task lists or numbered lists\*\*/, /\*\*Plain language\.\*\*/, /Never drop information/]) {
    assert.match(prompt, rule);
  }
});

test('buildStepPrompt adds the review rules only to a reviewing step, keeping every issue with severity and location', () => {
  const review = buildStepPrompt({ ...BASE_INPUT, requiresVerdict: true });
  assert.ok(review.includes(`## Reviewing\n\n${REVIEW_SUMMARY_STYLE}`));
  assert.match(REVIEW_SUMMARY_STYLE, /verdict in its TL;DR/);
  assert.match(REVIEW_SUMMARY_STYLE, /list every issue, none merged or dropped/);
  assert.match(REVIEW_SUMMARY_STYLE, /severity[\s\S]*location[\s\S]*concrete fix/);
  assert.doesNotMatch(buildStepPrompt(BASE_INPUT), /## Reviewing/);
});

test('buildStepPrompt frames an approval step\'s summary as the human reviewer\'s brief, and only that step\'s', () => {
  const approval = buildStepPrompt({ ...BASE_INPUT, requiresApproval: true });
  assert.ok(approval.includes(`## Brief for the human reviewer\n\n${APPROVAL_BRIEF_STYLE}`));
  assert.match(APPROVAL_BRIEF_STYLE, /Where to focus" as a checklist/);
  assert.match(APPROVAL_BRIEF_STYLE, /blockquote/);
  assert.doesNotMatch(buildStepPrompt(BASE_INPUT), /Brief for the human reviewer/);
  assert.doesNotMatch(buildStepPrompt({ ...BASE_INPUT, requiresApproval: false }), /Brief for the human reviewer/);
});

test('every continued-session message reminds the step of the house style', () => {
  const update: StagePromptHistory[] = [{ stageName: 'Development', rounds: [{ round: 2, summary: 'Fixed.', outputs: [] }] }];
  for (const message of [
    buildReviewFixMessage({ reviewStepName: 'Code Review', reviewRound: 1, reviewSummary: 'Broken.' }),
    buildChangesRequestedMessage('Rename it.'),
    buildRerunMessage({ requiresVerdict: true, updates: update }),
    buildRerunMessage({ requiresVerdict: false, updates: update }),
  ]) {
    assert.ok(message.endsWith(SUMMARY_HOUSE_STYLE_REMINDER), message);
  }
});

test('buildStepPrompt for a read-only step that can run commands keeps the read-only wording and allows commands', () => {
  const prompt = buildStepPrompt({ ...BASE_INPUT, canEditCode: false, canRunCommands: true });
  assert.match(prompt, /READ-ONLY/);
  assert.match(prompt, /MAY run commands for installing dependencies, reproducing problems and running tests/);
  assert.match(prompt, /not committed by this step/);
  assert.match(prompt, /must not use commands to edit source files/);
  assert.equal(buildStepPrompt({ ...BASE_INPUT, canEditCode: false, canRunCommands: false }), buildStepPrompt({ ...BASE_INPUT, canEditCode: false }));
  assert.equal(buildStepPrompt({ ...BASE_INPUT, canRunCommands: true }), buildStepPrompt(BASE_INPUT), 'a write step is unchanged by the option');
});

test('buildStepPrompt adds the Browser section only for a step with the browser', () => {
  assert.doesNotMatch(buildStepPrompt(BASE_INPUT), /# Browser/);
  const prompt = buildStepPrompt({ ...BASE_INPUT, canEditCode: false, canRunCommands: true, browser: 'available' });
  assert.match(prompt, /# Browser/);
  for (const part of [/\.docs\//, /saved Commands/, /in the background on a free port/, /responds/, /Stop it before you call `complete_step`/, /browser_take_screenshot/, /empty, error and loading states/, /narrow \(mobile\) width/, /what you checked in the browser and what you saw/, /missing or differs from the plan is an issue/, /cannot be started/, /Never claim them as passed/, /no UI, skip the browser checks and say so in one line/]) {
    assert.match(prompt, part);
  }
});

test('buildStepPrompt tells the agent when the browser is unavailable', () => {
  const prompt = buildStepPrompt({ ...BASE_INPUT, canEditCode: false, canRunCommands: true, browser: 'unavailable' });
  assert.match(prompt, /headless browser is NOT available/);
  assert.match(prompt, /unverified/);
  assert.doesNotMatch(prompt, /browser_navigate/);
});

test('B036 both read-only Permissions variants say complete_step outputs are not files; the editable one need not', () => {
  const allowed = /are not files and are always allowed/;
  assert.match(buildStepPrompt({ ...BASE_INPUT, canEditCode: false }), allowed);
  assert.match(buildStepPrompt({ ...BASE_INPUT, canEditCode: false, canRunCommands: true }), allowed);
  assert.doesNotMatch(buildStepPrompt(BASE_INPUT), allowed);
});

test('B036 the HTML-mockup finish line appears only when the step requires html outputs', () => {
  const line = /must include at least one complete HTML mockup in `outputs` \(format "html"\); `complete_step` will refuse the call without one/;
  assert.match(buildStepPrompt({ ...BASE_INPUT, canEditCode: false, requiredOutputFormat: 'html' }), line);
  assert.doesNotMatch(buildStepPrompt({ ...BASE_INPUT, canEditCode: false }), line);
  assert.doesNotMatch(buildStepPrompt({ ...BASE_INPUT, canEditCode: false, requiredOutputFormat: null }), line);
});

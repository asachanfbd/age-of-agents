/**
 * The house style for every agent-written summary or report in a WorkflowRun: step summaries, skip
 * reasons, Markdown step outputs, an approval step's brief, and the completion report/PR description.
 * It lives in code, not in any step's instructions, so it reaches every Workflow — Catalog ones the
 * person wrote included — without each step having to repeat it (see workflowPrompt.ts and
 * workflowSummarizer.ts, its two consumers).
 */

/** The shared rules, as a Markdown block both the step prompts and the summarizer embed verbatim. */
export const SUMMARY_HOUSE_STYLE = `Someone who does not know this codebase in depth skims what you write to decide what happened, what matters, where to focus and what to remember. The run view and the pull request render GitHub-flavoured Markdown, so use it.

- **Lead with the outcome.** Open with a one or two line **TL;DR:** saying what happened and the result (verdict, pass or fail, what changed).
- **Short paragraphs.** Two or three lines at most. Prefer lists to prose.
- **Headings.** Use \`###\` headings (never \`#\` or \`##\`), picking only the sections that apply, such as "What changed", "Why", "Where to focus", "Risks and open questions", "Remember" and "Next steps". A short step stays short.
- **Tables** for comparisons and per-file or per-item breakdowns, e.g. | File | Change | Why |. Keep them to a few narrow columns.
- **Blockquotes** (\`>\`) for the one or two things the reader must not miss: a risk, a decision needed, a deviation from the plan.
- **Task lists or numbered lists** (\`- [ ]\`, \`1.\`) for actions the reader or the next step should take.
- **Plain language.** Name the user-visible behaviour first and the implementation second. Explain an internal name or term briefly the first time you use it. Spell out acronyms. Put file paths and code identifiers in \`code\`, only where they help.
- **Concise.** No filler. Don't repeat the task description, and don't restate earlier steps' summaries unless something changed.
- **Never drop information for formatting's sake.** Verdicts, issue lists, skip reasons and anything a later step relies on keep their full meaning: the next agent must still get everything it needs.
- **Proportional length.** A trivial skip reason is one plain sentence (no headings). A long report stays skimmable through its headings.`;

/** One line for a message sent into a continued session, whose original briefing already holds the full house style. */
export const SUMMARY_HOUSE_STYLE_REMINDER = 'Write your summary in the house style for readable summaries from your briefing: a TL;DR first, then short `###` sections, lists, tables and blockquotes as they fit.';

/** Extra rules for a step that reviews earlier work (one that must give a verdict). */
export const REVIEW_SUMMARY_STYLE = `Start the summary with the verdict in its TL;DR. When the verdict is "issues", list every issue, none merged or dropped, as a table or list giving its severity (blocker, major or minor), its location (\`file:line\` or the area) and the concrete fix expected. Development works from this list alone.`;

/** Extra rules for a step that pauses for a human approval: its summary is the reviewer's brief. */
export const APPROVAL_BRIEF_STYLE = `Your summary is the brief the person reads before they approve or request changes. Make it a decision aid, not a narrative: a TL;DR of what they are approving, then "What changed" (a table works well), "Where to focus" as a checklist (\`- [ ]\`) of what to check before approving, and "Risks and open questions" if there are any. Put any decision only they can make in a blockquote.`;

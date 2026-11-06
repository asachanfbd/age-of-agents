import { redactSecrets } from '../redaction.ts';
import { ContentInputError } from './errors.ts';
import { RETRO_CHANGES_MAX, RETRO_TEXT_MAX, SECTION_MAX_CHARS } from './limits.ts';
import { PLATFORM_LABELS } from './rules.ts';
import type { AssetKind, Platform } from './rules.ts';
import { STYLE_SECTIONS } from './style.ts';
import { charCount } from './validate.ts';

/**
 * The pure rules of the writing-style retro: which assets it runs for, the prompt, the strict answer shape and how a
 * change lands in `writing-style.md`. A section's body is the text between its `## <name>` heading line and the next
 * `## ` heading (or the end of the file); a change only ever looks inside that body.
 */

export const RETRO_KINDS: readonly AssetKind[] = ['script', 'post-text', 'article'];
export const isWrittenKind = (kind: AssetKind): boolean => RETRO_KINDS.includes(kind);

export const RETRO_ACTIONS = ['add', 'replace', 'remove'] as const;
export type RetroAction = (typeof RETRO_ACTIONS)[number];
export type StyleSection = (typeof STYLE_SECTIONS)[number];

export interface StyleChange { id: number; section: StyleSection; action: RetroAction; find?: string; text?: string; reason: string }
export interface RetroAnswer { summary: string; changes: StyleChange[] }
export interface FailedChange { id: number; section: StyleSection; action: RetroAction; reason: string }

/** Why an agent's answer was refused; the message is the part inside "The answer was not the expected JSON (…)". */
export class RetroAnswerError extends Error {
  constructor(message: string) { super(message); this.name = 'RetroAnswerError'; }
}

/** Where a section's body starts and ends in the document, or null when its heading is missing. The first matching heading wins. */
export function sectionRange(content: string, section: string): { start: number; end: number } | null {
  let offset = 0, start = -1;
  for (const line of content.split('\n')) {
    const next = offset + line.length + 1;
    if (start === -1) { if (line.trimEnd() === `## ${section}`) start = Math.min(next, content.length); }
    else if (line.startsWith('## ')) return { start, end: offset };
    offset = next;
  }
  return start === -1 ? null : { start, end: content.length };
}

/** Occurrences of `find` in `text`, overlapping ones included ("aa" is in "aaa" twice). */
export function occurrences(text: string, find: string): number {
  let n = 0;
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + 1)) n++;
  return n;
}

const HEADING_LINE = /^## /m;

/** The field rules every change follows, whether the agent or the owner wrote it; null when it is valid. */
export function changeProblem(c: { section?: unknown; action?: unknown; find?: unknown; text?: unknown; reason?: unknown }): string | null {
  if (!(STYLE_SECTIONS as readonly unknown[]).includes(c.section)) return `section must be one of ${STYLE_SECTIONS.join(', ')}`;
  if (!(RETRO_ACTIONS as readonly unknown[]).includes(c.action)) return 'action must be add, replace or remove';
  if (c.action === 'add') { if (c.find !== undefined) return 'find is not used by add'; }
  else if (typeof c.find !== 'string' || !c.find) return `find is required for ${String(c.action)}`;
  if (c.action === 'remove') { if (c.text !== undefined) return 'text is not used by remove'; }
  else {
    if (typeof c.text !== 'string' || !c.text) return `text is required for ${String(c.action)}`;
    if (charCount(c.text) > RETRO_TEXT_MAX) return `text must be at most ${RETRO_TEXT_MAX.toLocaleString('en-US')} characters`;
    // A heading line inside a change would split the document into a new section.
    if (HEADING_LINE.test(c.text)) return 'text must not contain a line starting with "## "';
  }
  if (typeof c.reason !== 'string' || !c.reason.trim()) return 'reason must be non-empty text';
  return null;
}

const quoted = (text: string): string => (text.length > 60 ? `${text.slice(0, 60)}…` : text);

/** Why a change cannot apply to this document, or null: its section must exist and its `find` must occur exactly once in that section. */
export function placementProblem(content: string, c: Pick<StyleChange, 'section' | 'action' | 'find'>): string | null {
  const range = sectionRange(content, c.section);
  if (!range) return `the ${c.section} section is missing from the writing style`;
  if (c.action === 'add') return null;
  const n = occurrences(content.slice(range.start, range.end), c.find!);
  return n === 1 ? null : `"${quoted(c.find!)}" must occur exactly once in ${c.section} but occurs ${n} times`;
}

/** Applies one change that `placementProblem` accepted. */
function applyOne(content: string, c: StyleChange): string {
  const { start, end } = sectionRange(content, c.section)!;
  const body = content.slice(start, end);
  let next: string;
  if (c.action === 'add') {
    const kept = body.trimEnd(), trailing = body.slice(kept.length);
    // An empty section gets the text as its body; otherwise it goes on a new line after the section's last line.
    next = kept.trim() ? `${kept}\n${c.text}${trailing || '\n'}` : `\n${c.text}\n${end === content.length ? '' : '\n'}`;
  } else {
    const at = body.indexOf(c.find!), after = at + c.find!.length;
    if (c.action === 'replace') next = body.slice(0, at) + c.text + body.slice(after);
    else {
      // A whole line goes with its newline, so no blank line is left behind.
      const wholeLine = (at === 0 || body[at - 1] === '\n') && body[after] === '\n';
      next = body.slice(0, at) + body.slice(wholeLine ? after + 1 : after);
    }
  }
  return content.slice(0, start) + next + content.slice(end);
}

/**
 * Applies the changes in order, each checked against the document as the earlier ones left it. Nothing is applied
 * when any change fails or the result would pass the section limit; every failing change is listed.
 */
export function applyChanges(content: string, changes: StyleChange[]): { content: string } | { failed: FailedChange[] } {
  const failed: FailedChange[] = [];
  let next = content;
  for (const c of changes) {
    const problem = placementProblem(next, c);
    if (problem) failed.push({ id: c.id, section: c.section, action: c.action, reason: problem });
    else next = applyOne(next, c);
  }
  if (failed.length) return { failed };
  if (charCount(next) > SECTION_MAX_CHARS) {
    const reason = `the writing style would be over ${SECTION_MAX_CHARS.toLocaleString('en-US')} characters`;
    return { failed: changes.map((c) => ({ id: c.id, section: c.section, action: c.action, reason })) };
  }
  return { content: next };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const CHANGE_KEYS = ['section', 'action', 'find', 'text', 'reason'];

/**
 * The agent's answer, which must be exactly `{ summary, changes }` (surrounding whitespace aside): no code fence, no
 * words around it, no extra fields. Each `find` must occur exactly once in its section of `style`, the document
 * the agent was shown.
 */
export function parseRetroAnswer(raw: string, style: string): RetroAnswer {
  const text = raw.trim();
  if (text.startsWith('```')) throw new RetroAnswerError('it is wrapped in a code fence');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RetroAnswerError('it is not one complete JSON object with nothing around it'); }
  if (!isPlainObject(value)) throw new RetroAnswerError('it is not a JSON object');
  const extra = Object.keys(value).find((k) => k !== 'summary' && k !== 'changes');
  if (extra) throw new RetroAnswerError(`unexpected field "${extra}"`);
  if (typeof value.summary !== 'string' || !value.summary.trim()) throw new RetroAnswerError('summary must be non-empty text');
  if (!Array.isArray(value.changes)) throw new RetroAnswerError('changes must be a list');
  if (value.changes.length > RETRO_CHANGES_MAX) throw new RetroAnswerError(`more than ${RETRO_CHANGES_MAX} changes`);
  const changes = value.changes.map((c: unknown, id): StyleChange => {
    const fail = (why: string) => new RetroAnswerError(`change ${id + 1}: ${why}`);
    if (!isPlainObject(c)) throw fail('it is not an object');
    const unknownKey = Object.keys(c).find((k) => !CHANGE_KEYS.includes(k));
    if (unknownKey) throw fail(`unexpected field "${unknownKey}"`);
    const problem = changeProblem(c);
    if (problem) throw fail(problem);
    const change = { id, section: c.section, action: c.action, ...(c.find !== undefined && { find: c.find }), ...(c.text !== undefined && { text: c.text }), reason: c.reason } as StyleChange;
    const placement = placementProblem(style, change);
    if (placement) throw fail(placement);
    return change;
  });
  return { summary: value.summary, changes };
}

/** No agent call when there is nothing to compare: no draft, or one draft that is exactly the finalized text. */
export const retroSkipped = (drafts: readonly string[], finalized: string | null): boolean =>
  drafts.length === 0 || (drafts.length === 1 && drafts[0] === finalized);

/** What was written, as the prompt and the source line name it. */
export const retroLabel = (kind: AssetKind, platform: Platform | null, format: string | null): string =>
  kind === 'script' || !platform ? 'Video script' : `${PLATFORM_LABELS[platform]} · ${format}`;

export interface RetroPromptInput { label: string; drafts: { round: number; text: string }[]; finalized: string; style: string }

/** The retro's input. Only the drafts, the finalized text and the writing style: no chat transcript, folder path or id. Secrets are removed. */
export function retroPrompt({ label, drafts, finalized, style }: RetroPromptInput): string {
  const shown = drafts.map((d, i) => `### Draft ${i + 1} (round ${d.round})\n\n${d.text}`).join('\n\n');
  return redactSecrets([
    `What was written: ${label}`,
    `## Drafts the writing agent saved, oldest first\n\n${shown}`,
    `## The text the owner finalized\n\n${finalized}`,
    `## The current writing style document\n\n${style}`,
  ].join('\n\n'));
}

export interface ImportedText { label: string; text: string }
export interface LearnPromptInput { title: string; script: string | null; posts: ImportedText[]; style: string }

/** What the owner finished outside the system, as "Learn from this" reads it. No folder path or id; secrets are removed. */
export function learnPrompt({ title, script, posts, style }: LearnPromptInput): string {
  return redactSecrets([
    `The imported Concept: ${title}`,
    script === null ? '' : `## Its script\n\n${script}`,
    ...posts.map((p) => `## ${p.label}\n\n${p.text}`),
    `## The current writing style document\n\n${style}`,
  ].filter(Boolean).join('\n\n'));
}

/** The answer format and rules every retro-style agent follows, then the writing skill and the performance section. */
function retroAgentInstructions(job: string, reasonRule: string, skillText: string | null, performance: string): string {
  const sections = STYLE_SECTIONS.map((s) => `"${s}"`).join(', ');
  return redactSecrets([
    job,
    `Respond only with your final JSON per the given schema: "status" (always "done"), "message" (one short line) and "text". "text" must be exactly one JSON object and nothing else, with no code fence and no other words:
{ "summary": string, "changes": [ { "section": one of ${sections}, "action": "add" | "replace" | "remove", "find"?: string, "text"?: string, "reason": string } ] }
Rules: at most ${RETRO_CHANGES_MAX} changes. "add" appends "text" to the end of the section and has no "find". "replace" swaps "find" for "text". "remove" deletes "find" and has no "text". "find" must be copied exactly from that section and occur there exactly once. "text" is at most ${RETRO_TEXT_MAX.toLocaleString('en-US')} characters and never contains a line starting with "## ". "reason" says ${reasonRule}. "summary" is one sentence. When there is nothing worth learning, answer with an empty "changes" list.`,
    skillText === null ? '' : `## Writing skill\n\nThe owner's writing follows this skill; style rules you propose should agree with it.\n\n${skillText}`,
    performance,
  ].filter(Boolean).join('\n\n'));
}

/** The retro agent's instructions; the writing skill's text is included when its file could be read. */
export const retroInstructions = (skillText: string | null, performance = ''): string => retroAgentInstructions(
  `You improve a business's writing style document. You are shown every draft a writing agent saved for one piece of writing, the text the owner finally approved, and the current writing style. Work out what the owner changed between the drafts and the finalized text, and propose style changes that would make the next drafts need fewer edits. Only propose a rule the edits clearly support. Do not use any tools.`,
  'which edit the change comes from', skillText, performance,
);

/** The instructions of "Learn from this": like a retro, but there are no drafts to compare, only finished text. */
export const learnInstructions = (skillText: string | null, performance = ''): string => retroAgentInstructions(
  `You improve a business's writing style document. You are shown one Concept the owner wrote outside this system (its script and post texts, all finished and often already published) and the current writing style. There are no drafts and no edits to compare: only finished text. Work out how the owner writes (voice, structure, hooks, length) and propose style changes that would make new drafts sound like this. Only propose a rule the text clearly supports. Do not use any tools.`,
  'which part of the text the change comes from', skillText, performance,
);

const EDIT_KEYS = ['id', 'find', 'text'];

/**
 * The changes an accept applies: the proposal's own, minus the excluded ids, with the owner's edits to `find` and
 * `text` (section and action stay fixed). Exclusion wins over an edit; a repeated id counts once. Edited changes
 * follow the same field rules as the agent's.
 */
export function chooseChanges(changes: StyleChange[], body: Record<string, unknown>): StyleChange[] {
  const ids = new Set(changes.map((c) => c.id));
  const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && ids.has(v);
  const exclude = body.exclude === undefined ? [] : body.exclude, edits = body.changes === undefined ? [] : body.changes;
  if (!Array.isArray(exclude) || !exclude.every(isId)) throw new ContentInputError('exclude must be a list of change ids of this proposal', 'exclude');
  const isEdit = (e: unknown): e is { id: number; find?: string; text?: string } => isPlainObject(e) && isId(e.id)
    && Object.keys(e).every((k) => EDIT_KEYS.includes(k)) && ['find', 'text'].every((k) => e[k] === undefined || typeof e[k] === 'string');
  if (!Array.isArray(edits) || !edits.every(isEdit)) throw new ContentInputError('changes must be a list of { id, find, text } for changes of this proposal', 'changes');
  const left = new Set(exclude);
  const kept = changes.filter((c) => !left.has(c.id));
  if (!kept.length) throw new ContentInputError('Tick at least one change, or discard the proposal', 'exclude');
  return kept.map((c) => {
    const edit = edits.filter((e) => e.id === c.id).at(-1);
    if (!edit) return c;
    const next: StyleChange = { ...c, ...(edit.find !== undefined && { find: edit.find }), ...(edit.text !== undefined && { text: edit.text }) };
    const problem = changeProblem(next);
    if (problem) throw new ContentInputError(`Change ${c.id + 1}: ${problem}`, 'changes');
    return next;
  });
}

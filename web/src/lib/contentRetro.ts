/**
 * The writing-style retro as the web draws it: diffs of a proposed change against the current section text, the
 * labels of proposals, the retro log and the finalized text's retro status. Pure, so it is tested without a DOM.
 * The section rules mirror server/src/content/retroRules.ts: a section's body runs from its `## <name>` line to the
 * next `## ` line or the end of the document.
 */
import { PLATFORM_LABELS } from './contentRules';
import type { AssetKind } from './contentRules';
import type { RetroStatusDto } from './contentStudio';
import type { AcceptBody, FailedChangeDto, RetroLogEntryDto, RetroSourceDto, StyleChangeDto, StyleHistoryDto } from './contentTypes';
import { formatLabel } from './contentView';

export const RETRO_TEXT_MAX = 2_000;
export const RETRO_KINDS: readonly AssetKind[] = ['script', 'post-text', 'article'];

/** The section's body, or null when its heading is missing. */
export function sectionBody(content: string, section: string): string | null {
  const lines = content.split('\n');
  const at = lines.findIndex((l) => l.trimEnd() === `## ${section}`);
  if (at === -1) return null;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

export interface DiffLine { kind: 'context' | 'removed' | 'added' | 'note'; text: string }

const nonEmpty = (lines: string[]) => lines.filter((l) => l.trim());

/** One line of the section around the change, `−` for `find` and `+` for `text`; a muted note when there is nothing to anchor to. */
export function changeDiff(content: string, change: StyleChangeDto): DiffLine[] {
  const added: DiffLine[] = change.text === undefined ? [] : change.text.split('\n').map((text) => ({ kind: 'added', text }));
  const body = sectionBody(content, change.section);
  if (body === null) return [{ kind: 'note', text: `${change.section} is missing from the writing style` }, ...added];
  if (change.action === 'add') {
    const last = nonEmpty(body.split('\n')).at(-1);
    return [last === undefined ? { kind: 'note', text: `${change.section} is empty` } : { kind: 'context', text: last }, ...added];
  }
  const find = change.find ?? '';
  const at = body.indexOf(find);
  if (!find || at === -1) return [{ kind: 'note', text: `"${find}" is not in ${change.section} any more` }, ...added];
  const above = nonEmpty(body.slice(0, at).split('\n').slice(0, -1)).at(-1);
  const below = nonEmpty(body.slice(at + find.length).split('\n').slice(1))[0];
  return [
    ...(above === undefined ? [] : [{ kind: 'context' as const, text: above }]),
    ...find.split('\n').map((text) => ({ kind: 'removed' as const, text })),
    ...added,
    ...(below === undefined ? [] : [{ kind: 'context' as const, text: below }]),
  ];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The Accept button counts what is ticked; nothing ticked disables it with a hint. */
export function acceptLabel(ticked: number, total: number): { label: string; disabled: boolean; hint: string | null } {
  return {
    label: ticked === total ? `Accept ${plural(ticked, 'change')}` : `Accept ${ticked} of ${total} changes`,
    disabled: ticked === 0,
    hint: ticked === 0 ? 'Tick at least one change, or discard the proposal.' : null,
  };
}

/** The Writing style tab's badge: hidden at 0, "99+" past 99. */
export const badgeText = (count: number): string | null => (count <= 0 ? null : count > 99 ? '99+' : String(count));
export const badgeLabel = (count: number): string => `${plural(count, 'pending proposal')}`;

export const KIND_LABELS: Record<AssetKind, string> = { script: 'Script', video: 'Video', 'post-text': 'Post text', 'image-set': 'Image set', article: 'Article', thumbnail: 'Thumbnail' };

/** "Video script" for a script, otherwise the platform and format. */
export const sourcePlatform = (source: Pick<RetroSourceDto, 'platform' | 'format'>): string =>
  source.platform ? `${PLATFORM_LABELS[source.platform]} · ${formatLabel(source.format ?? '')}` : 'Video script';

/** The chips of a retro's source: "Learn from this" reads a whole imported Concept, so it names no asset or platform. */
export const sourceChips = (source: RetroSourceDto): string[] => (source.kind === 'imported' ? ['Imported'] : [KIND_LABELS[source.assetKind], sourcePlatform(source)]);

export const draftsLine = (draftCount: number, roundCount: number): string => `from ${plural(draftCount, 'draft')} in ${plural(roundCount, 'round')}`;

export const logRowText = (entry: Pick<RetroLogEntryDto, 'status' | 'reason'>): string => (entry.status === 'failed' ? `Retro failed: ${entry.reason ?? 'unknown reason'}` : 'Nothing to learn');

export const actionLabel = (change: Pick<StyleChangeDto, 'action' | 'section'>): string =>
  `${{ add: 'Add to', replace: 'Replace in', remove: 'Remove from' }[change.action]} ${change.section}`;

/** One line of the alert a refused accept shows. */
export function staleMessage(failed: FailedChangeDto, change: StyleChangeDto | undefined): string {
  const head = `Change ${failed.id + 1} (${actionLabel(failed)})`;
  return change?.find && /exactly once/.test(failed.reason) ? `${head}: "${change.find}" no longer occurs exactly once in ${failed.section}` : `${head}: ${failed.reason}`;
}

export const charCounter = (text: string): string => `${[...text].length.toLocaleString('en-US')} of ${RETRO_TEXT_MAX.toLocaleString('en-US')} characters`;

/** What an edited change is missing, by field; empty when it can be applied. */
export function editProblems(change: Pick<StyleChangeDto, 'action' | 'find' | 'text'>): { find?: string; text?: string } {
  const out: { find?: string; text?: string } = {};
  if (change.action !== 'add' && !change.find) out.find = 'Required';
  if (change.action !== 'remove') {
    if (!change.text) out.text = 'Required';
    else if ([...change.text].length > RETRO_TEXT_MAX) out.text = `At most ${RETRO_TEXT_MAX.toLocaleString('en-US')} characters`;
  }
  return out;
}

export type ChangeEdits = Record<number, { find?: string; text?: string }>;

/** The accept request: excluded ids, and with Edit open the changed `find`/`text` of every change that stays in. */
export function acceptBody(changes: StyleChangeDto[], excluded: ReadonlySet<number>, edits: ChangeEdits | null): AcceptBody {
  const body: AcceptBody = {};
  if (excluded.size) body.exclude = [...excluded].sort((a, b) => a - b);
  if (edits) {
    const edited = changes.filter((c) => !excluded.has(c.id) && edits[c.id]).map((c) => {
      const e = edits[c.id]!;
      return { id: c.id, ...(e.find !== undefined && e.find !== c.find && { find: e.find }), ...(e.text !== undefined && e.text !== c.text && { text: e.text }) };
    }).filter((e) => Object.keys(e).length > 1);
    if (edited.length) body.changes = edited;
  }
  return body;
}

export const historyWho = (who: StyleHistoryDto['who']): string => ({ person: 'Person', agent: 'Agent', retro: 'Retro' })[who];

export const canRunRetro = (kind: AssetKind, state: string, readOnly: boolean, retro: RetroStatusDto | null): boolean =>
  RETRO_KINDS.includes(kind) && state === 'finalized' && !readOnly && retro?.status !== 'running';

export const retroConflictText = (kind: AssetKind): string => `A retro is already running for this ${KIND_LABELS[kind].toLowerCase()}.`;
export const DISCARD_TOAST = 'Proposal discarded. Run retro on the text to get a new one.';
export const AUTO_APPLY_REFUSED = 'Auto-apply was refused, so this waits for you.';
export const RUN_RETRO_TITLE = 'Compare the drafts with the final text and suggest Writing style changes';

export interface RetroStatusLine { lead: string; detail: string | null; failed: boolean; link: 'proposals' | 'history' | null }

/** The line under a finalized text's actions: its last retro, or nothing when it never had one. */
export function retroStatusLine(retro: RetroStatusDto | null): RetroStatusLine | null {
  if (!retro) return null;
  const n = retro.changeCount ?? 0;
  switch (retro.status) {
    case 'running': return { lead: 'Retro running', detail: 'Comparing the drafts with the final text. You can leave this page.', failed: false, link: null };
    case 'proposal': return { lead: `Retro: ${plural(n, 'style change')} to review`, detail: null, failed: false, link: 'proposals' };
    case 'applied': return { lead: `Retro: ${plural(n, 'style change')} applied`, detail: null, failed: false, link: 'history' };
    case 'discarded': return { lead: 'Retro: proposal discarded', detail: 'Run retro to get a new one.', failed: false, link: null };
    case 'nothing': return { lead: 'Retro: Nothing to learn', detail: 'Your final text kept the agent’s style.', failed: false, link: null };
    case 'skipped': return { lead: 'Retro: Nothing to learn', detail: 'The final text is the agent’s only draft, unchanged.', failed: false, link: null };
    case 'failed': return { lead: `Retro failed: ${retro.reason ?? 'unknown reason'}`, detail: 'Run retro to try again.', failed: true, link: null };
  }
}

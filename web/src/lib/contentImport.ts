/**
 * Imported Concepts as the web draws them: the import session's states and rows, the Imported filter and list copy, the
 * read-only tabs and "Learn from this". Pure, so each rule is tested without a DOM.
 */
import { formatLabel, READ_ONLY_TITLE } from './contentView';
import type { ConceptDto, PostDto } from './contentTypes';
import type { RetroStatusDto } from './contentStudio';
import { PLATFORM_LABELS } from './contentRules';
import type { ConceptTab } from './contentRules';
import { isPostTextTab, postsForTab, textAssetOf } from './contentPostTabs';
import { summaryLine } from './contentStats';

export interface ImportSessionDto { id: string; state: 'running' | 'ended'; executorId: string; createdAt: string; updatedAt: string }
/** Mirrors `ImportSessionView` in server/src/content/importSessions.ts. */
export interface ImportSessionViewDto { rev: number; session: ImportSessionDto | null; saved: ConceptDto[]; blockedReason: string | null }
export interface ImportSessionEvent { type: 'contentImportSession'; buildingId: string; view: ImportSessionViewDto }

export const IMPORT_IDLE_TITLE = 'Give an agent your past content to import';
export const IMPORTED_NOTE = 'Imported content is read-only. Agents read it as reference.';
export const IMPORTED_HINT = "There's no Add post, Finalize or Back to draft here, because imported posts are published as they are. To change the content, delete the Concept and import it again.";
export const IMPORT_FACTS = 'Tell the agent about content you made outside this system. It works out the Concepts and saves them as imported and published.';
export const IMPORT_FOOT = 'You can leave this page. The session keeps running, and Import past concept brings you back.';
export const IMPORT_EMPTY_LEAD = 'Nothing imported yet.';
export const IMPORT_EMPTY_HINTS = ['Post text, scripts and articles', 'Links to the live posts', 'Dates, and any stats you have', 'File paths to exports or notes'];

export const importSessionRunning = (view: ImportSessionViewDto | undefined): boolean => view?.session?.state === 'running';
export const importButtonLabel = (running: boolean): string => (running ? 'Continue import' : 'Import past concept');
export const importButtonTitle = (readOnly: boolean): string => (readOnly ? READ_ONLY_TITLE : IMPORT_IDLE_TITLE);

/** The view with the higher rev: a live event and an answer can arrive in either order. */
export const newerImportView = (current: ImportSessionViewDto | undefined, incoming: ImportSessionViewDto): ImportSessionViewDto => (current && current.rev > incoming.rev ? current : incoming);

export interface ImportPaneModel {
  badge: string; live: boolean; showTerminal: boolean;
  /** The box in place of the terminal; null while the agent works. */
  box: { lead: string; sub: string | null; action: 'start' | 'resume' | null; actionLabel: string | null } | null;
  foot: string | null; canEnd: boolean; canStartNew: boolean;
}

const pane = (badge: string, box: ImportPaneModel['box'], canStartNew = false): ImportPaneModel => ({ badge, live: false, showTerminal: false, box, foot: null, canEnd: false, canStartNew });

/** Which of the six states the session view is in. `starting` covers the wait for the first answer. */
export function importPaneModel(view: ImportSessionViewDto | undefined, readOnly: boolean, starting: boolean): ImportPaneModel {
  const session = view?.session ?? null;
  if (session?.state === 'running') return { badge: 'Agent working', live: true, showTerminal: true, box: null, foot: IMPORT_FOOT, canEnd: !readOnly, canStartNew: false };
  if (readOnly) return pane('No session', { lead: 'This Building is read-only, so no session is started.', sub: null, action: null, actionLabel: null });
  if (starting || !view) return pane('Starting', { lead: 'Starting the agent…', sub: null, action: null, actionLabel: null });
  if (session) return pane('Session ended', { lead: 'Session ended', sub: 'Everything the agent saved is kept.', action: 'resume', actionLabel: 'Resume' }, true);
  if (view.blockedReason) return pane('No session', { lead: view.blockedReason, sub: null, action: 'start', actionLabel: 'Start' });
  return pane('Starting', { lead: 'Starting the agent…', sub: null, action: null, actionLabel: null });
}

export const importCount = (view: ImportSessionViewDto | undefined): string => (view?.saved.length ? `(${view.saved.length})` : '');

const shortDate = (at: string, timeZone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(at));

const postChip = (post: PostDto, timeZone: string): string => `${PLATFORM_LABELS[post.platform]} ${formatLabel(post.format).toLowerCase()} · ${shortDate(post.publishedAt ?? post.scheduledAt, timeZone)}`;

/** The first post with stats, in that platform's own words; unknown counts are left out, never shown as 0. */
function statsLine(concept: ConceptDto): string {
  const post = concept.posts.find((p) => p.stats?.latest);
  if (!post) return 'No stats';
  return summaryLine(post.platform, post.stats!.latest!, null).slice(0, 3).map((s) => `${s.label} ${s.value}`).join(' · ') || 'No stats';
}

export interface ImportedRowModel { id: string; title: string; chips: string[]; stats: string }
export const importedRowModel = (concept: ConceptDto, timeZone: string): ImportedRowModel =>
  ({ id: concept.id, title: concept.title, chips: concept.posts.map((p) => postChip(p, timeZone)), stats: statsLine(concept) });

/** The Concepts new in `next`; nothing on the first look (`seen` null), so opening the view raises no toast. */
export function newlyImported(seen: ReadonlySet<string> | null, next: ConceptDto[]): ConceptDto[] {
  return seen ? next.filter((c) => !seen.has(c.id)) : [];
}
export const importedToast = (title: string): string => `Imported: ${title}`;

export type ImportedFilter = '' | 'true' | 'false';
export const IMPORTED_FILTER_LABELS: Record<ImportedFilter, string> = { '': 'Imported or not', true: 'Imported only', false: 'Not imported' };
export const IMPORTED_FILTERS: ImportedFilter[] = ['', 'true', 'false'];

/** The list's empty state: "Imported only" points at the import, every other filter at New. */
export const listEmptyKind = (imported: ImportedFilter): 'imported' | 'any' => (imported === 'true' ? 'imported' : 'any');

export interface ImportedTabContent {
  note: string;
  /** The text to show; null when the tab shows only the note and `elsewhere` or `empty`. */
  text: string | null;
  /** Each "Elsewhere: …" line of the posts the tab covers. */
  elsewhere: string[];
  empty: string | null;
}

const ELSEWHERE = (text: string): string => `Elsewhere: ${text}`;
const mediaFormats: Partial<Record<ConceptTab, readonly string[]>> = { video: ['video', 'reel'], thumbnail: ['video', 'reel'], images: ['image', 'carousel'] };
const NOTHING_DESCRIBED: Partial<Record<ConceptTab, string>> = { video: 'No video was described for this Concept.', thumbnail: 'No thumbnail was described for this Concept.', images: 'No images were described for this Concept.' };

/** What a read-only tab of an imported Concept shows. `post` is the post a text tab has selected. */
export function importedTabContent(concept: ConceptDto, tab: ConceptTab, post: PostDto | null): ImportedTabContent {
  const base = { note: IMPORTED_NOTE, text: null, elsewhere: [] as string[], empty: null };
  if (tab === 'script') {
    const script = concept.assets.find((a) => a.kind === 'script');
    const text = script?.state === 'finalized' ? script.content : null;
    return { ...base, text, empty: text === null ? 'No script was imported.' : null };
  }
  if (isPostTextTab(tab)) {
    const text = post ? textAssetOf(post)?.content ?? null : null;
    return { ...base, text, elsewhere: post?.externalAssets ? [ELSEWHERE(post.externalAssets)] : [], empty: text === null ? 'No text was imported.' : null };
  }
  const formats = mediaFormats[tab] ?? [];
  const elsewhere = concept.posts.filter((p) => formats.includes(p.format) && p.externalAssets).map((p) => ELSEWHERE(p.externalAssets!));
  return { ...base, elsewhere, empty: elsewhere.length ? null : NOTHING_DESCRIBED[tab] ?? null };
}

/** The post-text tabs keep their switcher; these are the posts it offers. */
export const importedTabPosts = (concept: ConceptDto, tab: ConceptTab): PostDto[] => (isPostTextTab(tab) ? postsForTab(concept.posts, tab) : []);

export const IMPORTED_BAND = 'Imported from outside the system.';
export const IMPORTED_BAND_MORE = 'Agents read it as reference content for voice, hooks and length. They never copy it.';
export const IMPORTED_DELETE_CONFIRM = 'Delete this Concept and its posts, stats and files?';
export const LEARN_CONFLICT = "Couldn't start: a learning run for this Concept is already going. Try again when it ends.";
export const LEARN_LINK = 'Writing style › Pending proposals';

export interface LearnModel {
  button: string; running: boolean; disabled: boolean; title: string | undefined;
  /** The status line, `link` when it ends with the link to the pending proposals, `alert` when it is a refusal. */
  line: { text: string; link: boolean; alert: boolean } | null;
}

function learnLine(status: RetroStatusDto | null, refusal: string | null): LearnModel['line'] {
  if (refusal) return { text: refusal, link: false, alert: true };
  if (status?.status === 'running') return { text: 'Learning… an agent is comparing this Concept with your writing style.', link: false, alert: false };
  if (status?.status === 'proposal') return { text: 'Done. A style proposal is ready:', link: true, alert: false };
  if (status?.status === 'applied') return { text: 'Done. The change is in your writing style.', link: false, alert: false };
  if (status?.status === 'nothing') return { text: 'Done. There was nothing new to learn from this Concept.', link: false, alert: false };
  if (status?.status === 'failed') return { text: `Learning failed: ${status.reason ?? 'unknown reason'}`, link: false, alert: true };
  return null;
}

/** The "Learn from this" button and its line, from the last run's status and a refused start. */
export function learnModel(status: RetroStatusDto | null, refusal: string | null, readOnly: boolean): LearnModel {
  const running = status?.status === 'running';
  return { button: running ? 'Learning…' : 'Learn from this', running, disabled: readOnly || running, title: readOnly ? READ_ONLY_TITLE : undefined, line: learnLine(status, refusal) };
}

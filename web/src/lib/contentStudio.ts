/**
 * The agent pane of a Concept tab (the Script tab first): what the daemon sends (mirrors
 * server/src/content/studioSessions.ts) and the pure rules the pane is drawn from.
 */
import type { ImportSessionEvent } from './contentImport';
import type { AssetState } from './contentRules';
import type { VideoPartDto } from './contentVideo';
import type { ImagesPartDto, ThumbnailPartDto } from './contentImages';

export interface StudioSessionDto {
  id: string; conceptId: string; assetId: string; tab: string; round: number; state: 'running' | 'ended'; executorId: string; createdAt: string; updatedAt: string;
}
export interface StudioRoundDto { round: number; startedAt: string; draft: { text: string; savedAt: string } | null }
export interface StudioViewDto {
  /** Grows with every view the daemon builds; an older view that arrives late is dropped. */
  rev: number;
  conceptId: string;
  assetId: string;
  asset: { state: AssetState; round: number; finalizedAt: string | null; content: string | null };
  session: StudioSessionDto | null;
  rounds: StudioRoundDto[];
  skillWarning: string | null;
  /** Why the asset has no session although it should have one (no usable agent, ...); null once a session exists. */
  blockedReason: string | null;
  /** The asset's last writing-style retro, or null when it never had one. */
  retro: RetroStatusDto | null;
  /** The Video tab's part; only on the video asset. */
  video?: VideoPartDto;
  /** The Images tab's part; only on an image-set asset. */
  images?: ImagesPartDto;
  /** The Thumbnail tab's part; only on the thumbnail asset. */
  thumbnail?: ThumbnailPartDto;
}
export type RetroStatus = 'running' | 'proposal' | 'applied' | 'discarded' | 'nothing' | 'skipped' | 'failed';
export interface RetroStatusDto { status: RetroStatus; reason?: string; proposalId?: string; changeCount?: number; at: string }
/** `contentRetro`: a retro ended or a proposal changed (see server/src/content/retros.ts). */
export type StudioEvent = { type: 'studioAsset'; buildingId: string; view: StudioViewDto } | { type: 'contentRetro'; buildingId: string; conceptId: string; assetId: string } | ImportSessionEvent;

/** What the left half of the pane shows. `starting` is the moment between opening the tab and the session's record arriving. */
export type PaneMode = 'loading' | 'blocked' | 'starting' | 'working' | 'ended' | 'finalized';

export function paneMode(view: StudioViewDto | null, blockedReason: string | null): PaneMode {
  if (!view) return blockedReason ? 'blocked' : 'loading';
  if (view.asset.state === 'finalized') return 'finalized';
  if (!view.session) return blockedReason ? 'blocked' : 'starting';
  return view.session.state === 'ended' ? 'ended' : 'working';
}

/** Why a pane without a session cannot start: a refusal of this tab's own start, else the one the daemon kept from an automatic start. */
export const blockedReasonOf = (view: StudioViewDto | null, refused: string | null): string | null => (view?.session ? null : refused ?? view?.blockedReason ?? null);

export type ButtonState = 'hidden' | 'disabled' | 'enabled';
export interface PaneButtons { start: ButtonState; finalize: ButtonState; newSession: ButtonState; resume: ButtonState; reopen: ButtonState; copy: ButtonState }

/** Which buttons show, and which can be pressed, in each pane state. A read-only Building disables every changing button but never Copy. */
export function paneButtons(mode: PaneMode, hasText: boolean, readOnly: boolean): PaneButtons {
  const change = (show: boolean, allowed = true): ButtonState => (!show ? 'hidden' : allowed && !readOnly ? 'enabled' : 'disabled');
  const working = mode === 'working' || mode === 'ended';
  const inRound = working || mode === 'starting';
  return {
    start: change(mode === 'blocked'),
    finalize: change(inRound, working && hasText),
    newSession: change(inRound, working),
    resume: change(mode === 'ended'),
    reopen: change(mode === 'finalized'),
    copy: hasText ? 'enabled' : 'hidden',
  };
}

/** The draft the right half shows while working: the current round's newest one. */
export function currentDraft(view: StudioViewDto): { text: string; savedAt: string } | null {
  return view.rounds.find((r) => r.round === view.asset.round)?.draft ?? null;
}

/** The text Copy puts on the clipboard: the finalized text once finalized, otherwise the shown draft. */
export function shownText(view: StudioViewDto): string | null {
  return view.asset.state === 'finalized' ? view.asset.content : currentDraft(view)?.text ?? null;
}

export interface PreviousRound { round: number; startedAt: string; draft: { text: string; savedAt: string } | null }
/** Earlier rounds, newest first. */
export function previousRounds(view: StudioViewDto): PreviousRound[] {
  return view.rounds.filter((r) => r.round < view.asset.round).sort((a, b) => b.round - a.round);
}

export const EMPTY_DRAFT_TEXT = 'No draft yet. Ask the agent to write one.';
export const draftHeading = (round: number): string => `Draft · round ${round} · saved`;
export const FINALIZED_HEADING = 'Finalized';
export const confirmNewSessionText = (round: number): string => `End round ${round} and start round ${round + 1}? Nothing from this round carries over.`;
export const REOPEN_TITLE = 'Reopen to keep editing. Finalized posts that need this move back to draft.';
export const NO_AGENT_HINT = 'Make a Claude or Codex CLI agent the default coding agent from the footer (the dot beside the agent), then press Start.';
export const READ_ONLY_NO_SESSION = 'This Building is read-only, so no session is started.';

/** Keeps the newer of the view on screen and one that just arrived. */
export function newerView(current: StudioViewDto | undefined, incoming: StudioViewDto): StudioViewDto {
  return current && incoming.rev < current.rev ? current : incoming;
}

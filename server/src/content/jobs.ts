import { createJobRegistry } from '../jobs/jobRegistry.ts';
import type { TrackedJob } from '../jobs/jobRegistry.ts';

/** Content Studio background jobs: the Remotion project's dependency install, video, image and thumbnail renders, Remotion Studio and Insights refreshes, listed in the status footer. */
export type ContentJobKind = 'remotion-setup' | 'render' | 'images' | 'thumbnail' | 'remotion-studio' | 'insights';

export interface ContentJob extends TrackedJob {
  kind: ContentJobKind;
  /** Renders only. */
  conceptId?: string;
  /** Renders only: the render's id, for its Stop route. */
  renderId?: string;
  /** Image and thumbnail renders only: their asset, for its Stop route. */
  assetId?: string;
  /** 0 to 100, or null while the size of the work is unknown. */
  percent?: number | null;
  /** Image and thumbnail renders only: stills finished and asked for. */
  done?: number;
  total?: number;
  /** Remotion Studio only: whether it is still starting or serving. */
  phase?: 'starting' | 'running';
}

export interface ContentJobEvent { type: 'contentJob'; job: ContentJob }

let clock: () => Date = () => new Date();
/** Test seam: an injected clock for the progress throttle. */
export function setContentJobsClock(now: () => Date): void { clock = now; }

export const contentJobs = createJobRegistry<ContentJob, ContentJobEvent>({ now: () => clock(), event: (job) => ({ type: 'contentJob', job }) });

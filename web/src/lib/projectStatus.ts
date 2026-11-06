import type { ProjectData } from '../types';

/** The status footer's "X projects, Y working, Z blocked" summary, as counts. */
export interface ProjectStatusSummary {
  total: number;
  working: number;
  blocked: number;
}

/**
 * Counts projects by status for the status footer's summary (`StatusFooter.tsx`). A project's `status`
 * is one `BuildingStatus` ('idle' | 'developing' | 'blocked'), so `working` and `blocked` are
 * always mutually exclusive subsets of `total` — 'idle' projects count toward `total` only.
 */
export function summarizeProjectStatus(projects: ProjectData[]): ProjectStatusSummary {
  let working = 0;
  let blocked = 0;
  for (const project of projects) {
    if (project.status === 'developing') working += 1;
    else if (project.status === 'blocked') blocked += 1;
  }
  return { total: projects.length, working, blocked };
}

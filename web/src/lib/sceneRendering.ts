/**
 * The 3D village renders on demand (`frameloop="demand"` in ui/WorldView.tsx): it draws a frame
 * only when something asks for one — a camera pan, a changed prop, a moving/working robot, or the
 * periodic sky refresh below. Nothing in the town moves while every project is idle, so the GPU
 * rests.
 */

/** How often the sun, moon, sky colours and their shadows are refreshed while nothing else redraws. */
export const SKY_REFRESH_MS = 3 * 60 * 1000;

export interface SceneCoverState {
  workspaceProjectId: string | null;
  catalogOpen: boolean;
}

/**
 * True while a full-screen popup (a project workspace or the Catalog) covers the village. Robots
 * stop requesting frames then — the scene is behind a dark scrim, so animating it only costs GPU.
 * Hidden tabs need nothing here: the browser already stops requestAnimationFrame for them.
 */
export function isSceneCovered({ workspaceProjectId, catalogOpen }: SceneCoverState): boolean {
  return workspaceProjectId !== null || catalogOpen;
}

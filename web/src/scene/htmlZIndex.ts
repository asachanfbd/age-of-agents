/**
 * z-index range for every drei `<Html>` overlay the 3D board renders (building labels, yard tags, link labels).
 * The max stays below the app's fixed chrome (the `z-20` top bar and the `z-10` HUD cards) so a label that
 * pans under them is covered rather than drawn over them.
 */
export const SCENE_HTML_Z_RANGE: [number, number] = [9, 0];

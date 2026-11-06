/**
 * The 3D village's Home view: where the camera starts and where the Home button returns it. Defined
 * once, here, and not user-configurable; the camera's orbit form of it is `HOME_ORBIT` in
 * `cameraMath.ts`. Pure data (no three.js import) so node tests can import it.
 *
 * The camera sits on the +x/+z diagonal, about 36° above the horizon at the target and 68 units from
 * it, which keeps every yard on screen at 16:9 and 4:3 and closer than the fog.
 */
export type Vec3 = readonly [number, number, number];

export const DEFAULT_VIEW: { readonly target: Vec3; readonly position: Vec3; readonly fov: number } = {
  target: [2, 0, 2],
  position: [40.9, 39.97, 40.9],
  fov: 40,
};

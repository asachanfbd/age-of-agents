import * as THREE from 'three';

/** Lighting follows the displayed panorama: east is screen-right and the
 * visible sky lies north of town. Preserve astronomical elevation for shadow
 * length, rather than using the downward camera ray as a physical light ray. */
export function skyLightPosition(
  screen: { x: number; y: number },
  altitude: number,
  target: THREE.Vector3,
): THREE.Vector3 {
  const east = screen.x * 1.8;
  const north = 1;
  const horizontal = Math.hypot(east, north);
  const height = Math.max(0.12, Math.tan(Math.min(Math.PI / 2 - 0.15, Math.max(0, altitude))));
  return target.set((east - north) / Math.SQRT2 / horizontal,
    height, (-east - north) / Math.SQRT2 / horizontal).normalize().multiplyScalar(40);
}

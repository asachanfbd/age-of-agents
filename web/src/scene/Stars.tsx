import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { mulberry32 } from './random';

/** Scattered points, cheap enough as one draw call regardless of count. */
const STAR_COUNT = 260;
/** Meant to be mounted as a child of the scene's `PerspectiveCamera` (see `Scene.tsx`), a hair
 * further out than the Moon so it reads as an even more distant backdrop layer. */
const STAR_LOCAL_DISTANCE = 420;
/** Only the upper sky cone contains stars. Foreground geometry still occludes
 * them via depth testing, including when the user pans over a mountain. */
const STAR_PITCH_MAX_DEG = 17;
const STAR_YAW_MAX_DEG = 55;

/** A point uniformly placed within the safe viewing cone described above, at the fixed distance. */
function randomStarPosition(rand: () => number): [number, number, number] {
  const yaw = THREE.MathUtils.degToRad((rand() * 2 - 1) * STAR_YAW_MAX_DEG);
  const pitch = THREE.MathUtils.degToRad(4.5 + rand() * (STAR_PITCH_MAX_DEG - 4.5));
  return [
    Math.sin(yaw) * Math.cos(pitch) * STAR_LOCAL_DISTANCE,
    Math.sin(pitch) * STAR_LOCAL_DISTANCE,
    -Math.cos(yaw) * Math.cos(pitch) * STAR_LOCAL_DISTANCE,
  ];
}

function makeStarGeometry(): THREE.BufferGeometry {
  const rand = mulberry32(7);
  const positions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const [x, y, z] = randomStarPosition(rand);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/**
 * A cheap starfield: one `THREE.Points` cloud, opacity faded in/out with the
 * night cycle via `materialRef` (see `Scene` in `Scene.tsx`) —
 * no per-star animation, so this costs one draw call regardless of count.
 * `sizeAttenuation` is off: real stars are so distant they read as constant,
 * pinpoint-sized dots regardless of anything else's depth in the scene, so a
 * fixed pixel size (rather than one that shrinks with world-space distance)
 * is the physically-sensible choice here.
 */
export function Stars({ materialRef }: { materialRef: React.RefObject<THREE.PointsMaterial | null> }) {
  const geometry = useMemo(() => makeStarGeometry(), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <points geometry={geometry} frustumCulled={false}>
      <pointsMaterial
        ref={materialRef}
        color="#f5f7ff"
        size={2.5}
        sizeAttenuation={false}
        transparent
        opacity={0}
        fog={false}
        depthTest
        depthWrite={false}
      />
    </points>
  );
}

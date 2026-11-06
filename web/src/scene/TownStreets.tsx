import { Instance, Instances } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import { getISTTimeOfDayFraction } from '../lib/istTime';
import { YARD_DEPTH, YARD_SCALE, YARD_WIDTH } from '../lib/villageLayout';
import type { YardRect } from '../lib/villageLayout';
import { FENCES, GATE_PATHS, LAMPS, ROADS } from './scenery';
import { PROJECT_PLOTS, TOWN_SCALE } from './townLayout';

/**
 * The streets, their gate paths, the fences and lamps, and a pad on every plot, all laid out by
 * scenery.ts. Each kind is one instanced mesh, so the 240 plots cost a handful of draw calls and no
 * per-plot lights or shadows; only the street lamps glow at night (shared materials).
 */
const rectCenter = ([x0, z0, x1, z1]: YardRect) => ({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, width: x1 - x0, depth: z1 - z0 });
const KERB = 0.1;
/** Kerbs run along both long edges of every street road, and along the cross road. */
const kerbs: YardRect[] = ROADS.flatMap(([x0, z0, x1, z1]) => (x1 - x0 < z1 - z0
  ? [[x0 - KERB, z0, x0, z1], [x1, z0, x1 + KERB, z1]] as YardRect[]
  : [[x0, z0 - KERB, x1, z0], [x0, z1, x1, z1 + KERB]] as YardRect[]));
/** Every yard is turned a quarter turn to face its street, so its depth runs across the street. */
const pad = { across: YARD_DEPTH * YARD_SCALE, along: YARD_WIDTH * YARD_SCALE };
// Decorative scenery never blocks the ground's pan/click hit testing.
const noRaycast = () => {};

/**
 * A radial gradient (opaque center fading smoothly to transparent edge)
 * gives each streetlight a soft, blurry glow instead of a hard-edged disc —
 * plain geometry alone can't produce a blurred falloff, so it's baked into
 * a small canvas texture once and reused across every lamp's light pool.
 */
function createGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const center = canvas.width / 2;
    // Many gradual stops (rather than a bright plateau that suddenly drops)
    // approximate a Gaussian falloff, so the pool has no visible edge at all.
    const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.15, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(0.4, 'rgba(255,255,255,0.45)');
    gradient.addColorStop(0.7, 'rgba(255,255,255,0.16)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return new THREE.CanvasTexture(canvas);
}
const glowTexture = createGlowTexture();

export function TownStreets() {
  const lampMaterial = useRef<THREE.MeshStandardMaterial>(null);
  const poolCoreMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const poolHaloMaterial = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(() => {
    const hour = getISTTimeOfDayFraction() * 24;
    const night = 1 - THREE.MathUtils.smoothstep(hour, 5.5, 7.5) + THREE.MathUtils.smoothstep(hour, 17.5, 20);
    if (lampMaterial.current) lampMaterial.current.emissiveIntensity = 0.1 + night * 2;
    if (poolCoreMaterial.current) poolCoreMaterial.current.opacity = night * 0.6;
    if (poolHaloMaterial.current) poolHaloMaterial.current.opacity = night * 0.32;
  });
  return (
    <group>
      <Instances limit={ROADS.length} receiveShadow raycast={noRaycast}>
        <boxGeometry args={[1, 0.03, 1]} />
        <meshStandardMaterial color="#ece4d0" roughness={0.95} />
        {ROADS.map((road, i) => { const r = rectCenter(road); return <Instance key={i} position={[r.x, 0.015, r.z]} scale={[r.width, 1, r.depth]} />; })}
      </Instances>
      <Instances limit={kerbs.length} raycast={noRaycast}>
        <boxGeometry args={[1, 0.05, 1]} />
        <meshStandardMaterial color="#f8f4ea" roughness={0.9} />
        {kerbs.map((kerb, i) => { const r = rectCenter(kerb); return <Instance key={i} position={[r.x, 0.025, r.z]} scale={[r.width, 1, r.depth]} />; })}
      </Instances>
      <Instances limit={GATE_PATHS.length} receiveShadow raycast={noRaycast}>
        <boxGeometry args={[1, 0.03, 1]} />
        <meshStandardMaterial color="#ece4d0" roughness={0.95} />
        {GATE_PATHS.map((path, i) => { const r = rectCenter(path); return <Instance key={i} position={[r.x, 0.017, r.z]} scale={[r.width, 1, r.depth]} />; })}
      </Instances>
      {/* A pad on every plot, the size of a yard: a free plot reads as a place to move a Project to. */}
      <Instances limit={PROJECT_PLOTS.length} receiveShadow raycast={noRaycast}>
        <boxGeometry args={[1, 0.012, 1]} />
        <meshStandardMaterial roughness={0.85} />
        {PROJECT_PLOTS.map((plot, i) => (
          <Instance key={i} position={[plot.x * TOWN_SCALE, 0.062, plot.z * TOWN_SCALE]} scale={[pad.across, 1, pad.along]} color="#b9dfae" />
        ))}
      </Instances>
      <Instances limit={FENCES.length} castShadow raycast={noRaycast}>
        <boxGeometry args={[1, 1, 0.05]} />
        <meshStandardMaterial color="#f3ead7" roughness={0.9} />
        {FENCES.map((fence, i) => (
          <Instance key={i} position={[fence.x, fence.height / 2 + 0.05, fence.z]} scale={[fence.length, fence.height, 1]} rotation={[0, fence.alongX ? 0 : Math.PI / 2, 0]} />
        ))}
      </Instances>
      <Instances limit={LAMPS.length} raycast={noRaycast}>
        <cylinderGeometry args={[0.014, 0.022, 0.62, 6]} />
        <meshStandardMaterial color="#586c7d" roughness={0.5} metalness={0.3} />
        {LAMPS.map(({ x, z }) => <Instance key={`${x}:${z}`} position={[x, 0.36, z]} />)}
      </Instances>
      <Instances limit={LAMPS.length} raycast={noRaycast}>
        <boxGeometry args={[0.12, 0.025, 0.09]} />
        <meshStandardMaterial ref={lampMaterial} color="#ffefc7" emissive="#ffda89" />
        {LAMPS.map(({ x, z }) => <Instance key={`${x}:${z}`} position={[x, 0.68, z]} />)}
      </Instances>
      {/* A wide, faint halo plus a tighter, brighter core — both the same
          soft gradient texture at different sizes/opacities — read as one
          broad pool of light with no hard edge, rather than a flat disc. */}
      <Instances limit={LAMPS.length} raycast={noRaycast}>
        <circleGeometry args={[1.05, 24]} />
        <meshBasicMaterial
          ref={poolHaloMaterial}
          map={glowTexture}
          color="#ffe7a1"
          transparent
          depthWrite={false}
          opacity={0}
          blending={THREE.AdditiveBlending}
        />
        {LAMPS.map(({ x, z }) => <Instance key={`halo:${x}:${z}`} position={[x, 0.071, z]} rotation={[-Math.PI / 2, 0, 0]} />)}
      </Instances>
      <Instances limit={LAMPS.length} raycast={noRaycast}>
        <circleGeometry args={[0.45, 24]} />
        <meshBasicMaterial
          ref={poolCoreMaterial}
          map={glowTexture}
          color="#fff3d1"
          transparent
          depthWrite={false}
          opacity={0}
          blending={THREE.AdditiveBlending}
        />
        {LAMPS.map(({ x, z }) => <Instance key={`core:${x}:${z}`} position={[x, 0.072, z]} rotation={[-Math.PI / 2, 0, 0]} />)}
      </Instances>
    </group>
  );
}

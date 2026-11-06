import { useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { useWorldStore } from '../store/worldStore';
import { WORLD_BOUND } from './townLayout';
import { Ponds, Props, useTerrainTexture } from './Terrain';

const GROUND_SIZE = WORLD_BOUND * 2 + 2;
/** Pointer must move less than this many CSS pixels to count as a click, not a pan. */
const CLICK_DRIFT_PX = 4;

/**
 * The empty ground. Clicking it (a real click, not the tail end of a camera
 * pan) clears the selected building so the details panel closes.
 */
export function Ground() {
  const selectBuilding = useWorldStore((s) => s.selectBuilding);
  const pointerDownAt = useRef<{ x: number; y: number } | null>(null);
  const terrainTexture = useTerrainTexture();

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    pointerDownAt.current = { x: e.clientX, y: e.clientY };
  };

  const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
    const start = pointerDownAt.current;
    pointerDownAt.current = null;
    if (!start) return;
    const drift = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (drift < CLICK_DRIFT_PX) selectBuilding(null);
  };

  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
      >
        <planeGeometry args={[GROUND_SIZE, GROUND_SIZE]} />
        <meshStandardMaterial
          map={terrainTexture}
          roughness={1}
          transparent
          depthWrite={false}
          onBeforeCompile={(shader) => {
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <alphamap_fragment>',
              `#include <alphamap_fragment>
              float edge = max(abs(vMapUv.x - 0.5), abs(vMapUv.y - 0.5));
              diffuseColor.a *= 1.0 - smoothstep(0.43, 0.5, edge);`,
            );
          }}
        />
      </mesh>
      <Ponds />
      <Props />
    </group>
  );
}

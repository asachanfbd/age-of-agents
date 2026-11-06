import { Canvas } from '@react-three/fiber';
import { Scene } from '../scene/Scene';
import { VillageNavigation } from './VillageNavigation';
import { VillageOverlay } from './VillageOverlay';

/**
 * The 3D village. Its own module so App.tsx can lazy-load it: in cards mode three.js is never
 * downloaded, and switching away unmounts the Canvas, which disposes its WebGL context. It renders
 * on demand only — see lib/sceneRendering.ts for what asks for a frame. The totals strip and the
 * navigation card (Home button and minimap) sit over it, so they too exist only in 3D mode.
 */
export default function WorldView() {
  return (
    <>
      <Canvas shadows dpr={[1, 2]} frameloop="demand">
        <Scene />
      </Canvas>
      <VillageOverlay />
      <VillageNavigation />
    </>
  );
}

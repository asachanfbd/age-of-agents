import { useMemo } from 'react';
import { Instance, Instances } from '@react-three/drei';
import * as THREE from 'three';
import { mulberry32 } from './random';
import { PONDS, ROCKS, TREES } from './scenery';

const TEXTURE_SIZE = 1024;
/** Fixed seed so the ground texture is stable across mounts. */
const TERRAIN_SEED = 1337;

const LIGHT_PATCH = '#a9dc8c';
const DEEP_PATCH = '#6fb85f';

/**
 * Paints a clean grass texture on a 2D canvas: a fresh green base with a soft vertical gradient and
 * a few large, very soft light and deep patches for gentle variation. No soil, specks or haze.
 * Generated once from a fixed seed.
 */
function paintTerrain(ctx: CanvasRenderingContext2D, size: number, rand: () => number) {
  const base = ctx.createLinearGradient(0, 0, 0, size);
  base.addColorStop(0, '#86c971');
  base.addColorStop(1, '#7cc268');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const radius = 50 + rand() * 120;
    const color = rand() < 0.6 ? LIGHT_PATCH : DEEP_PATCH;
    const patch = ctx.createRadialGradient(x, y, 0, x, y, radius);
    patch.addColorStop(0, `${color}59`);
    patch.addColorStop(1, `${color}00`);
    ctx.fillStyle = patch;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
}

/** Procedurally generated grass texture, painted once per mount on an off-screen canvas and reused as a `CanvasTexture`. */
export function useTerrainTexture(): THREE.CanvasTexture {
  return useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = TEXTURE_SIZE;
    canvas.height = TEXTURE_SIZE;
    const ctx = canvas.getContext('2d');
    if (ctx) paintTerrain(ctx, TEXTURE_SIZE, mulberry32(TERRAIN_SEED));
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    return texture;
  }, []);
}

/** Still water with a pale foam ring where it meets the grass; both sit a hair above the ground to avoid z-fighting. */
export function Ponds() {
  return (
    <>
      {PONDS.map((pond, i) => (
        <group key={i} position={[pond.x, 0, pond.z]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
            <ringGeometry args={[pond.radius, pond.radius + 0.5, 40]} />
            <meshStandardMaterial color="#e4f5f2" roughness={0.9} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
            <circleGeometry args={[pond.radius, 40]} />
            <meshStandardMaterial color="#3fb9cc" roughness={0.3} metalness={0.1} emissive="#0d4a52" emissiveIntensity={0.12} />
          </mesh>
        </group>
      ))}
    </>
  );
}

const TREE_TONES = ['#5fb36a', '#4ea35e', '#74c06f', '#58ad7a'];
const ROCK_TONES = ['#d4d8de', '#c3c9d1', '#e0e3e8'];
// Decorative scenery never blocks the ground's pan/click hit testing.
const noRaycast = () => {};

/** Trees and rocks scattered clear of every street; each kind is one instanced mesh, so the count costs no extra draw calls. */
export function Props() {
  const round = useMemo(() => TREES.filter((tree) => !tree.pine), []);
  const pines = useMemo(() => TREES.filter((tree) => tree.pine), []);
  return (
    <group>
      <Instances limit={TREES.length} raycast={noRaycast}>
        <cylinderGeometry args={[0.07, 0.1, 0.8, 6]} />
        <meshStandardMaterial color="#8a6c4f" roughness={1} />
        {TREES.map((tree, i) => <Instance key={i} position={[tree.x, 0.4 * tree.scale, tree.z]} scale={tree.scale} />)}
      </Instances>
      <Instances limit={round.length} raycast={noRaycast}>
        <icosahedronGeometry args={[0.6, 1]} />
        <meshStandardMaterial roughness={0.9} />
        {round.map((tree, i) => <Instance key={i} position={[tree.x, 1.25 * tree.scale, tree.z]} scale={tree.scale} color={TREE_TONES[tree.tone]} />)}
      </Instances>
      <Instances limit={pines.length} raycast={noRaycast}>
        <coneGeometry args={[0.55, 1.7, 7]} />
        <meshStandardMaterial roughness={0.9} />
        {pines.map((tree, i) => <Instance key={i} position={[tree.x, 1.5 * tree.scale, tree.z]} scale={tree.scale} color={TREE_TONES[tree.tone]} />)}
      </Instances>
      <Instances limit={ROCKS.length} raycast={noRaycast}>
        <dodecahedronGeometry args={[1, 0]} />
        <meshStandardMaterial roughness={0.95} flatShading />
        {ROCKS.map((rock, i) => <Instance key={i} position={[rock.x, 0.3 * rock.scale, rock.z]} scale={[rock.scale, rock.scale * 0.7, rock.scale]} rotation={[0, rock.turn, 0]} color={ROCK_TONES[rock.tone]} />)}
      </Instances>
    </group>
  );
}

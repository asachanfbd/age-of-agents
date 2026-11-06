import { Html, Text, RoundedBox } from '@react-three/drei';
import { useWorldStore } from '../store/worldStore';
import { BUILDING_SCALE } from './visualScale';
import { CITY_POSITION } from './townLayout';
import { SCENE_HTML_Z_RANGE } from './htmlZIndex';

export const HOME_ROOF_TOP = 1.02;
const BAY_X = [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9];
const BAY_Z = [-0.72, -0.43, -0.14, 0.15, 0.44, 0.73];

/**
 * Two-story civic pavilion occupying all four plots of the central block. A click opens the full
 * Catalog modal directly (`openCatalog()`), the same "building's click opens its full surface
 * directly" pattern `ProjectYard.tsx` uses for `openWorkspace` — not the small anchored
 * `selectedId`-driven popup that used to live here (see `docs/blueprint.md`'s City Center section).
 */
export function HomeBuilding() {
  const selected = useWorldStore((s) => s.catalogOpen);
  const openCatalog = useWorldStore((s) => s.openCatalog);
  return (
    <group position={[CITY_POSITION[0], 0.07, CITY_POSITION[1]]}
      onPointerDown={(e) => { e.stopPropagation(); openCatalog(); }}
      onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { document.body.style.cursor = 'auto'; }}>
      <group scale={BUILDING_SCALE}>
        <RoundedBox args={[2.62, 0.05, 2.62]} radius={0.06} smoothness={2} position={[0, 0.025, 0]} receiveShadow>
          <meshStandardMaterial color="#d4dedd" roughness={0.85} />
        </RoundedBox>
        {/* Two wraparound curtain-wall floors, separated by a single structural belt. */}
        {[0, 1].map((floor) => (
          <group key={floor} position={[0, 0.06 + floor * 0.43, 0]}>
            <RoundedBox args={[2.22, 0.4, 1.94]} radius={0.045} smoothness={2} position={[0, 0.2, 0]} castShadow receiveShadow>
              <meshStandardMaterial color="#254f68" roughness={0.3} metalness={0.25}
                emissive={selected ? '#248ca9' : '#163e50'} emissiveIntensity={selected ? 0.3 : 0.08} />
            </RoundedBox>
            {[-1, 1].map((side) => (
              <group key={side}>
                {BAY_X.map((x, i) => (
                  <mesh key={x} position={[x, 0.21, side * 0.975]}>
                    <boxGeometry args={[0.267, 0.3, 0.012]} />
                    <meshStandardMaterial color={(i + floor) % 3 ? '#79b7cd' : '#b0dce7'} roughness={0.2} metalness={0.28}
                      emissive="#55c8e4" emissiveIntensity={0.12} />
                  </mesh>
                ))}
                {BAY_Z.map((z, i) => (
                  <mesh key={z} position={[side * 1.115, 0.21, z]}>
                    <boxGeometry args={[0.012, 0.3, 0.25]} />
                    <meshStandardMaterial color={(i + floor) % 3 ? '#79b7cd' : '#b0dce7'} roughness={0.2} metalness={0.28}
                      emissive="#55c8e4" emissiveIntensity={0.12} />
                  </mesh>
                ))}
              </group>
            ))}
            <RoundedBox args={[2.4, 0.06, 2.12]} radius={0.025} smoothness={2} position={[0, 0.42, 0]} castShadow>
              <meshStandardMaterial color="#edf0e8" roughness={0.45} metalness={0.15} />
            </RoundedBox>
          </group>
        ))}
        {/* Slender silver fins give depth and rhythm to the glazed facade. */}
        {[-1, 1].map((side) => (
          <group key={side}>
            {[-1.08, -0.75, -0.45, 0.45, 0.75, 1.08].map((x) => (
              <mesh key={x} position={[x, 0.49, side * 1.005]} castShadow>
                <boxGeometry args={[0.022, 0.86, 0.075]} />
                <meshStandardMaterial color="#c9dce3" roughness={0.4} metalness={0.35} />
              </mesh>
            ))}
            {[-0.85, -0.55, -0.25, 0.05, 0.35, 0.65, 0.85].map((z) => (
              <mesh key={z} position={[side * 1.145, 0.49, z]} castShadow>
                <boxGeometry args={[0.075, 0.86, 0.022]} />
                <meshStandardMaterial color="#c9dce3" roughness={0.4} metalness={0.35} />
              </mesh>
            ))}
          </group>
        ))}
        {/* Broad floating roof with a recessed skylight, not another story. */}
        <RoundedBox args={[2.5, 0.08, 2.22]} radius={0.035} smoothness={2} position={[0, HOME_ROOF_TOP - 0.04, 0]} castShadow>
          <meshStandardMaterial color="#e8eee9" roughness={0.45} metalness={0.15} />
        </RoundedBox>
        <mesh position={[0, HOME_ROOF_TOP + 0.006, -0.1]}>
          <boxGeometry args={[1.18, 0.012, 0.72]} />
          <meshStandardMaterial color="#417e99" roughness={0.25} metalness={0.35} />
        </mesh>
        {[-0.4, -0.2, 0, 0.2, 0.4].map((x) => (
          <mesh key={x} position={[x, HOME_ROOF_TOP + 0.014, -0.1]}>
            <boxGeometry args={[0.015, 0.008, 0.72]} />
            <meshStandardMaterial color="#9dcbd7" />
          </mesh>
        ))}
        {[-1, 1].map((side) => (
          <mesh key={side} position={[0, 0.95, side * 1.065]}>
            <boxGeometry args={[2.25, 0.014, 0.012]} />
            <meshStandardMaterial color="#acf4ff" emissive="#4acde9" emissiveIntensity={1.1} />
          </mesh>
        ))}
        {/* Double-height central portal and a sheltered pedestrian entrance. */}
        <mesh position={[0, 0.48, 1.01]}>
          <boxGeometry args={[0.48, 0.82, 0.025]} />
          <meshStandardMaterial color="#183d52" roughness={0.25} metalness={0.25} />
        </mesh>
        {[-0.105, 0.105].map((x) => (
          <mesh key={x} position={[x, 0.23, 1.03]}>
            <boxGeometry args={[0.185, 0.32, 0.012]} />
            <meshStandardMaterial color="#8fd3df" roughness={0.2} metalness={0.25} />
          </mesh>
        ))}
        <RoundedBox args={[0.85, 0.045, 0.35]} radius={0.015} smoothness={2} position={[0, 0.5, 1.12]} castShadow>
          <meshStandardMaterial color="#dbf3f2" roughness={0.3} metalness={0.2} />
        </RoundedBox>
        <Text position={[0, 0.76, 1.032]} fontSize={0.063} letterSpacing={0.12} maxWidth={0.45} color="#efffff" anchorX="center">CITY CENTER</Text>
      </group>
      <Html position={[0, HOME_ROOF_TOP * BUILDING_SCALE + 0.3, 0]} center occlude={false} zIndexRange={SCENE_HTML_Z_RANGE}>
        <div className={`building-label${selected ? ' building-label--selected' : ''}`}>
          <div className="building-badge">
            <span className="building-name">City Center</span>
          </div>
        </div>
      </Html>
    </group>
  );
}

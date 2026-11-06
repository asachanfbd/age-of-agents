import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { WORLD_BOUND } from './townLayout';
import { currentCelestial } from './celestial';

/** The sea around the plain: it meets the grass at the ground's faded edge and fades into the fog toward the horizon. */
export function Backdrop() {
  const time = useRef(0);
  const celestial = useMemo(() => ({ sun: new THREE.Vector2(), moon: new THREE.Vector2(), power: new THREE.Vector2() }), []);
  const material = useMemo(() => {
    const material = new THREE.MeshStandardMaterial({ color: '#387d91', roughness: 0.27, metalness: 0.3 });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.sunScreen = { value: celestial.sun };
      shader.uniforms.moonScreen = { value: celestial.moon };
      shader.uniforms.reflectionPower = { value: celestial.power };
      shader.uniforms.seaTime = { get value() { return time.current; } };
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 seaPosition; varying vec4 seaClip;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nseaPosition = position;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nseaClip = gl_Position;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
          uniform float seaTime; varying vec3 seaPosition; varying vec4 seaClip;
          uniform vec2 sunScreen; uniform vec2 moonScreen; uniform vec2 reflectionPower;
          float waterReflection(vec2 screen, vec2 body) {
            float reach = max(0.0, body.y - screen.y);
            float width = 0.016 + reach * 0.055;
            float drift = sin(reach * 75.0 + seaTime * 0.9) * width * 0.22;
            float streak = exp(-pow((screen.x - body.x + drift) / width, 2.0));
            float ripples = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(reach * 290.0 + seaTime * 1.8 + screen.x * 25.0), 5.0);
            return streak * ripples * exp(-reach * 2.8) * smoothstep(0.0, 0.025, reach);
          }
        `)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          vec2 waterScreen = seaClip.xy / seaClip.w;
        `)
        .replace('#include <fog_fragment>', `#include <fog_fragment>
          float moonTrail = waterReflection(waterScreen, moonScreen) * reflectionPower.y;
          float sunTrail = waterReflection(waterScreen, sunScreen) * reflectionPower.x;
          gl_FragColor.rgb += vec3(0.58, 0.69, 0.87) * moonTrail + vec3(1.0, 0.50, 0.19) * sunTrail;

        `)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          float t = seaTime;
          vec2 p = seaPosition.xy;
          float swell = sin(p.x * 0.65 + p.y * 0.38 + t * 0.55);
          float ripple = sin(p.x * 3.8 - p.y * 2.1 + t * 1.1);
          vec3 waveNormal = normalize(vec3(0.10 * swell + 0.035 * ripple, 0.06 * cos(p.y * 1.4 + p.x * 0.7 + t * 0.7), 1.0));
          normal = normalize(vNormal + mat3(viewMatrix) * vec3(waveNormal.x, 0.0, waveNormal.y));
        `)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float shoreDistance = max(abs(seaPosition.x), abs(seaPosition.y));
          float depth = smoothstep(${WORLD_BOUND.toFixed(1)} - 3.0, ${WORLD_BOUND.toFixed(1)} + 12.0, shoreDistance);
          diffuseColor.rgb *= mix(vec3(1.15, 1.45, 1.25), vec3(0.55, 0.8, 1.0), depth);
        `);
    };
    return material;
  }, [celestial]);
  useFrame(({ clock }) => {
    time.current = clock.elapsedTime;
    const state = currentCelestial();
    celestial.sun.set(state.sunScreen.x, state.sunScreen.y);
    celestial.moon.set(state.moonScreen.x, state.moonScreen.y);
    celestial.power.set(state.sunReflection, state.moonReflection);
  });
  // Water extends far beyond the camera far plane and fades into scene fog.
  useEffect(() => () => material.dispose(), [material]);
  return <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.72, 0]} material={material}>
    <planeGeometry args={[4000, 4000]} />
  </mesh>;
}

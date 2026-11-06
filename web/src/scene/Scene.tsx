import { TownStreets } from './TownStreets';
import { MapControls, PerspectiveCamera } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useWorldStore } from '../store/worldStore';
import { SKY_REFRESH_MS, isSceneCovered } from '../lib/sceneRendering';
import { Backdrop } from './Backdrop';
import { ConnectionLines } from './ConnectionLines';
import { Ground } from './Ground';
import { HomeBuilding } from './HomeBuilding';
import { Moon } from './Moon';
import { ProjectYard } from './ProjectYard';
import { sampleSky } from './skyKeyframes';
import { Stars } from './Stars';
import { Sun } from './Sun';
import { DEFAULT_VIEW } from './defaultView';
import { MAX_DISTANCE, MAX_ELEVATION, MIN_DISTANCE, MIN_ELEVATION } from './cameraMath';
import { villageCamera, type OrbitControlsLike } from './cameraController';
import { currentCelestial } from './celestial';
import { skyLightPosition } from './skyLight';

/** Initial paint; the solar-altitude palette below takes over on every rendered frame. */
const SKY_COLOR = '#bfe0f5';

/** Fog falloff distances stay fixed across the day; only its color cycles. */
const FOG_NEAR = 230;
const FOG_FAR = 300;

/** Left-drag pans, the wheel or middle-drag zooms, right-drag (or Shift + left-drag) rotates and tilts. */
const CAMERA_MOUSE_BUTTONS = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};

export function Scene() {
  const projects = useWorldStore((s) => s.projects);
  const controlsEnabled = useWorldStore((s) => s.controlsEnabled);
  const covered = useWorldStore(isSceneCovered);
  const invalidate = useThree((s) => s.invalidate);
  const aspect = useThree((s) => s.size.width / s.size.height);
  // drei rebuilds its controls when `makeDefault` swaps the camera, so follow the store's current
  // instance instead of the first one a ref would have held.
  const controls = useThree((s) => s.controls) as OrbitControlsLike | null;

  // The camera controller (cameraController.ts) applies the clamps and street-walk zoom on every
  // controls change, runs Home and minimap flights, and pauses while a Project is dragged.
  useEffect(() => {
    return controls ? villageCamera.attach(controls, invalidate) : undefined;
  }, [controls, invalidate]);
  useEffect(() => villageCamera.followControlsEnabled(useWorldStore), []);
  useEffect(() => villageCamera.setAspect(aspect), [aspect]);
  useEffect(() => villageCamera.setCovered(covered), [covered]);
  useEffect(() => villageCamera.bindKeyboard(window), []);

  // The canvas renders on demand (lib/sceneRendering.ts), so the slow sun/moon/sky drift below only
  // repaints on this timer, or whenever something else already asked for a frame.
  useEffect(() => {
    const timer = setInterval(invalidate, SKY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [invalidate]);

  // Anything that changed while a popup covered the scene shows as soon as it closes.
  useEffect(() => {
    if (!covered) invalidate();
  }, [covered, invalidate]);

  const backgroundRef = useRef<THREE.Color>(null);
  const fogRef = useRef<THREE.Fog>(null);
  const hemisphereRef = useRef<THREE.HemisphereLight>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const moonLightRef = useRef<THREE.DirectionalLight>(null);
  const starsMaterialRef = useRef<THREE.PointsMaterial>(null);

  useFrame(() => {
    villageCamera.tick();
    const state = currentCelestial();
    // Sample the established palette by solar altitude, respecting seasonal sunrise/set.
    const elevation = THREE.MathUtils.radToDeg(state.sun.altitude);
    const paletteHour = THREE.MathUtils.mapLinear(THREE.MathUtils.clamp(elevation, -12, 18), -12, 18, 5, 8);
    const sky = sampleSky(paletteHour / 24);
    backgroundRef.current?.copy(sky.sky);
    fogRef.current?.color.copy(sky.sky);
    if (hemisphereRef.current) {
      hemisphereRef.current.color.copy(sky.hemisphereSky);
      hemisphereRef.current.groundColor.copy(sky.hemisphereGround);
      hemisphereRef.current.intensity = sky.hemisphereIntensity + state.moonLight * 0.12;
    }
    if (sunRef.current) {
      sunRef.current.color.set(elevation < 12 ? '#ffbd7a' : '#fff6e0');
      sunRef.current.intensity = sky.sunIntensity * state.sunVisibility;
      skyLightPosition(state.sunScreen, state.sun.altitude, sunRef.current.position);
    }
    if (moonLightRef.current) {
      moonLightRef.current.intensity = state.moonLight;
      // When the astronomical moon is below the horizon, retain a high, soft fill source so
      // new-moon and moonset nights remain readable instead of collapsing into black silhouettes.
      skyLightPosition(
        state.moon.altitude > 0 ? state.moonScreen : { x: -0.32, y: 0.62 },
        state.moon.altitude > 0 ? state.moon.altitude : 0.62,
        moonLightRef.current.position,
      );
    }
    if (starsMaterialRef.current) starsMaterialRef.current.opacity = state.night * (0.85 - state.moonLight * 0.3);
  });

  return (
    <>
      {/* far=2000 matches three.js's own PerspectiveCamera default; called out explicitly since
          the moon/stars mounted below are ~300-420 units out — comfortably inside it, with plenty
          of headroom to spare. */}
      <PerspectiveCamera makeDefault position={[...DEFAULT_VIEW.position]} fov={DEFAULT_VIEW.fov} far={2000}>
        <Moon />
        <Sun />
        <Stars materialRef={starsMaterialRef} />
      </PerspectiveCamera>
      <MapControls
        makeDefault
        target={[...DEFAULT_VIEW.target]}
        enabled={controlsEnabled}
        enableDamping
        dampingFactor={0.12}
        screenSpacePanning={false}
        minDistance={MIN_DISTANCE}
        maxDistance={MAX_DISTANCE}
        minPolarAngle={Math.PI / 2 - MAX_ELEVATION}
        maxPolarAngle={Math.PI / 2 - MIN_ELEVATION}
        mouseButtons={CAMERA_MOUSE_BUTTONS}
      />

      <color ref={backgroundRef} attach="background" args={[SKY_COLOR]} />
      <hemisphereLight ref={hemisphereRef} args={['#cfe9ff', '#4a6b3a', 0.95]} />
      <directionalLight
        ref={sunRef}
        position={[10, 16, 6]}
        intensity={1.35}
        color="#fff6e0"
        castShadow
        shadow-normalBias={0.008}
        shadow-bias={-0.0001}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={200}
        shadow-camera-left={-24}
        shadow-camera-right={24}
        shadow-camera-top={24}
        shadow-camera-bottom={-24}
      />
      <directionalLight ref={moonLightRef} color="#aebfe8" intensity={0} position={[0, 18, 0]} castShadow shadow-camera-far={200} shadow-mapSize-width={1024} shadow-mapSize-height={1024} shadow-camera-left={-25} shadow-camera-right={25} shadow-camera-top={25} shadow-camera-bottom={-25} shadow-normalBias={0.02} />
      <fog ref={fogRef} attach="fog" args={[SKY_COLOR, FOG_NEAR, FOG_FAR]} />

      <Backdrop />
      <Ground />
      <TownStreets />
      <HomeBuilding />
      {projects.map((project) => (
        <ProjectYard key={project.id} project={project} />
      ))}
      <ConnectionLines />
    </>
  );
}

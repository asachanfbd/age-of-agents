import * as THREE from 'three';

/**
 * Keyframe sky/light values for the real-time IST day-night cycle, plus the
 * sampling function that interpolates between them. Kept calm and pleasant
 * at every hour: no storms, no harsh colors, no pitch-black night.
 */

export interface SkyKeyframe {
  /** Hour of the IST day this keyframe represents, 0-24 (24 wraps to 0). */
  hour: number;
  /** Background/fog color. */
  sky: THREE.Color;
  hemisphereSky: THREE.Color;
  hemisphereGround: THREE.Color;
  hemisphereIntensity: number;
  sunColor: THREE.Color;
  sunIntensity: number;
  /** 0 (moon invisible, daylight) .. 1 (moon fully visible, deep night) — legacy palette darkness factor. Actual moon visibility is calculated in `celestial.ts`. */
  moonVisibility: number;
}

/** Neutral daylight fill keeps shadowed architecture legible. */
const DAY_SKY = '#a9dbfa';
const DAY_HEMISPHERE_SKY = '#eef8ff';
const DAY_HEMISPHERE_GROUND = '#c3c8a7';
const DAY_HEMISPHERE_INTENSITY = 2.0;
const DAY_SUN_COLOR = '#fff6e0';
const DAY_SUN_INTENSITY = 2.6;

function keyframe(
  hour: number,
  sky: string,
  hemisphereSky: string,
  hemisphereGround: string,
  hemisphereIntensity: number,
  sunColor: string,
  sunIntensity: number,
  moonVisibility: number,
): SkyKeyframe {
  return {
    hour,
    sky: new THREE.Color(sky),
    hemisphereSky: new THREE.Color(hemisphereSky),
    hemisphereGround: new THREE.Color(hemisphereGround),
    hemisphereIntensity,
    sunColor: new THREE.Color(sunColor),
    sunIntensity,
    moonVisibility,
  };
}

// Calm, dim (never pitch-black) cool blue night — ground/buildings
// should still read gently in the dark. The moon/stars are fully up.
const NIGHT = keyframe(0, '#203756', '#8da9c7', '#4a6072', 1.05, '#b9ccef', 0.5, 1);
// Cool sky fill and neutral ground bounce preserve natural material colors;
// the low sun provides a restrained warm accent. The moon is still low in
// the sky and fading out as the sun comes up.
const DAWN = keyframe(6, '#b7c8d5', '#e2e8ed', '#a0a18f', 1.25, '#fff0db', 0.85, 0.15);
// The established bright, clear daytime look. No moon/stars in full daylight.
const DAY = keyframe(
  8,
  DAY_SKY,
  DAY_HEMISPHERE_SKY,
  DAY_HEMISPHERE_GROUND,
  DAY_HEMISPHERE_INTENSITY,
  DAY_SUN_COLOR,
  DAY_SUN_INTENSITY,
  0,
);
// Hold clear daylight through the afternoon before a short dusk transition.
const DAY_LATE = keyframe(
  17,
  DAY_SKY,
  DAY_HEMISPHERE_SKY,
  DAY_HEMISPHERE_GROUND,
  DAY_HEMISPHERE_INTENSITY,
  DAY_SUN_COLOR,
  DAY_SUN_INTENSITY,
  0,
);
// Muted blue-gray dusk: warmth belongs in direct light, not the entire
// sky/fog and ambient fill. Hold the existing 5pm–7pm transition timing.
// The moon/stars begin fading back in as the sun sets.
const DUSK = keyframe(19, '#a5b5c7', '#dce3ee', '#92958b', 1.2, '#ffecd6', 0.8, 0.15);
// Same as NIGHT, anchored at hour 24 so the cycle wraps smoothly to midnight.
const NIGHT_WRAP: SkyKeyframe = { ...NIGHT, hour: 24 };

/** Ordered night -> dawn -> day -> day (late afternoon) -> dusk -> night keyframes across the IST day. */
const KEYFRAMES: SkyKeyframe[] = [NIGHT, { ...NIGHT, hour: 5 }, DAWN, DAY, DAY_LATE, DUSK, { ...NIGHT, hour: 21 }, NIGHT_WRAP];

/** Working scratch object reused every sample to avoid per-frame allocation. */
const sample: {
  sky: THREE.Color;
  hemisphereSky: THREE.Color;
  hemisphereGround: THREE.Color;
  hemisphereIntensity: number;
  sunColor: THREE.Color;
  sunIntensity: number;
  /** 0 (moon/stars invisible) .. 1 (fully visible) — interpolated from each keyframe's `moonVisibility`. */
  moonVisibility: number;
} = {
  sky: new THREE.Color(),
  hemisphereSky: new THREE.Color(),
  hemisphereGround: new THREE.Color(),
  hemisphereIntensity: DAY_HEMISPHERE_INTENSITY,
  sunColor: new THREE.Color(),
  sunIntensity: DAY_SUN_INTENSITY,
  moonVisibility: 0,
};

/**
 * Samples the sky/light keyframes at the given time-of-day fraction (0-1,
 * see `getISTTimeOfDayFraction`), smoothly interpolating between the
 * surrounding keyframes. Returns a reused scratch object — read it
 * immediately after calling, don't retain the reference across calls.
 */
export function sampleSky(timeOfDayFraction: number): typeof sample {
  const hour = THREE.MathUtils.clamp(timeOfDayFraction, 0, 1) * 24;

  let lower = KEYFRAMES[0];
  let upper = KEYFRAMES[KEYFRAMES.length - 1];
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    if (hour >= KEYFRAMES[i].hour && hour <= KEYFRAMES[i + 1].hour) {
      lower = KEYFRAMES[i];
      upper = KEYFRAMES[i + 1];
      break;
    }
  }

  const span = upper.hour - lower.hour;
  const localT = span > 0 ? (hour - lower.hour) / span : 0;
  // Ease in/out of each keyframe rather than interpolating linearly.
  const t = THREE.MathUtils.smoothstep(localT, 0, 1);

  sample.sky.lerpColors(lower.sky, upper.sky, t);
  sample.hemisphereSky.lerpColors(lower.hemisphereSky, upper.hemisphereSky, t);
  sample.hemisphereGround.lerpColors(lower.hemisphereGround, upper.hemisphereGround, t);
  sample.hemisphereIntensity = THREE.MathUtils.lerp(
    lower.hemisphereIntensity,
    upper.hemisphereIntensity,
    t,
  );
  sample.sunColor.lerpColors(lower.sunColor, upper.sunColor, t);
  sample.sunIntensity = THREE.MathUtils.lerp(lower.sunIntensity, upper.sunIntensity, t);
  sample.moonVisibility = THREE.MathUtils.lerp(lower.moonVisibility, upper.moonVisibility, t);

  return sample;
}

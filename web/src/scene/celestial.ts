import SunCalc from 'suncalc';
import { getThemePreference, resolveSceneTheme, systemPrefersDark } from '../lib/themePreference.ts';

/** Default observation site until a city preference is available. */
export const INDIA_LOCATION = { latitude: 28.6139, longitude: 77.2090, name: 'New Delhi' };
/** Layout baseline for the stylized celestial panorama; never clips world geometry. */
export const SKY_HORIZON = 0.18;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };

/** SunCalc 1.9 uses radians westward from south. Camera screen-right is east.
 * The visible sky compresses the hemisphere into a panorama; skyLight.ts
 * aligns the light sources with that same projection. */
export function projectCelestial(azimuth: number, altitude: number) {
  return { x: -Math.sin(azimuth) * Math.cos(altitude) * 0.82,
    y: SKY_HORIZON + 0.075 + Math.sin(Math.max(0, altitude)) * 0.35 };
}
export function celestialDirection(azimuth: number, altitude: number): [number, number, number] {
  const east = -Math.sin(azimuth) * Math.cos(altitude);
  const south = Math.cos(azimuth) * Math.cos(altitude);
  // Camera is at +x,+z: right=(+x,-z); north=(-x,-z).
  return [(east + south) / Math.SQRT2, Math.sin(altitude), (south - east) / Math.SQRT2];
}
export function sampleCelestial(date: Date, location = INDIA_LOCATION) {
  const sun = SunCalc.getPosition(date, location.latitude, location.longitude);
  const moon = SunCalc.getMoonPosition(date, location.latitude, location.longitude);
  const illumination = SunCalc.getMoonIllumination(date);
  const night = 1 - smooth(-0.18, 0.02, sun.altitude);
  const sunVisibility = smooth(-0.015, 0.025, sun.altitude);
  const moonVisibility = smooth(0, 0.04, moon.altitude) * (0.18 + 0.82 * night);
  const moonLight = night * moonVisibility * Math.pow(illumination.fraction, 1.7) * 0.65;
  return { sun, moon, illumination, night, sunVisibility, moonVisibility, moonLight,
    moonScale: 384400 / moon.distance,
    sunScreen: projectCelestial(sun.azimuth, sun.altitude),
    moonScreen: projectCelestial(moon.azimuth, moon.altitude),
    sunReflection: sunVisibility * (1 - smooth(0.05, 0.5, sun.altitude)),
    moonReflection: moonLight * 1.6,
  };
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Keeps forced Light/Dark modes on today's solar path instead of a magic fixed date. */
export function dateAtISTHour(date: Date, hour: number): Date {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const utcMidnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return new Date(utcMidnight + hour * 60 * 60 * 1000 - IST_OFFSET_MS);
}

/** A scene theme chooses real time or a representative, stable point in the day/night cycle. */
export function sampleThemedCelestial(date: Date, theme: 'light' | 'dark' | 'daytime') {
  const sampleDate = theme === 'light' ? dateAtISTHour(date, 12) : theme === 'dark' ? dateAtISTHour(date, 23) : date;
  const state = sampleCelestial(sampleDate);
  if (theme !== 'dark' && state.night < 0.01) return state;

  // Night stays atmospheric, but never depends on the lunar phase or moonrise for basic legibility.
  // The visible moon remains astronomically accurate; this floor is soft sky/moon fill.
  const night = theme === 'dark' ? 1 : state.night;
  return {
    ...state,
    night,
    sunVisibility: theme === 'dark' ? 0 : state.sunVisibility,
    sunReflection: theme === 'dark' ? 0 : state.sunReflection,
    moonLight: Math.max(state.moonLight, night * 0.5),
    moonReflection: Math.max(state.moonReflection, night * 0.35),
  };
}
// Share a single second-cached ephemeris between sky, light and water.
// Deterministic visual QA in Vite development only; production always uses real time.
const previewTime = import.meta.env?.DEV && typeof window !== 'undefined'
  ? Date.parse(new URLSearchParams(window.location.search).get('sceneTime') ?? '') : NaN;
let cachedTime = NaN;
let cachedTheme = '';
let cached: ReturnType<typeof sampleCelestial>;
export function currentCelestial() {
  const time = Math.floor((Number.isFinite(previewTime) ? previewTime : Date.now()) / 1000) * 1000;
  const theme = resolveSceneTheme(getThemePreference(), systemPrefersDark());
  if (time !== cachedTime || theme !== cachedTheme) {
    cachedTime = time;
    cachedTheme = theme;
    cached = sampleThemedCelestial(new Date(time), theme);
  }
  return cached;
}

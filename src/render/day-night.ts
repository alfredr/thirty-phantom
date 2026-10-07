import {
  Color,
  type DirectionalLight,
  type HemisphereLight,
  type Scene,
  Vector3,
} from 'three';

import { TUNING } from '@/config';
import { invLerp, lerp, smoothstep } from '@/engine/core/math';

import type { GameRenderer } from './game-renderer';
import type { LightPool } from './light-pool';
import type { ChannelLevels, MaterialLibrary } from './materials';
import { MOON_X, MOON_Y } from './post/sky-shader';

interface Look {
  skyTop: string;
  skyHorizon: string;
  haze: string;
  hemiSky: string;
  hemiGround: string;
  /** Hemisphere-light intensity, which controls brightness in shadowed areas. */
  hemi: number;
  sunColor: string;
  sun: number;
  neon: number;
  windows: number;
  lamps: number;
  signs: number;
  slime: number;
  /**
   * Bloom strength. Wide or strong bloom reads as a glowing fog over the whole
   * frame.
   */
  bloom: number;
  /** Grade exposure: brightens the lit picture without adding glow. */
  exposure: number;
  stars: number;
  clouds: number;
  cloudColor: string;
  cloudLight: string;
  skyline: string;
  skylineFar: string;
  skyWindows: number;
  shadowTint: string;
}

/** The Look fields that blend as numbers, and the ones that blend as colors. */
type NumKey = {
  [K in keyof Look]: Look[K] extends number ? K : never;
}[keyof Look];
type ColorKey = {
  [K in keyof Look]: Look[K] extends string ? K : never;
}[keyof Look];

// Use fill light and exposure to keep night scenes readable without excessive bloom.
const NIGHT: Look = {
  skyTop: '#0a0318',
  skyHorizon: '#3e1766',
  haze: '#1f0c38',
  hemiSky: '#a596d0',
  hemiGround: '#2a1f3a',
  hemi: 2.0,
  sunColor: '#d6c9ff',
  sun: 2.3,
  neon: 1,
  windows: 1,
  lamps: 1,
  signs: 1,
  slime: 1,
  bloom: 0.42,
  exposure: 1.25,
  stars: 1,
  clouds: 0.75,
  cloudColor: '#2a1450',
  cloudLight: '#9a78d8',
  skyline: '#0e0519',
  skylineFar: '#21103a',
  skyWindows: 1,
  shadowTint: '#06000c',
};

const PREDAWN: Look = {
  ...NIGHT,
  skyTop: '#160a33',
  skyHorizon: '#6a2c74',
  haze: '#331a52',
  hemi: 1.5,
  stars: 0.4,
  skyWindows: 0.7,
};

const DAWN: Look = {
  skyTop: '#3d2c7e',
  skyHorizon: '#ff8fa0',
  haze: '#8c5a8e',
  hemiSky: '#cfa6e6',
  hemiGround: '#3a2a48',
  hemi: 1.9,
  sunColor: '#ffb08a',
  sun: 2.4,
  neon: 0.5,
  windows: 0.45,
  lamps: 0.25,
  signs: 0.55,
  slime: 0.7,
  bloom: 0.34,
  exposure: 1.1,
  stars: 0,
  clouds: 0.7,
  cloudColor: '#c48ab8',
  cloudLight: '#ffd0c0',
  skyline: '#3a2852',
  skylineFar: '#7a5a8e',
  skyWindows: 0.4,
  shadowTint: '#06000a',
};

const DAY: Look = {
  skyTop: '#6a74cf',
  skyHorizon: '#dcc9f2',
  haze: '#9a8cba',
  hemiSky: '#ddd2f6',
  hemiGround: '#4a4060',
  hemi: 1.9,
  sunColor: '#fff0dc',
  sun: 3.1,
  neon: 0.32,
  windows: 0.1,
  lamps: 0,
  signs: 0.35,
  slime: 0.5,
  bloom: 0.28,
  // Raise exposure slightly to keep shaded deck walls visible with limited bloom.
  exposure: 1.1,
  stars: 0,
  clouds: 0.55,
  cloudColor: '#e9e0f6',
  cloudLight: '#ffffff',
  skyline: '#6d6189',
  skylineFar: '#a497c2',
  skyWindows: 0,
  shadowTint: '#030006',
};

const DUSK: Look = {
  ...DAWN,
  skyTop: '#2d1c66',
  skyHorizon: '#ff7656',
  haze: '#7a3f72',
  sunColor: '#ff9468',
  sun: 2.0,
  // Increase fill to compensate for the low sun angle.
  hemi: 2.0,
  exposure: 1.15,
  neon: 0.65,
  windows: 0.7,
  lamps: 0.6,
  signs: 0.7,
  slime: 0.8,
  cloudColor: '#a85a8e',
  cloudLight: '#ffb08a',
  skyWindows: 0.7,
  bloom: 0.36,
};

const KEYS: [number, Look][] = [
  [0, NIGHT],
  [5.6, NIGHT],
  [6.6, PREDAWN],
  [7.6, DAWN],
  [9.2, DAY],
  [17.4, DAY],
  [18.5, DUSK],
  [19.3, NIGHT],
  [24, NIGHT],
];

/** Night key light: the moon's direction. */
const MOONLIGHT = new Vector3(0.55, 0.75, -0.35).normalize();
const MOON_AZIMUTH = Math.atan2(MOONLIGHT.x, MOONLIGHT.z);

const _a = new Color();
const _b = new Color();

function mixColor(out: Color, a: string, b: string, t: number): Color {
  return out.copy(_a.set(a)).lerp(_b.set(b), t);
}

export interface DayNightTargets {
  scene: Scene;
  gfx: GameRenderer;
  mats: MaterialLibrary;
  hemi: HemisphereLight;
  sun: DirectionalLight;
  pool: LightPool;
  decalLevel: (lamps: number, slime: number) => void;
}

/** Drives every time-of-day dependent value from the game clock. */
export class DayNight {
  /** 0 = full day, 1 = full night. */
  nightness = 1;
  readonly sunDir = new Vector3();
  private readonly tmp = new Color();
  private readonly levels: ChannelLevels = {
    neon: 0,
    windows: 0,
    lamps: 0,
    signs: 0,
    slime: 0,
    always: 1,
  };

  constructor(private readonly t: DayNightTargets) {}

  apply(hours: number, scroll: number): void {
    let i = 0;
    while (i < KEYS.length - 2 && hours >= (KEYS[i + 1]?.[0] ?? 24)) {
      i++;
    }

    const [h0, a] = KEYS[i] as [number, Look];
    const [h1, b] = KEYS[i + 1] as [number, Look];
    const k = smoothstep(h0, h1, hours);
    const n = (key: NumKey): number => lerp(a[key], b[key], k);
    const c = (out: Color, key: ColorKey): Color =>
      mixColor(out, a[key], b[key], k);
    const { scene, gfx, mats, hemi, sun, pool } = this.t;

    c(hemi.color, 'hemiSky');
    c(hemi.groundColor, 'hemiGround');
    hemi.intensity = n('hemi');
    c(sun.color, 'sunColor');
    sun.intensity = n('sun');

    const { sunrise, nightfall } = TUNING.clock;
    const dayT = invLerp(sunrise, nightfall, hours);
    const isDay = hours >= sunrise - 0.5 && hours < nightfall + 0.3;
    if (isDay) {
      // Move the daylight direction from east to west.
      const az = lerp(-1.9, 1.9, dayT);
      const el = 0.25 + Math.sin(dayT * Math.PI) * 0.75;
      this.sunDir
        .set(
          Math.sin(az) * Math.cos(el),
          Math.sin(el),
          -Math.cos(az) * Math.cos(el) * 0.6 - 0.4,
        )
        .normalize();
    } else {
      this.sunDir.copy(MOONLIGHT);
    }

    const night = n('lamps');
    this.nightness = night;
    const lv = this.levels;
    lv.neon = n('neon');
    lv.windows = n('windows');
    lv.lamps = Math.max(0.06, night);
    lv.signs = n('signs');
    lv.slime = n('slime');
    mats.setChannels(lv);
    pool.level = night;
    this.t.decalLevel(night, lv.slime);

    const su = gfx.sky.uniforms;
    c(su.skyTop.value, 'skyTop');
    c(su.skyHorizon.value, 'skyHorizon');
    c(su.haze.value, 'haze');
    c(su.cloudColor.value, 'cloudColor');
    c(su.cloudLight.value, 'cloudLight');
    c(su.skylineColor.value, 'skyline');
    c(su.skylineFar.value, 'skylineFar');
    su.windows.value = n('skyWindows');
    su.stars.value = n('stars');
    su.clouds.value = n('clouds');
    su.scroll.value = scroll;

    // Animate the moon between the configured nightfall and sunrise times.
    const sinceDusk =
      hours >= nightfall ? hours - nightfall : hours + 24 - nightfall;
    const nightLen = 24 - nightfall + sunrise;
    const up = hours >= nightfall || hours < sunrise;
    const rise = smoothstep(0, 0.6, sinceDusk);
    const set = 1 - smoothstep(nightLen - 0.6, nightLen, sinceDusk);
    su.moonAlpha.value = up ? smoothstep(0, 0.12, sinceDusk) * set : 0;
    const mp = su.moonPos.value;
    mp.set(
      lerp(MOON_X, 0.69, invLerp(0, nightLen, sinceDusk)),
      lerp(0.74, MOON_Y, rise) - (1 - set) * 0.16,
    );
    su.sunAlpha.value = isDay
      ? smoothstep(sunrise - 0.4, sunrise + 0.5, hours) *
        (1 - smoothstep(nightfall - 0.6, nightfall, hours))
      : 0;
    su.sunPos.value.set(
      lerp(0.08, 0.92, dayT),
      0.8 + Math.sin(dayT * Math.PI) * 0.13,
    );
    // Align the chase-view sun with its light direction. Map the isometric moon's displacement to angular offsets
    // from the moonlight direction.
    su.sunDirW.value.copy(this.sunDir);
    const moonAz = MOON_AZIMUTH + (mp.x - MOON_X);
    const moonEl = mp.y - su.bandStart.value;
    su.moonDirW.value.set(
      Math.sin(moonAz) * Math.cos(moonEl),
      Math.sin(moonEl),
      Math.cos(moonAz) * Math.cos(moonEl),
    );

    gfx.bloom.strength = n('bloom');
    gfx.grade.uniforms.exposure.value = n('exposure');
    c(gfx.grade.uniforms.shadowTint.value, 'shadowTint');
    scene.background = c(this.tmp, 'haze');
  }
}

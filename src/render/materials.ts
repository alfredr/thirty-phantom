import {
  Color,
  DoubleSide,
  type Material,
  MeshNormalMaterial,
  MeshStandardMaterial,
  type MeshStandardMaterialParameters,
  NoBlending,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { LampColor } from '../world/level-data';
import { CURVE_ON, curveVertex, markCurved } from './curvature';
import { withFacade } from './facade';
import { PALETTE } from './palette';
import {
  asphaltTexture,
  concreteTexture,
  grassTexture,
  hazardTexture,
  sidewalkTexture,
} from './textures';

/**
 * Occlusion cutaway shared by every world material.
 * Inside a cylinder along the view ray through the focus point, fragments are
 * dropped if they sit between the camera and the focus (above the focus floor),
 * or anywhere above the ceiling over the focus, so the player stays visible
 * under parking-deck slabs and behind towers.
 */
export const cutUniforms = {
  uCutCenter: { value: new Vector3() },
  uCutDir: { value: new Vector3(0, 1, 0) },
  uCutRadius: { value: 0 },
  uCutMinY: { value: 0 },
  /** Fragments must be at least this far in front of the focus (keeps the focus actor itself intact). */
  uCutNear: { value: 0.8 },
  /** Everything above this height is cut, in front of the focus or not (the slab overhead). */
  uCutCeil: { value: 1e9 },
  /** Slime-green edge of the cutaway hole, round the player whenever under a slab: past 1 so it glows, kept low enough not to haze. */
  uCutRim: { value: new Color(0.45, 1.6, 0.1) },
  /** World-space dirt strength for materials compiled with GRIME. */
  uGrime: { value: 1 },
};

const CUT_FRAG_HEADER = /* glsl */ `
uniform vec3 uCutCenter;
uniform vec3 uCutDir;
uniform float uCutRadius;
uniform float uCutMinY;
uniform float uCutNear;
uniform float uCutCeil;
uniform vec3 uCutRim;
uniform float uGrime;
varying vec3 vCutWorld;
varying vec3 vCutNormal;
float cutRim = 0.0;
#ifdef GRIME
float gHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float gNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gHash(i), gHash(i + vec3(1, 0, 0)), f.x), mix(gHash(i + vec3(0, 1, 0)), gHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(gHash(i + vec3(0, 0, 1)), gHash(i + vec3(1, 0, 1)), f.x), mix(gHash(i + vec3(0, 1, 1)), gHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
vec3 applyGrime(vec3 c, vec3 p, vec3 n) {
  float macro = gNoise(p * 0.07) * 0.55 + gNoise(p * 0.31 + 11.0) * 0.3 + gNoise(p * 1.7 + 3.0) * 0.15;
  float dirt = smoothstep(0.38, 0.8, macro);
  float wall = 1.0 - smoothstep(0.35, 0.65, abs(n.y));
  // rain/slime streaks running down walls
  float st = gNoise(vec3(p.x * 2.6 + p.z * 2.6, p.y * 0.22, p.z * 0.9));
  float streak = smoothstep(0.58, 0.92, st) * wall;
  float slime = smoothstep(0.78, 0.97, gNoise(vec3(p.x * 1.3 + p.z * 1.3, p.y * 0.3 + 5.0, 7.0))) * wall;
  // oily stains on floors
  float oil = smoothstep(0.58, 0.95, gNoise(p * 0.16 + 23.0) * 0.7 + gNoise(p * 0.9 + 5.0) * 0.3) * (1.0 - wall);
  c = mix(c, c * vec3(0.38, 0.32, 0.4), dirt * 0.85 * uGrime);
  c = mix(c, c * 0.42, streak * 0.65 * uGrime);
  // grit: fine high-frequency mottling
  c *= 0.86 + 0.28 * gNoise(p * 6.0 + 41.0);
  c = mix(c, c * vec3(0.45, 0.4, 0.48), oil * 0.55 * uGrime);
  c = mix(c, vec3(0.2, 0.45, 0.03), slime * 0.6 * uGrime);
  return c;
}
#endif
`;

const CUT_FRAG_BODY = /* glsl */ `
  if (uCutRadius > 0.01) {
    vec3 cd = vCutBent - uCutCenter;
    float along = dot(cd, uCutDir);
    if ((along > uCutNear && vCutWorld.y > uCutMinY) || vCutWorld.y > uCutCeil) {
      float perp = length(cd - along * uCutDir);
      if (perp < uCutRadius) discard;
      cutRim = 1.0 - smoothstep(uCutRadius, uCutRadius + 0.22, perp);
    }
  }
`;

const CUT_VERT = /* glsl */ `#include <project_vertex>
  vec4 cutWp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    cutWp = instanceMatrix * cutWp;
  #endif
  vCutWorld = (modelMatrix * cutWp).xyz;
  #ifdef GRIME
    vCutNormal = normalize(mat3(modelMatrix) * objectNormal);
  #endif
`;

/**
 * Soft ink: the outline pass draws no crease lines on this material and only a
 * thin, light silhouette around it. For small glowing bits (slime lips, drips,
 * splats) that the full ink would otherwise bury in black borders.
 */
export function softInk<T extends Material>(mat: T): T {
  mat.userData.softInk = true;
  return mat;
}

const patched = new WeakSet<Material>();

/** Idempotent: clones (which don't carry onBeforeCompile) get patched afresh, shared materials only once. */
export function withCutaway<T extends Material>(mat: T): T {
  if (patched.has(mat)) return mat;
  patched.add(mat);
  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    prev(shader, renderer);
    Object.assign(shader.uniforms, cutUniforms);
    shader.vertexShader = 'varying vec3 vCutWorld;\nvarying vec3 vCutNormal;\n' + shader.vertexShader.replace('#include <project_vertex>', CUT_VERT);
    // world curvature (render/curvature.ts): drawn bent, and the window is cut where things are drawn
    const bent = CURVE_ON && curveVertex(shader, 'vCutBent');
    if (bent) shader.vertexShader = 'varying vec3 vCutBent;\n' + shader.vertexShader;
    shader.fragmentShader =
      (bent ? 'varying vec3 vCutBent;\n' : '#define vCutBent vCutWorld\n') +
      CUT_FRAG_HEADER +
      shader.fragmentShader
        .replace('void main() {', 'void main() {\n' + CUT_FRAG_BODY)
        .replace('#include <color_fragment>', '#include <color_fragment>\n#ifdef GRIME\n  diffuseColor.rgb = applyGrime(diffuseColor.rgb, vCutWorld, normalize(vCutNormal));\n#endif')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  gl_FragColor.rgb = mix(gl_FragColor.rgb, uCutRim, cutRim);');
  };
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + '|cut4';
  if (CURVE_ON) markCurved(mat);
  return mat;
}

export type EmissiveChannel = 'neon' | 'windows' | 'lamps' | 'signs' | 'slime' | 'always';

/** The facade material's emissive strength at full night (the 'windows' channel scales it). */
export const FACADE_GLOW = 1.5;

/** Every shared world material, by name (level data refers to these). */
export const MAT_KEYS = [
  'invisible', 'concrete', 'concreteDark', 'concreteLight', 'asphalt', 'sidewalk', 'roof', 'facadeA', 'facadeB',
  'facadeC', 'metal', 'metalLight', 'stone', 'grass', 'wood', 'slime', 'slimePool', 'neonGreen', 'neonPurple',
  'lampGreen', 'lampPurple', 'lampWarm', 'linePurple', 'lineGreen', 'marking', 'hazard', 'glass', 'doorGlow',
] as const;

export type MatKey = (typeof MAT_KEYS)[number];

interface GlowSpec {
  color: string;
  emissive: string;
  emissiveIntensity: number;
}

/**
 * Lit lamp-head glass by lamp color: the world's lamp materials and the street lamp props.
 * Bright enough to bloom; brighter, and the deck's ceiling fixtures fog the chase view.
 */
export const LAMP_GLASS: Readonly<Record<LampColor, GlowSpec>> = {
  green: { color: '#e9ffd0', emissive: '#9dff3a', emissiveIntensity: 3.6 },
  purple: { color: '#f0dcff', emissive: PALETTE.purpleHot, emissiveIntensity: 3.6 },
  warm: { color: '#fff1d0', emissive: PALETTE.windowWarm, emissiveIntensity: 2.8 },
};
/** Dark painted metal (railings, poles), and dark glass (a dead lamp head, windows). */
export const METAL = { color: '#2a2233', roughness: 0.55, metalness: 0.4 };
export const GLASS = { color: '#1a1030', roughness: 0.2, metalness: 0.6 };
/**
 * Landscaping (world/decor-models.ts): leaves (street trees, hedges, bushes), darker needles
 * (pines, cypresses), bark, and petals in the poster's slime green and hot purple that glow
 * faintly by day and brighter at night (the neon channel). Leaves, needles and bark share a
 * roughness so the decor bakes them into one mesh (part.ts baked()).
 */
export const FOLIAGE = { color: '#33573f', roughness: 0.9 };
export const NEEDLES = { color: '#24453f', roughness: 0.9 };
export const BARK = { color: '#3b2a33', roughness: 0.9 };
export const PETALS = {
  slime: { color: '#d2ff6a', emissive: PALETTE.slime, emissiveIntensity: 1 },
  purple: { color: '#f0dcff', emissive: PALETTE.purpleHot, emissiveIntensity: 1 },
} as const;

/** World units covered by one texture repeat, per material. */
export const UV_SCALE: Partial<Record<MatKey, number>> = {
  concrete: 4,
  concreteDark: 4,
  concreteLight: 4,
  asphalt: 10,
  sidewalk: 4,
  roof: 6,
  grass: 6,
  stone: 3,
  hazard: 1.5,
};

interface EmissiveEntry {
  mat: MeshStandardMaterial;
  base: number;
  channel: EmissiveChannel;
}

export type ChannelLevels = Record<EmissiveChannel, number>;

/** A world material: vertex-colored, cut away near the camera, with grime unless `grime` is false. */
function worldMat(p: MeshStandardMaterialParameters, grime = true): MeshStandardMaterial {
  const m = withCutaway(new MeshStandardMaterial({ roughness: 0.92, metalness: 0, vertexColors: true, ...p }));
  if (grime) m.defines = { ...m.defines, GRIME: '' };
  return m;
}

/** Owns every shared material and scales emissive strength by time of day. */
export class MaterialLibrary {
  readonly world = new Map<MatKey, MeshStandardMaterial>();
  private readonly emissive: EmissiveEntry[] = [];

  constructor() {
    const concrete = concreteTexture(PALETTE.concrete, 11);
    const concreteDark = concreteTexture(PALETTE.concreteDark, 12);
    const concreteLight = concreteTexture(PALETTE.concreteLight, 13);
    const roofTex = concreteTexture(PALETTE.roof, 14, false);
    const stoneTex = concreteTexture('#7d788c', 15, true);

    this.set('invisible', worldMat({ visible: false }, false));
    this.set('concrete', worldMat({ map: concrete }));
    this.set('concreteDark', worldMat({ map: concreteDark }));
    this.set('concreteLight', worldMat({ map: concreteLight }));
    this.set('asphalt', worldMat({ map: asphaltTexture(31), roughness: 0.85 }));
    this.set('sidewalk', worldMat({ map: sidewalkTexture(32) }));
    this.set('roof', worldMat({ map: roofTex }));
    this.set('stone', worldMat({ map: stoneTex, color: '#cfc8dc' }));
    this.set('grass', worldMat({ map: grassTexture(33) }));
    this.set('wood', worldMat({ color: '#2a1d2e', roughness: 1 }));
    this.set('metal', worldMat(METAL));
    this.set('metalLight', worldMat({ color: '#7b748a', roughness: 0.5, metalness: 0.5 }));
    this.set('glass', worldMat(GLASS, false));
    this.set('hazard', worldMat({ map: hazardTexture('#2a1040', '#9b3cf0') }));
    this.facade(['facadeA', 'facadeB', 'facadeC']);

    // slime glows a tier below lamps and neon: it covers so much of the deck that its glow sets the glare
    this.glow('slime', PALETTE.slime, '#59ff00', 0.55, 'slime', { roughness: 0.35 });
    this.glow('slimePool', '#4dd10a', '#59ff00', 1.0, 'slime', { roughness: 0.2 });
    this.glow('neonGreen', '#c8ff8a', PALETTE.slime, 3.2, 'neon');
    this.glow('neonPurple', '#e4c4ff', PALETTE.purpleHot, 3.2, 'neon');
    const lamp = (key: MatKey, g: GlowSpec): void => this.glow(key, g.color, g.emissive, g.emissiveIntensity, 'lamps');
    lamp('lampGreen', LAMP_GLASS.green);
    lamp('lampPurple', LAMP_GLASS.purple);
    lamp('lampWarm', LAMP_GLASS.warm);
    this.glow('linePurple', '#c08bff', '#a84cff', 1.6, 'neon');
    this.glow('lineGreen', '#b8ff7a', '#7dff1a', 1.6, 'neon');
    this.glow('marking', '#bdb4cc', '#8a7aa6', 0.25, 'neon');
    // road paint is a decal, not a shape: inked, each dash turns into a speckle of outline from afar
    this.get('marking').userData.noInk = true;
    this.glow('doorGlow', '#b8ff7a', '#7dff1a', 2.2, 'neon');
  }

  private set(key: MatKey, mat: MeshStandardMaterial): void {
    mat.name = key;
    this.world.set(key, mat);
  }

  /**
   * One material for every facade key, so their boxes batch together: each box
   * brings its own paint (vertex color) and the facade shader draws its windows
   * and the rooms behind them (render/facade.ts), lit at night on the windows channel.
   */
  private facade(keys: readonly MatKey[]): void {
    const m = withFacade(worldMat({ emissive: '#ffffff', emissiveIntensity: FACADE_GLOW, roughness: 0.9 }));
    m.name = 'facade';
    for (const k of keys) this.world.set(k, m);
    this.register(m, 'windows');
  }

  private glow(
    key: MatKey,
    color: string,
    emissive: string,
    intensity: number,
    channel: EmissiveChannel,
    extra: MeshStandardMaterialParameters = {},
  ): void {
    const m = worldMat({ color, emissive, emissiveIntensity: intensity, roughness: 0.5, ...extra }, false);
    if (channel === 'slime') softInk(m);
    this.set(key, m);
    this.register(m, channel);
  }

  get(key: MatKey): MeshStandardMaterial {
    const m = this.world.get(key);
    if (!m) throw new Error(`unknown material ${key}`);
    return m;
  }

  /** Track a material whose emissive strength follows the day/night channel levels. */
  register(mat: MeshStandardMaterial, channel: EmissiveChannel, base = mat.emissiveIntensity): void {
    this.emissive.push({ mat, base, channel });
  }

  setChannels(levels: ChannelLevels): void {
    for (const e of this.emissive) e.mat.emissiveIntensity = e.base * levels[e.channel];
  }

  /**
   * Normal material for the ink-outline pass (with the same cutaway so holes match).
   * Alpha tags the ink class: 1 = full ink, 0.5 = soft ink, 0 (cleared) = background.
   */
  static normalMaterial(soft = false): MeshNormalMaterial {
    // NoBlending keeps OPAQUE undefined so the shader writes opacity as alpha, unblended
    return withCutaway(new MeshNormalMaterial({ side: DoubleSide, ...(soft ? { opacity: 0.5, blending: NoBlending } : {}) }));
  }
}

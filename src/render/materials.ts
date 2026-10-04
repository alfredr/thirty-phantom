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

import type { LampColor } from '@/world/level-data';
import type { MatKey } from '@/world/level-kinds';

import { CURVE_ON, curveVertex, markCurved } from './curvature';
import { withFacade } from './facade';
import { PALETTE } from './palette';
import { asphaltTexture, concreteTexture, grassTexture, hazardTexture, sidewalkTexture } from './textures';

export { MAT_KEYS, type MatKey } from '@/world/level-kinds';

/**
 * Occlusion cutaway shared by every world material. Inside a cylinder along the view ray through the focus point,
 * fragments are dropped if they sit between the camera and the focus (above the focus floor), or anywhere above the
 * ceiling over the focus, so the player stays visible under parking-deck slabs and behind towers.
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
  /** HDR color of the cutaway rim. Values above 1 produce bloom without excessive glare. */
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
  // Stretch noise vertically to form rain and slime streaks on walls.
  float st = gNoise(vec3(p.x * 2.6 + p.z * 2.6, p.y * 0.22, p.z * 0.9));
  float streak = smoothstep(0.58, 0.92, st) * wall;
  float slime = smoothstep(0.78, 0.97, gNoise(vec3(p.x * 1.3 + p.z * 1.3, p.y * 0.3 + 5.0, 7.0))) * wall;
  // Confine broad oil stains to horizontal surfaces.
  float oil = smoothstep(0.58, 0.95, gNoise(p * 0.16 + 23.0) * 0.7 + gNoise(p * 0.9 + 5.0) * 0.3) * (1.0 - wall);
  c = mix(c, c * vec3(0.38, 0.32, 0.4), dirt * 0.85 * uGrime);
  c = mix(c, c * 0.42, streak * 0.65 * uGrime);
  // Add fine surface grain independently of the adjustable grime strength.
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
 * Mark a material for a thin silhouette without crease lines. This keeps outlines from obscuring small glowing surfaces
 * such as slime, drips, and splats. Return the same material.
 */
export function softInk<T extends Material>(mat: T): T {
  mat.userData.softInk = true;
  return mat;
}

const patched = new WeakSet<Material>();

/** Install the cutaway shader patch once per material and return it. Clones must be patched separately. */
export function withCutaway<T extends Material>(mat: T): T {
  if (patched.has(mat)) {
    return mat;
  }

  patched.add(mat);
  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    prev(shader, renderer);
    Object.assign(shader.uniforms, cutUniforms);
    shader.vertexShader =
      'varying vec3 vCutWorld;\nvarying vec3 vCutNormal;\n' +
      shader.vertexShader.replace('#include <project_vertex>', CUT_VERT);
    // Use curved positions for the cutaway so its opening follows the rendered geometry.
    const bent = CURVE_ON && curveVertex(shader, 'vCutBent');
    if (bent) {
      shader.vertexShader = 'varying vec3 vCutBent;\n' + shader.vertexShader;
    }

    shader.fragmentShader =
      (bent ? 'varying vec3 vCutBent;\n' : '#define vCutBent vCutWorld\n') +
      CUT_FRAG_HEADER +
      shader.fragmentShader
        .replace('void main() {', 'void main() {\n' + CUT_FRAG_BODY)
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n#ifdef GRIME\n  diffuseColor.rgb = applyGrime(diffuseColor.rgb, vCutWorld, normalize(vCutNormal));\n#endif',
        )
        .replace(
          '#include <dithering_fragment>',
          '#include <dithering_fragment>\n  gl_FragColor.rgb = mix(gl_FragColor.rgb, uCutRim, cutRim);',
        );
  };

  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + '|cut4';

  if (CURVE_ON) {
    markCurved(mat);
  }

  return mat;
}

export type EmissiveChannel = 'neon' | 'windows' | 'lamps' | 'signs' | 'slime' | 'always';

/** The facade material's emissive strength at full night (the 'windows' channel scales it). */
export const FACADE_GLOW = 1.5;

interface GlowSpec {
  color: string;
  emissive: string;
  emissiveIntensity: number;
}

/**
 * Emissive glass settings shared by world lamps and street-lamp props. Limit intensity to retain bloom without
 * excessive glare from ceiling fixtures in the chase view.
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
 * Landscaping materials for world/decor-models.ts. Leaves, needles, and bark share roughness so part.ts baked() can
 * combine them into one mesh. Petals use the neon channel for stronger emission at night.
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
  if (grime) {
    m.defines = { ...m.defines, GRIME: '' };
  }

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

    // Keep emission low on large slime surfaces to limit overall bloom.
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
    // Exclude road markings from outlines to avoid speckling at a distance.
    this.get('marking').userData.noInk = true;
    this.glow('doorGlow', '#b8ff7a', '#7dff1a', 2.2, 'neon');
  }

  private set(key: MatKey, mat: MeshStandardMaterial): void {
    mat.name = key;
    this.world.set(key, mat);
  }

  /**
   * Assign one shared material to all facade keys so their geometry can batch together. Vertex colors provide paint;
   * render/facade.ts supplies windows and interior imagery, with emission controlled by the windows channel.
   */
  private facade(keys: readonly MatKey[]): void {
    const m = withFacade(worldMat({ emissive: '#ffffff', emissiveIntensity: FACADE_GLOW, roughness: 0.9 }));
    m.name = 'facade';

    for (const k of keys) {
      this.world.set(k, m);
    }

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
    if (channel === 'slime') {
      softInk(m);
    }

    this.set(key, m);
    this.register(m, channel);
  }

  get(key: MatKey): MeshStandardMaterial {
    const m = this.world.get(key);
    if (!m) {
      throw new Error(`unknown material ${key}`);
    }

    return m;
  }

  /** Track a material whose emissive strength follows the day/night channel levels. */
  register(mat: MeshStandardMaterial, channel: EmissiveChannel, base = mat.emissiveIntensity): void {
    this.emissive.push({ mat, base, channel });
  }

  setChannels(levels: ChannelLevels): void {
    for (const e of this.emissive) {
      e.mat.emissiveIntensity = e.base * levels[e.channel];
    }
  }

  /**
   * Normal material for the ink-outline pass (with the same cutaway so holes match). Alpha tags the ink class: 1 = full
   * ink, 0.5 = soft ink, 0 (cleared) = background.
   */
  static normalMaterial(soft = false): MeshNormalMaterial {
    // NoBlending leaves OPAQUE undefined, preserving the opacity value in the normal pass alpha channel.
    return withCutaway(
      new MeshNormalMaterial({ side: DoubleSide, ...(soft ? { opacity: 0.5, blending: NoBlending } : {}) }),
    );
  }
}

import {
  Color,
  DepthTexture,
  FloatType,
  HalfFloatType,
  type Material,
  type Mesh,
  MeshBasicMaterial,
  type MeshNormalMaterial,
  NearestFilter,
  type Object3D,
  type OrthographicCamera,
  type PerspectiveCamera,
  type Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

import { FX_LAYER } from '@/render/layers';
import { MaterialLibrary } from '@/render/materials';

import { FULLSCREEN_VERT } from './fullscreen';

const frag = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform vec2 texel;
uniform float cameraNear;
uniform float cameraFar;
uniform vec3 inkColor;
uniform float thickness;
uniform float depthThreshold;
uniform float strength;
uniform float softInk;
uniform float isPersp;
uniform vec2 tanHalf;
uniform float pixelWorld;
uniform vec2 inkFade;
varying vec2 vUv;

// Normal-buffer alpha identifies full ink (1), soft ink (0.5) and background (0).
float viewZ(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  return isPersp > 0.5 ? -perspectiveDepthToViewZ(d, cameraNear, cameraFar) : cameraNear + d * (cameraFar - cameraNear);
}
vec4 nrm(vec2 uv) { vec4 n = texture2D(tNormal, uv); return vec4(n.xyz * 2.0 - 1.0, n.a); }
bool isSoft(float a) { return a > 0.25 && a < 0.75; }

// Include neighboring depth only when the neighbor uses full ink.
float nearFull(float z, vec2 uv, float a) { return a > 0.75 ? min(z, viewZ(uv)) : z; }
float nearSoft(float z, vec2 uv) { return isSoft(texture2D(tNormal, uv).a) ? min(z, viewZ(uv)) : z; }

// Fade ink as world units per pixel increase between the inkFade thresholds.
// This suppresses outlines around details too small to resolve.
float farness(float z) {
  float wpp = isPersp > 0.5 ? z * pixelWorld : pixelWorld;
  return smoothstep(inkFade.x, inkFade.y, wpp);
}

// Use normal differences for full-ink neighbors and a full contour against background.
// Soft-ink neighbors do not create crease edges.
float crease(vec4 n0, vec4 n) { return n.a > 0.75 ? 1.0 - dot(n0.xyz, n.xyz) : n.a < 0.25 ? 1.0 : 0.0; }

void main() {
  vec4 base = texture2D(tColor, vUv);
  vec2 o = texel * thickness;
  vec2 s = texel * max(1.0, thickness * 0.5);
  float c = viewZ(vUv);
  vec4 n0 = nrm(vUv);
  vec4 n1 = nrm(vUv - vec2(o.x, 0.0));
  vec4 n2 = nrm(vUv + vec2(o.x, 0.0));
  vec4 n3 = nrm(vUv + vec2(0.0, o.y));
  vec4 n4 = nrm(vUv - vec2(0.0, o.y));
  // Detect silhouettes where a neighbor is closer, using narrower sampling for soft ink.
  float nf = nearFull(nearFull(nearFull(nearFull(c, vUv - vec2(o.x, 0.0), n1.a), vUv + vec2(o.x, 0.0), n2.a), vUv + vec2(0.0, o.y), n3.a), vUv - vec2(0.0, o.y), n4.a);
  float ns = nearSoft(nearSoft(nearSoft(nearSoft(c, vUv - vec2(s.x, 0.0)), vUv + vec2(s.x, 0.0)), vUv + vec2(0.0, s.y)), vUv - vec2(0.0, s.y));
  float thr = depthThreshold;
  if (isPersp > 0.5) {
    // Scale the depth threshold with distance and viewing angle in perspective.
    // Grazing surfaces can change depth sharply between pixels without forming an edge.
    vec3 ray = normalize(vec3((vUv * 2.0 - 1.0) * tanHalf, -1.0));
    float facing = n0.a > 0.25 ? abs(dot(n0.xyz, ray)) : 1.0;
    thr = max(0.03, c * depthThreshold) / max(facing, 0.12);
  }
  float de = smoothstep(thr, thr * 2.0, c - nf);
  float ds = smoothstep(thr, thr * 2.0, c - ns) * softInk;
  // Detect normal-based creases only on full-ink surfaces.
  float nd = 0.0;
  if (n0.a > 0.75) nd = max(max(crease(n0, n1), crease(n0, n2)), max(crease(n0, n3), crease(n0, n4)));
  float ne = smoothstep(0.22, 0.5, nd);
  // Fade silhouettes using the foreground depth and creases using the current surface depth.
  // Retain at least half of full-ink silhouettes so distant shapes remain outlined.
  de *= 1.0 - 0.5 * farness(nf);
  ds *= 1.0 - farness(ns);
  ne *= 1.0 - farness(c);
  float edge = max(max(de, ne), ds) * strength;
  gl_FragColor = vec4(mix(base.rgb, inkColor, edge), 1.0);
}
`;

/**
 * Render scene color, floating-point depth, and view-space normals, then composite outlines at silhouettes and creases.
 * Materials tagged by softInk() receive thin, faint silhouettes without crease lines.
 */
export class SceneOutlinePass extends Pass {
  private readonly sceneRT: WebGLRenderTarget;
  private readonly normalRT: WebGLRenderTarget;
  private readonly normalMat: MeshNormalMaterial = MaterialLibrary.normalMaterial();
  private readonly softNormalMat: MeshNormalMaterial = MaterialLibrary.normalMaterial(true);
  private readonly swapMeshes: Mesh[] = [];
  private readonly swapMats: (Material | Material[])[] = [];
  private readonly quad: FullScreenQuad;
  readonly material: ShaderMaterial;
  private readonly tmpColor = new Color();
  /** World units per pixel, set by the renderer each frame (orthographic view only). */
  worldPerPixel = 0.04;
  private heightPx: number;

  constructor(
    private readonly scene: Scene,
    /** The renderer swaps this between the iso and chase cameras. */
    public camera: OrthographicCamera | PerspectiveCamera,
    w: number,
    h: number,
  ) {
    super();
    this.heightPx = h;
    const depthTexture = new DepthTexture(w, h, FloatType);
    depthTexture.minFilter = NearestFilter;
    depthTexture.magFilter = NearestFilter;
    this.sceneRT = new WebGLRenderTarget(w, h, { type: HalfFloatType, depthTexture, samples: 4 });
    this.normalRT = new WebGLRenderTarget(w, h, { type: UnsignedByteType });
    this.material = new ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tNormal: { value: null },
        texel: { value: new Vector2(1 / w, 1 / h) },
        cameraNear: { value: 1 },
        cameraFar: { value: 700 },
        inkColor: { value: new Color('#0d0716') },
        thickness: { value: 1.5 },
        depthThreshold: { value: 0.3 },
        strength: { value: 0.92 },
        softInk: { value: 0.45 },
        isPersp: { value: 0 },
        tanHalf: { value: new Vector2(1, 1) },
        /** World units per pixel: constant in the iso view, per unit of view depth in the chase view. */
        pixelWorld: { value: 0.04 },
        /** World-space pixel-size range over which fine outlines fade, reducing visual noise on distant detail. */
        inkFade: { value: new Vector2(0.06, 0.16) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  get depthTexture(): DepthTexture {
    return this.sceneRT.depthTexture as DepthTexture;
  }

  override setSize(w: number, h: number): void {
    this.sceneRT.setSize(w, h);
    this.normalRT.setSize(w, h);
    this.heightPx = h;
    (this.material.uniforms.texel?.value as Vector2).set(1 / w, 1 / h);
  }

  /** Invisible replacement material excludes noInk surfaces from the normal pass. */
  private readonly noInkMat = new MeshBasicMaterial({ visible: false });
  private readonly pickNormal = (m: Material): Material =>
    !m.visible ? m : m.userData.noInk ? this.noInkMat : m.userData.softInk ? this.softNormalMat : this.normalMat;

  /** Per-mesh swap rather than scene.overrideMaterial, so each material can pick its ink class. */
  private readonly swapIn = (o: Object3D): void => {
    const m = o as Mesh;
    if (!m.isMesh) {
      return;
    }

    this.swapMeshes.push(m);
    this.swapMats.push(m.material);
    m.material = Array.isArray(m.material) ? m.material.map(this.pickNormal) : this.pickNormal(m.material);
  };

  setThickness(px: number): void {
    (this.material.uniforms.thickness as { value: number }).value = px;
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget): void {
    const u = this.material.uniforms;
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    // Exclude background, fog, and effects from normals, and reuse the scene pass's shadow maps.
    const bg = this.scene.background;
    const fog = this.scene.fog;
    const autoShadow = renderer.shadowMap.autoUpdate;
    const mask = this.camera.layers.mask;
    renderer.getClearColor(this.tmpColor);
    const alpha = renderer.getClearAlpha();
    this.scene.background = null;
    this.scene.fog = null;
    this.scene.traverse(this.swapIn);
    renderer.shadowMap.autoUpdate = false;
    this.camera.layers.disable(FX_LAYER);
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.normalRT);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    for (let i = 0; i < this.swapMeshes.length; i++) {
      (this.swapMeshes[i] as Mesh).material = this.swapMats[i] as Material | Material[];
    }

    this.swapMeshes.length = 0;
    this.swapMats.length = 0;
    this.scene.background = bg;
    this.scene.fog = fog;
    renderer.shadowMap.autoUpdate = autoShadow;
    this.camera.layers.mask = mask;
    renderer.setClearColor(this.tmpColor, alpha);

    u.tColor!.value = this.sceneRT.texture;
    u.tDepth!.value = this.sceneRT.depthTexture;
    u.tNormal!.value = this.normalRT.texture;
    u.cameraNear!.value = this.camera.near;
    u.cameraFar!.value = this.camera.far;
    const thick = u.thickness!.value as number;
    const cam = this.camera;
    if ('isPerspectiveCamera' in cam) {
      // Scale the threshold by pixel footprint at unit depth; the shader applies each pixel's actual depth.
      const ty = Math.tan((cam.fov * Math.PI) / 360);
      (u.tanHalf!.value as Vector2).set(ty * cam.aspect, ty);
      u.isPersp!.value = 1;
      u.pixelWorld!.value = (2 * ty) / this.heightPx;
      u.depthThreshold!.value = ((2 * ty) / this.heightPx) * 5 * thick;
    } else {
      u.isPersp!.value = 0;
      u.pixelWorld!.value = this.worldPerPixel;
      u.depthThreshold!.value = Math.max(0.12, this.worldPerPixel * 5 * thick);
    }

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.sceneRT.dispose();
    this.normalRT.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}

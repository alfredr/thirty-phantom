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

// normal buffer alpha is the ink class: 1 full, 0.5 soft, 0 background
float viewZ(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  return isPersp > 0.5 ? -perspectiveDepthToViewZ(d, cameraNear, cameraFar) : cameraNear + d * (cameraFar - cameraNear);
}
vec4 nrm(vec2 uv) { vec4 n = texture2D(tNormal, uv); return vec4(n.xyz * 2.0 - 1.0, n.a); }
bool isSoft(float a) { return a > 0.25 && a < 0.75; }

// nearest depth among this pixel and a full-ink neighbour
float nearFull(float z, vec2 uv, float a) { return a > 0.75 ? min(z, viewZ(uv)) : z; }
float nearSoft(float z, vec2 uv) { return isSoft(texture2D(tNormal, uv).a) ? min(z, viewZ(uv)) : z; }

// How much ink gives way at view depth z: 0 up close, 1 where a pixel spans inkFade.y of world.
// Detail there is smaller than the lines drawn around it, and inking it only makes broken dashes.
float farness(float z) {
  float wpp = isPersp > 0.5 ? z * pixelWorld : pixelWorld;
  return smoothstep(inkFade.x, inkFade.y, wpp);
}

// crease against a neighbour: by angle between full-ink surfaces, always
// against background (outer contour), never against soft ink
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
  // silhouettes: a neighbour is notably closer than this pixel (soft ink: thinner and lighter)
  float nf = nearFull(nearFull(nearFull(nearFull(c, vUv - vec2(o.x, 0.0), n1.a), vUv + vec2(o.x, 0.0), n2.a), vUv + vec2(0.0, o.y), n3.a), vUv - vec2(0.0, o.y), n4.a);
  float ns = nearSoft(nearSoft(nearSoft(nearSoft(c, vUv - vec2(s.x, 0.0)), vUv + vec2(s.x, 0.0)), vUv + vec2(0.0, s.y)), vUv - vec2(0.0, s.y));
  float thr = depthThreshold;
  if (isPersp > 0.5) {
    // perspective: a pixel spans more world the farther away it is, and a floor seen at a grazing
    // angle changes depth quickly between neighbours without being an edge
    vec3 ray = normalize(vec3((vUv * 2.0 - 1.0) * tanHalf, -1.0));
    float facing = n0.a > 0.25 ? abs(dot(n0.xyz, ray)) : 1.0;
    thr = max(0.03, c * depthThreshold) / max(facing, 0.12);
  }
  float de = smoothstep(thr, thr * 2.0, c - nf);
  float ds = smoothstep(thr, thr * 2.0, c - ns) * softInk;
  // creases from the normal buffer (full ink only)
  float nd = 0.0;
  if (n0.a > 0.75) nd = max(max(crease(n0, n1), crease(n0, n2)), max(crease(n0, n3), crease(n0, n4)));
  float ne = smoothstep(0.22, 0.5, nd);
  // silhouettes fade by the depth of what they outline (the nearer side), creases by their own;
  // silhouettes keep half, so far shapes still read as inked
  de *= 1.0 - 0.5 * farness(nf);
  ds *= 1.0 - farness(ns);
  ne *= 1.0 - farness(c);
  float edge = max(max(de, ne), ds) * strength;
  gl_FragColor = vec4(mix(base.rgb, inkColor, edge), 1.0);
}
`;

/**
 * Renders the scene (with a float depth texture), then a view-normal pass, and composites thick ink lines on
 * silhouettes and creases: the comic linework of the poster. Materials tagged with softInk() get no creases and a thin,
 * light silhouette.
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
        /**
         * Pixel sizes (world units) over which fine ink fades out: none at play zoom, most of it zoomed all the way
         * out.
         */
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

  /** Stands in for materials tagged noInk (a see-through Cody): not drawn into the normals at all. */
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

    // normals: no background, no fog, no FX layer, no shadow re-render
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
      // threshold per unit of view depth; the shader scales it by each pixel's depth
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

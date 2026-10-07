import {
  NoToneMapping,
  PCFShadowMap,
  type Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { TUNING } from '@/config';
import { urlChoice } from '@/engine/core/url-flags';

import type { ChaseCamera } from './chase-camera';
import {
  CURVE_ON,
  curveCull,
  curveFrame,
  curvePoint,
  curveSweep,
  curveTop,
} from './curvature';
import { type IsoCamera, ISO_ELEVATION } from './iso-camera';
import { cutUniforms } from './materials';
import { GhostPass } from './post/ghost-pass';
import { SceneOutlinePass } from './post/scene-outline-pass';
import { GradeShader, MOON_X, MOON_Y, SkyShader } from './post/sky-shader';

/**
 * A ShaderPass whose (cloned) uniforms keep the shader definition's names and
 * value types.
 */
export type TypedShaderPass<U> = Omit<ShaderPass, 'uniforms'> & {
  uniforms: U;
};

function shaderPass<S extends { uniforms: object }>(
  shader: S,
): TypedShaderPass<S['uniforms']> {
  return new ShaderPass(shader) as unknown as TypedShaderPass<S['uniforms']>;
}

/**
 * Bloom settings shared across times of day. Keep the broad blur levels weak
 * to limit glare. `threshold` sets the starting luminance and `knee` controls
 * the transition width; day-night.ts controls overall strength.
 */
const BLOOM = { radius: 0.1, threshold: 0.9, knee: 0.6 };

/**
 * Frames between sweeps for materials that would still draw flat
 * (render/curvature.ts).
 */
const SWEEP_EVERY = 60;

/**
 * Render the scene and outlines, sky, ghosts, bloom, grading with tone
 * mapping, output conversion, and SMAA in order. Isometric curvature bends
 * scene geometry before postprocessing and fills uncovered pixels with sky.
 */
export class GameRenderer {
  readonly renderer: WebGLRenderer;
  readonly composer: EffectComposer;
  readonly outline: SceneOutlinePass;
  readonly sky: TypedShaderPass<typeof SkyShader.uniforms>;
  /**
   * Draws the ghost layer (a faded Cody); enable it while anything is on that
   * layer.
   */
  readonly ghost: GhostPass;
  readonly bloom: UnrealBloomPass;
  readonly grade: TypedShaderPass<typeof GradeShader.uniforms>;
  /** Render through the chase camera instead of the iso rig. */
  chaseView = false;
  /**
   * Whether the last frame was drawn on the curved world (iso with
   * TUNING.camera.curve).
   */
  curved = false;
  private readonly pixelRatio: number;
  private readonly tmpUp = new Vector3();
  /** The cutaway's flat centre, put back after a curved frame bends it. */
  private readonly cutFlat = new Vector3();
  private frames = 0;

  constructor(
    container: HTMLElement,
    private readonly scene: Scene,
    private readonly iso: IsoCamera,
    private readonly chase: ChaseCamera,
  ) {
    const r = new WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    r.outputColorSpace = SRGBColorSpace;
    // The grade pass applies per-channel tone mapping to preserve neon saturation.
    r.toneMapping = NoToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    container.appendChild(r.domElement);
    this.renderer = r;

    const q = urlChoice('q', ['low', 'high']);
    this.pixelRatio = Math.min(
      window.devicePixelRatio || 1,
      q === 'low' ? 1 : q === 'high' ? 2 : 1.5,
    );
    const w = window.innerWidth;
    const h = window.innerHeight;
    r.setPixelRatio(this.pixelRatio);
    r.setSize(w, h);

    // Set the renderer size before constructing the composer's buffers.
    this.composer = new EffectComposer(r);
    const pw = Math.round(w * this.pixelRatio);
    const ph = Math.round(h * this.pixelRatio);
    this.outline = new SceneOutlinePass(scene, iso.camera, pw, ph);
    this.sky = shaderPass(SkyShader);
    this.ghost = new GhostPass(scene);
    // DayNight supplies bloom strength before the first frame.
    this.bloom = new UnrealBloomPass(
      new Vector2(w, h),
      0,
      BLOOM.radius,
      BLOOM.threshold,
    );
    (
      this.bloom.highPassUniforms as { smoothWidth: { value: number } }
    ).smoothWidth.value = BLOOM.knee;
    this.grade = shaderPass(GradeShader);
    this.composer.addPass(this.outline);
    this.composer.addPass(this.sky);
    this.composer.addPass(this.ghost);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    // Apply SMAA after output conversion to smooth outlines generated from single-sample depth and normals.
    this.composer.addPass(new SMAAPass());
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.iso.setViewport(w, h);
    this.chase.setViewport(w, h);
    const pw = w * this.pixelRatio;
    const ph = h * this.pixelRatio;
    this.sky.uniforms.resolution.value.set(pw, ph);
    this.grade.uniforms.resolution.value.set(pw, ph);
    this.outline.setThickness(Math.max(1.6, this.pixelRatio * 1.35));
  }

  /**
   * Transform a HUD anchor in place for the current curved view. Return the
   * same point, unchanged for flat views.
   */
  bend(p: Vector3): Vector3 {
    return this.curved ? curvePoint(p) : p;
  }

  render(time: number): void {
    const su = this.sky.uniforms;
    su.time.value = time;
    su.tDepth.value = this.outline.depthTexture;
    const cam = this.chaseView ? this.chase.camera : this.iso.camera;
    this.outline.camera = cam;
    this.ghost.camera = cam;
    this.ghost.depthTexture = this.outline.depthTexture;
    su.invViewProj.value.multiplyMatrices(
      cam.matrixWorld,
      cam.projectionMatrixInverse,
    );
    su.isPersp.value = this.chaseView ? 1 : 0;
    // Show the distant skyline only in the chase view.
    su.skylineAmount.value = this.chaseView ? 1 : 0;

    if (this.chaseView) {
      su.camPos.value.copy(cam.position);
      su.fogNear.value = TUNING.camera.chase.fogNear;
      su.fogFar.value = TUNING.camera.chase.fogFar;
    } else {
      this.isoSky();
    }

    this.grade.uniforms.time.value = time;
    this.curve(CURVE_ON && !this.chaseView);

    if (!this.curved) {
      this.composer.render();
      return;
    }

    // Transform the cutaway centre and culling bounds into the curved render space.
    const cut = cutUniforms.uCutCenter.value;
    this.cutFlat.copy(cut);
    curvePoint(cut);
    curveCull(this.iso.camera, cut, cutUniforms.uCutRadius.value);
    this.composer.render();
    curveCull(null);
    cut.copy(this.cutFlat);
  }

  /**
   * Configure curvature, shadow coverage, and the matching sky horizon, or
   * reset them for a flat view.
   */
  private curve(on: boolean): void {
    const u = curveFrame.planet;
    const su = this.sky.uniforms;
    this.curved = on;

    if (!on) {
      u.w = 0;
      su.horizon.value.w = 0;
      this.iso.shadowTop = 0;
      return;
    }

    if (this.frames++ % SWEEP_EVERY === 0) {
      curveSweep(this.scene);
    }

    const iso = this.iso;
    const t = iso.target;
    const h = iso.viewHeight;
    // Cancel zoom scaling so the planet radius depends on the default zoom and viewport fit.
    const R = (TUNING.camera.curve.radius * h * TUNING.camera.zoom) / iso.zoom;
    u.set(t.x, t.y, t.z, R);
    curveFrame.lean = TUNING.camera.curve.lean;
    // Extend the next frame's shadow bounds to include ground exposed by curvature.
    this.iso.shadowTop = curveTop(iso.camera.top, ISO_ELEVATION) + 2;
    // Project the street sphere into screen UV coordinates for the sky horizon.
    const cy = 0.5 - ((R + t.y) * Math.cos(ISO_ELEVATION)) / h;
    su.horizon.value.set(R / h, cy, (2 * iso.camera.right) / h, 1);
    su.planet.value.set(t.x, -R, t.z, R);
    su.toCam.value.copy(iso.viewDir);
    su.hazeFrom.value = TUNING.camera.curve.haze;
    // Raise the moon above the curved horizon within the available screen height.
    const mp = su.moonPos.value;
    const hx = (MOON_X - 0.5) * su.horizon.value.z;
    const foot =
      cy + Math.sqrt(Math.max(su.horizon.value.x ** 2 - hx * hx, 0));
    mp.y += Math.max(
      0,
      Math.min(
        foot + su.moonSize.value * 1.25 - MOON_Y,
        1 - su.moonSize.value - MOON_Y,
      ),
    );
  }

  private isoSky(): void {
    const su = this.sky.uniforms;
    const h = window.innerHeight * this.pixelRatio;
    this.outline.worldPerPixel = this.iso.viewHeight / h;
    su.focus.value.copy(this.iso.target);
    this.iso.screenUp(this.tmpUp);
    su.upDir.value.set(this.tmpUp.x, this.tmpUp.z);
    // Convert screen-space height to ground distance using the isometric camera elevation.
    const k = this.iso.viewHeight / Math.sin(ISO_ELEVATION);
    const band = su.bandStart.value - 0.5;
    su.fade0.value = k * (band - 0.13);
    su.fade1.value = k * (band + 0.02);
  }
}

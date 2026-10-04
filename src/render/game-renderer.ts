import { NoToneMapping, PCFShadowMap, type Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { TUNING } from '@/config';
import { urlChoice } from '@/engine/core/url-flags';

import type { ChaseCamera } from './chase-camera';
import { CURVE_ON, curveCull, curveFrame, curvePoint, curveSweep, curveTop } from './curvature';
import { type IsoCamera, ISO_ELEVATION } from './iso-camera';
import { cutUniforms } from './materials';
import { GhostPass } from './post/ghost-pass';
import { SceneOutlinePass } from './post/scene-outline-pass';
import { GradeShader, MOON_X, MOON_Y, SkyShader } from './post/sky-shader';

/** A ShaderPass whose (cloned) uniforms keep the shader definition's names and value types. */
export type TypedShaderPass<U> = Omit<ShaderPass, 'uniforms'> & { uniforms: U };

function shaderPass<S extends { uniforms: object }>(shader: S): TypedShaderPass<S['uniforms']> {
  return new ShaderPass(shader) as unknown as TypedShaderPass<S['uniforms']>;
}

/**
 * Bloom shape; its strength follows the time of day (day-night.ts). `radius` weights the widest blur levels: kept low,
 * glow stays a halo round lamps and neon instead of a haze over the whole frame. `threshold` is the scene luminance
 * where glow starts and `knee` the width it fades in over, so a surface just past the threshold glows a little rather
 * than at full strength.
 */
const BLOOM = { radius: 0.1, threshold: 0.9, knee: 0.6 };

/** Frames between sweeps for materials that would still draw flat (render/curvature.ts). */
const SWEEP_EVERY = 60;

/**
 * Post stack: scene + ink outlines -> sky band -> see-through ghosts -> bloom -> grade -> tone map -> SMAA. With world
 * curvature (render/curvature.ts) the scene is bent as it's drawn, and the sky fills what it leaves empty.
 */
export class GameRenderer {
  readonly renderer: WebGLRenderer;
  readonly composer: EffectComposer;
  readonly outline: SceneOutlinePass;
  readonly sky: TypedShaderPass<typeof SkyShader.uniforms>;
  /** Draws the ghost layer (a faded Cody); enable it while anything is on that layer. */
  readonly ghost: GhostPass;
  readonly bloom: UnrealBloomPass;
  readonly grade: TypedShaderPass<typeof GradeShader.uniforms>;
  /** Render through the chase camera instead of the iso rig. */
  chaseView = false;
  /** Whether the last frame was drawn on the curved world (iso with TUNING.camera.curve). */
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
    const r = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    r.outputColorSpace = SRGBColorSpace;
    // tone mapping happens in the grade pass (per-channel, keeps the neon saturated)
    r.toneMapping = NoToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    container.appendChild(r.domElement);
    this.renderer = r;

    const q = urlChoice('q', ['low', 'high']);
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, q === 'low' ? 1 : q === 'high' ? 2 : 1.5);
    const w = window.innerWidth;
    const h = window.innerHeight;
    r.setPixelRatio(this.pixelRatio);
    r.setSize(w, h);

    // the composer sizes its buffers from the renderer
    this.composer = new EffectComposer(r);
    const pw = Math.round(w * this.pixelRatio);
    const ph = Math.round(h * this.pixelRatio);
    this.outline = new SceneOutlinePass(scene, iso.camera, pw, ph);
    this.sky = shaderPass(SkyShader);
    this.ghost = new GhostPass(scene);
    // strength 0 until DayNight sets it, before the first frame is drawn
    this.bloom = new UnrealBloomPass(new Vector2(w, h), 0, BLOOM.radius, BLOOM.threshold);
    (this.bloom.highPassUniforms as { smoothWidth: { value: number } }).smoothWidth.value = BLOOM.knee;
    this.grade = shaderPass(GradeShader);
    this.composer.addPass(this.outline);
    this.composer.addPass(this.sky);
    this.composer.addPass(this.ghost);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    // the scene is multisampled, but the ink is drawn after that from single-sample depth and
    // normals, so its edges stair-step; SMAA on the final sRGB image smooths them
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

  /** Bends a world point in place where the curved iso view draws it (HUD markers); as it is otherwise. */
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
    su.invViewProj.value.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
    su.isPersp.value = this.chaseView ? 1 : 0;
    // the distant skyline is the chase view's horizon; top-down, the band is just sky
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

    // the x-ray window is cut round where Cody is drawn, and culling goes by where things are drawn
    const cut = cutUniforms.uCutCenter.value;
    this.cutFlat.copy(cut);
    curvePoint(cut);
    curveCull(this.iso.camera, cut, cutUniforms.uCutRadius.value);
    this.composer.render();
    curveCull(null);
    cut.copy(this.cutFlat);
  }

  /** Sets the frame's planet (render/curvature.ts), or none, and the sky's horizon to go with it. */
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
    // the planet keeps its size whatever the zoom: `radius` view heights at the default zoom
    const R = (TUNING.camera.curve.radius * h * TUNING.camera.zoom) / iso.zoom;
    u.set(t.x, t.y, t.z, R);
    curveFrame.lean = TUNING.camera.curve.lean;
    // farther ground curves into view at the top: the sun's shadow box reaches for it (next frame's)
    this.iso.shadowTop = curveTop(iso.camera.top, ISO_ELEVATION) + 2;
    // the street's sphere outlined on screen: a circle of its radius, its centre R + t.y under the focus (uv)
    const cy = 0.5 - ((R + t.y) * Math.cos(ISO_ELEVATION)) / h;
    su.horizon.value.set(R / h, cy, (2 * iso.camera.right) / h, 1);
    su.planet.value.set(t.x, -R, t.z, R);
    su.toCam.value.copy(iso.viewDir);
    su.hazeFrom.value = TUNING.camera.curve.haze;
    // the risen moon clears the horizon, as far as the screen's top allows
    const mp = su.moonPos.value;
    const hx = (MOON_X - 0.5) * su.horizon.value.z;
    const foot = cy + Math.sqrt(Math.max(su.horizon.value.x ** 2 - hx * hx, 0));
    mp.y += Math.max(0, Math.min(foot + su.moonSize.value * 1.25 - MOON_Y, 1 - su.moonSize.value - MOON_Y));
  }

  private isoSky(): void {
    const su = this.sky.uniforms;
    const h = window.innerHeight * this.pixelRatio;
    this.outline.worldPerPixel = this.iso.viewHeight / h;
    su.focus.value.copy(this.iso.target);
    this.iso.screenUp(this.tmpUp);
    su.upDir.value.set(this.tmpUp.x, this.tmpUp.z);
    // ground at screen offset s (world units) lies s / sin(ISO_ELEVATION) away
    const k = this.iso.viewHeight / Math.sin(ISO_ELEVATION);
    const band = su.bandStart.value - 0.5;
    su.fade0.value = k * (band - 0.13);
    su.fade1.value = k * (band + 0.02);
  }
}

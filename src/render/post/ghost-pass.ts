import {
  AlwaysDepth,
  type Camera,
  type DepthTexture,
  type Light,
  type Scene,
  ShaderMaterial,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

import { GHOST_LAYER } from '@/render/layers';

import { FULLSCREEN_VERT } from './fullscreen';

/**
 * Draws the GHOST_LAYER (a faded Cody) on top of the image after the sky pass, so a see-through figure against the sky
 * isn't painted over. The scene's depth is copied in first, so walls in front still hide it; the ghost's own depth
 * twins then keep only its nearest surface. Not drawn into the ink normals at all.
 */
export class GhostPass extends Pass {
  camera: Camera | null = null;
  depthTexture: DepthTexture | null = null;
  /** Lights only reach objects through the camera's layers, so they're put on the ghost layer too. */
  private lit = false;
  /** Writes the scene's depth into the target, so walls in front still hide the ghost. */
  private readonly copyMat = new ShaderMaterial({
    uniforms: { tDepth: { value: null } },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDepth;
      varying vec2 vUv;
      void main() {
        gl_FragDepth = texture2D(tDepth, vUv).r;
        gl_FragColor = vec4(0.0);
      }
    `,
    depthTest: true,
    depthWrite: true,
    depthFunc: AlwaysDepth,
    colorWrite: false,
  });
  private readonly copyDepth = new FullScreenQuad(this.copyMat);

  constructor(private readonly scene: Scene) {
    super();
    this.needsSwap = false;
    // off until something is faded
    this.enabled = false;
  }

  override render(renderer: WebGLRenderer, _writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const cam = this.camera;
    if (!cam || !this.depthTexture) {
      return;
    }

    if (!this.lit) {
      this.scene.traverse((o) => {
        if ((o as Light).isLight) {
          o.layers.enable(GHOST_LAYER);
        }
      });
      this.lit = true;
    }

    this.copyMat.uniforms.tDepth!.value = this.depthTexture;
    const autoClear = renderer.autoClear;
    const autoShadow = renderer.shadowMap.autoUpdate;
    const mask = cam.layers.mask;
    const bg = this.scene.background;
    const fog = this.scene.fog;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    this.copyDepth.render(renderer);
    this.scene.background = null;
    this.scene.fog = null;
    cam.layers.set(GHOST_LAYER);
    renderer.render(this.scene, cam);
    cam.layers.mask = mask;
    this.scene.background = bg;
    this.scene.fog = fog;
    renderer.shadowMap.autoUpdate = autoShadow;
    renderer.autoClear = autoClear;
  }

  override dispose(): void {
    // FullScreenQuad.dispose() only frees its geometry
    this.copyDepth.dispose();
    this.copyMat.dispose();
  }
}

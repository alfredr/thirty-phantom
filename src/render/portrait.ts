import {
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';

import { PALETTE } from './palette';

/**
 * Fraction of the figure's height included in the portrait. HEADROOM adds space above the head relative to this
 * fraction; LOOK_DOWN and LOOK_SIDE control the viewing angle.
 */
const FRAME_SHARE = 0.36;
const HEADROOM = 0.12;
const FOV = 24;
const LOOK_DOWN = 0.1;
const LOOK_SIDE = 0.35;
/** Stage height below the world keeps portrait geometry outside the cutaway's vertical range. */
const STAGE_Y = -500;
/** Key light from the front left, a cool fill from the sky, and a backdrop of night purple. */
const KEY = { color: '#fff1dc', intensity: 4.2, at: [-1.2, 1.6, 2] as const };
const FILL = { sky: '#b9a8ff', ground: '#2a1a36', intensity: 1.9 };
const BACKDROP = PALETTE.night;

/**
 * Render a square dialogue portrait and return a PNG data URL. The caller supplies a posed character with feet at y=0
 * facing +Z; `looks` selects the direction it faces across the image. Temporarily reparent and position `root`, then
 * restore its parent, position, yaw, visibility, and the renderer's target after rendering.
 */
export function renderPortrait(renderer: WebGLRenderer, root: Object3D, looks: 'left' | 'right', size = 256): string {
  const parent = root.parent;
  const was = { pos: root.position.clone(), rot: root.rotation.y, visible: root.visible };
  const stage = new Scene();
  stage.background = new Color(BACKDROP);
  stage.add(new HemisphereLight(FILL.sky, FILL.ground, FILL.intensity));
  const key = new DirectionalLight(KEY.color, KEY.intensity);
  key.position.set(KEY.at[0], STAGE_Y + KEY.at[1], KEY.at[2]);
  key.target.position.set(0, STAGE_Y + 1, 0);
  stage.add(key, key.target);
  root.position.set(0, STAGE_Y, 0);
  root.rotation.y = 0;
  root.visible = true;
  stage.add(root);
  root.updateMatrixWorld(true);

  // Fit the head and shoulders using the posed character's bounds.
  const bounds = new Box3().setFromObject(root);
  const tall = bounds.max.y - bounds.min.y;
  const span = tall * FRAME_SHARE * (1 + HEADROOM);
  const midY = bounds.max.y + tall * FRAME_SHARE * HEADROOM - span / 2;
  const dist = span / 2 / Math.tan(((FOV / 2) * Math.PI) / 180);
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 50);
  // Offset the camera opposite the requested gaze direction.
  const side = looks === 'left' ? LOOK_SIDE : -LOOK_SIDE;
  camera.position.set(Math.sin(side) * dist, midY + dist * LOOK_DOWN, Math.cos(side) * dist);
  camera.lookAt(new Vector3(0, midY, 0));

  const target = new WebGLRenderTarget(size, size);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(stage, camera);
  const pixels = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
  renderer.setRenderTarget(prev);
  target.dispose();

  // Flip WebGL's bottom-up pixel rows for the canvas.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    img.data.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
  }

  ctx.putImageData(img, 0, 0);

  stage.remove(root);

  if (parent) {
    parent.add(root);
  }

  root.position.copy(was.pos);
  root.rotation.y = was.rot;
  root.visible = was.visible;
  return canvas.toDataURL('image/png');
}

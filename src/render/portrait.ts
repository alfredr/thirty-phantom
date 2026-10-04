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
 * Head-and-shoulders framing: the top this share of the figure's height (plus HEADROOM of that above the head), seen
 * from a little above and to one side.
 */
const FRAME_SHARE = 0.36;
const HEADROOM = 0.12;
const FOV = 24;
const LOOK_DOWN = 0.1;
const LOOK_SIDE = 0.35;
/** Rendered far below the world, out of reach of the cutaway's cuts (they only take away what's above the focus). */
const STAGE_Y = -500;
/** Key light from the front left, a cool fill from the sky, and a backdrop of night purple. */
const KEY = { color: '#fff1dc', intensity: 4.2, at: [-1.2, 1.6, 2] as const };
const FILL = { sky: '#b9a8ff', ground: '#2a1a36', intensity: 1.9 };
const BACKDROP = PALETTE.night;

/**
 * A head-and-shoulders portrait of a character (Randy, Cody) for the HUD's dialogue: rendered once with the game's
 * renderer into an offscreen target, same framing, light and backdrop for everyone, turned three-quarters to look
 * toward the frame's left or right side (`looks`: the speaker on the left looks right, toward the other). `root` is
 * posed and dressed by the caller, feet at y=0 facing +Z; it's borrowed for the render and put back where it was.
 * Returns a PNG data URL.
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

  // frame the top of the figure: the head and the shoulders under it
  const bounds = new Box3().setFromObject(root);
  const tall = bounds.max.y - bounds.min.y;
  const span = tall * FRAME_SHARE * (1 + HEADROOM);
  const midY = bounds.max.y + tall * FRAME_SHARE * HEADROOM - span / 2;
  const dist = span / 2 / Math.tan(((FOV / 2) * Math.PI) / 180);
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 50);
  // seen from a little to one side, he faces the other way across the frame
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

  // GL rows run bottom-up
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

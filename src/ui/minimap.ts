import type { ObjectiveKind } from '../game/story/objectives';
import type { BoxDef, LevelData, V3 } from '../world/level-data';
import { el } from './dom';

/** What the minimap shows this frame. */
export interface MapView {
  /** Cody (or his ride), and the way he faces (yaw: forward = (sin, cos)). */
  x: number;
  z: number;
  yaw: number;
  /** The world direction that's up on screen: the map turns to match the camera. */
  upX: number;
  upZ: number;
  driving: boolean;
  marks: readonly { x: number; z: number; kind: ObjectiveKind }[];
}

/** The baked city: pixels per metre. */
const BAKE = 2;
/** Shown: CSS px per metre, on foot and driving (wider). */
const ZOOM = { foot: 1.5, drive: 0.85 };
const COLORS = {
  road: '#26212f',
  walk: '#3b3448',
  grass: '#1d3320',
  building: '#54436f',
  edge: '#0d0716',
  deck: '#3a2f55',
  slime: '#8dff1f',
  optional: '#c46bff',
  me: '#efe6ff',
  compass: '#2a1d3f',
};
/** The compass's radius (CSS px); it sits this far in from the map's top corner, with room for its pointer. */
const COMPASS = 13;

/**
 * Top-down map (desktop): the city baked once from the level's boxes, turned so up on the map is
 * up on screen. A 16:10 screen in a plate in the corner on foot; while driving, the middle of the
 * dash unit, between the speedometer and GhASt pods. Objectives show as slime (primary) and lilac (optional), pinned to the
 * rim when out of range. Not on touch screens: there's no room beside the controls.
 */
export class Minimap {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly city: HTMLCanvasElement;
  private readonly x0: number;
  private readonly z0: number;
  private readonly marks: readonly { x: number; z: number; label: string; color: string }[];

  /** `share`: another map of the same level, whose baked city this one draws too (one bake for both). */
  constructor(parent: HTMLElement, level: LevelData, share?: Minimap) {
    this.root = el('div', 'hud-map', parent);
    this.canvas = el('canvas', 'map-canvas', this.root);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('minimap: no 2d context');
    this.ctx = ctx;
    if (share) {
      this.x0 = share.x0;
      this.z0 = share.z0;
      this.city = share.city;
      this.marks = share.marks;
      return;
    }
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const b of level.boxes) {
      x0 = Math.min(x0, b.min[0]);
      z0 = Math.min(z0, b.min[2]);
      x1 = Math.max(x1, b.max[0]);
      z1 = Math.max(z1, b.max[2]);
    }
    this.x0 = x0 - 20;
    this.z0 = z0 - 20;
    this.city = bake(level, this.x0, this.z0, x1 + 20 - this.x0, z1 + 20 - this.z0);
    const randy = level.npcs.find((n) => n.id === 'randy');
    const foxy = level.valets[0];
    this.marks = [
      ...(randy ? [{ x: randy.pos[0], z: randy.pos[2], label: 'R', color: '#ffcf73' }] : []),
      ...(foxy ? [{ x: foxy.pos[0], z: foxy.pos[2], label: 'F', color: '#c46bff' }] : []),
    ];
  }

  draw(v: MapView): void {
    if (this.root.offsetParent === null) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const ctx = this.ctx;
    const k = v.driving ? ZOOM.drive : ZOOM.foot;
    // turn the world so the camera's up points up the map
    const turn = -Math.PI / 2 - Math.atan2(v.upZ, v.upX);
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = COLORS.road;
    ctx.fillRect(0, 0, cw, ch);
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(turn);
    ctx.scale(k, k);
    ctx.translate(-v.x, -v.z);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.city, this.x0, this.z0, this.city.width / BAKE, this.city.height / BAKE);
    ctx.restore();

    // map points: from world to the canvas, kept inside the screen
    const hx = cw / 2 - 9;
    const hz = ch / 2 - 9;
    const toMap = (x: number, z: number): { x: number; y: number; out: boolean } => {
      const dx = (x - v.x) * k;
      const dz = (z - v.z) * k;
      let sx = dx * cos - dz * sin;
      let sy = dx * sin + dz * cos;
      const over = Math.max(Math.abs(sx) / hx, Math.abs(sy) / hz);
      if (over > 1) {
        sx /= over;
        sy /= over;
      }
      return { x: cw / 2 + sx, y: ch / 2 + sy, out: over > 1 };
    };

    ctx.font = '9px Anton, Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const m of this.marks) {
      const p = toMap(m.x, m.z);
      if (p.out) continue;
      dot(ctx, p.x, p.y, 6, COLORS.edge, m.color);
      ctx.fillStyle = COLORS.edge;
      ctx.fillText(m.label, p.x, p.y + 0.5);
    }
    // optional first, so the primary sits on top
    for (const m of [...v.marks].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'optional' ? -1 : 1))) {
      const p = toMap(m.x, m.z);
      const primary = m.kind === 'primary';
      const color = primary ? COLORS.slime : COLORS.optional;
      if (p.out) {
        // a pointer on the rim, toward it
        const a = Math.atan2(p.y - ch / 2, p.x - cw / 2);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(5, 0);
        ctx.lineTo(-4, -4.5);
        ctx.lineTo(-4, 4.5);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.strokeStyle = COLORS.edge;
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      } else diamond(ctx, p.x, p.y, primary ? 6 : 4.5, color);
    }
    // a compass in the top corner: N where world north (-z, the deck's north face) lies on the turned map
    const nx = sin;
    const ny = -cos;
    ctx.save();
    ctx.translate(cw - COMPASS - 8, COMPASS + 8);
    dot(ctx, 0, 0, COMPASS, COLORS.edge, COLORS.compass);
    // a pointer on the rim, toward north, and the N just inside it
    ctx.beginPath();
    ctx.moveTo(nx * (COMPASS + 3), ny * (COMPASS + 3));
    ctx.lineTo(nx * (COMPASS - 3) - ny * 3.5, ny * (COMPASS - 3) + nx * 3.5);
    ctx.lineTo(nx * (COMPASS - 3) + ny * 3.5, ny * (COMPASS - 3) - nx * 3.5);
    ctx.closePath();
    ctx.fillStyle = COLORS.slime;
    ctx.strokeStyle = COLORS.edge;
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
    ctx.font = '11px Anton, Impact, sans-serif';
    ctx.fillStyle = COLORS.me;
    ctx.fillText('N', nx * 3, ny * 3 + 0.5);
    ctx.restore();
    // Cody: a chevron the way he faces
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    const a = Math.atan2(fx * sin + fz * cos, fx * cos - fz * sin);
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-5, -5);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fillStyle = COLORS.me;
    ctx.strokeStyle = COLORS.edge;
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** Moves it into `parent`: the dash unit's screen while driving, the phone's Map app, or the screen's corner. */
  dock(parent: HTMLElement, as: 'dash' | 'phone' | 'corner'): void {
    if (this.root.parentElement !== parent) parent.appendChild(this.root);
    this.root.classList.toggle('in-dash', as === 'dash');
    this.root.classList.toggle('in-phone', as === 'phone');
  }
}

/** The city from above: ground, walks and grass, then buildings by height, and the deck in slime. */
function bake(level: LevelData, x0: number, z0: number, w: number, d: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * BAKE);
  c.height = Math.ceil(d * BAKE);
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  ctx.fillStyle = COLORS.road;
  ctx.fillRect(0, 0, c.width, c.height);
  const rect = (b: { min: V3; max: V3 }): [number, number, number, number] => [
    (b.min[0] - x0) * BAKE,
    (b.min[2] - z0) * BAKE,
    (b.max[0] - b.min[0]) * BAKE,
    (b.max[2] - b.min[2]) * BAKE,
  ];
  const boxes = level.boxes.filter(shown).sort((a, b) => a.max[1] - b.max[1]);
  for (const b of boxes) {
    const flat = b.max[1] <= 0.35;
    ctx.fillStyle = flat ? (b.mat === 'grass' ? COLORS.grass : b.mat === 'asphalt' ? COLORS.road : COLORS.walk) : b.mat === 'slime' ? COLORS.slime : COLORS.building;
    const [x, y, rw, rh] = rect(b);
    ctx.fillRect(x, y, rw, rh);
    if (!flat) {
      ctx.strokeStyle = COLORS.edge;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, rw, rh);
    }
  }
  const [x, y, rw, rh] = rect(level.deck);
  ctx.fillStyle = COLORS.deck;
  ctx.fillRect(x, y, rw, rh);
  ctx.strokeStyle = COLORS.slime;
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, rw, rh);
  return c;
}

/** Boxes worth drawing from above: not the invisible ones, the paint, or lamp posts and other slivers. */
function shown(b: BoxDef): boolean {
  if (b.mat === 'invisible' || b.mat === 'marking' || b.mat.startsWith('lamp') || b.mat.startsWith('line')) return false;
  const area = (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);
  return area >= 4;
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, stroke: string, fill: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

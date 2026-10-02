import { BoxGeometry, Color, DynamicDrawUsage, Group, InstancedMesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { TUNING } from '../config';
import { GeometryBatch } from '../render/geometry';
import { FX_LAYER, fxDecal } from '../render/layers';
import { withCutaway } from '../render/materials';
import { puddleTexture } from '../render/textures';
import type { CollisionWorld, GroundHit, Solid } from './collision';
import { PUDDLE } from './slime';

/** Most drops and pools alive at once; the oldest pool goes to make room. */
const DROPS = 256;
const POOLS = 96;
/**
 * Pools spread as a film about 1 mm thick: radius = sqrt(volume / (pi * 1 mm)), so half a
 * litre spreads out past a body (about 0.4 m). No smaller than a visible speck, no bigger
 * than POOL_MAX (m).
 */
const POOL_K = 1 / Math.sqrt(Math.PI * 0.001);
const POOL_MIN = 0.08;
const POOL_MAX = 1.6;
/** Drops landing within this of a pool's edge join it (m). */
const MERGE = 0.25;
/** Share of a pool that dries away per second, and how long until it's gone dark (s). */
const DRY = 1 / 240;
const DARKEN = 90;
const FRESH = new Color('#7a0a12');
const DRIED = new Color('#2a0508');
/** Drops are drawn as cubes this size per cube root of their volume (bigger than life, to read at play zoom). */
const DROP_SIZE = 4;

const _gh: GroundHit = { solid: null };
const _c = new Color();

/**
 * Blood, on the drip system's rules made simpler: drops fall and splat onto
 * whatever's below, joining or starting a pool there; pools spread with the
 * blood in them and dry out slowly, darkening as they go. Fixed-size typed
 * arrays and instanced meshes, so a frame allocates nothing.
 */
export class BloodSim {
  readonly root = new Group();
  // drops
  private readonly dx = new Float32Array(DROPS);
  private readonly dy = new Float32Array(DROPS);
  private readonly dz = new Float32Array(DROPS);
  private readonly dvx = new Float32Array(DROPS);
  private readonly dvy = new Float32Array(DROPS);
  private readonly dvz = new Float32Array(DROPS);
  private readonly dvol = new Float32Array(DROPS);
  private nextDrop = 0;
  private readonly drops: InstancedMesh;
  private readonly dm: Float32Array;
  // pools
  private readonly px = new Float32Array(POOLS);
  private readonly py = new Float32Array(POOLS);
  private readonly pz = new Float32Array(POOLS);
  private readonly pv = new Float32Array(POOLS);
  private readonly pr = new Float32Array(POOLS);
  private readonly page = new Float32Array(POOLS);
  private readonly pcos = new Float32Array(POOLS);
  private readonly psin = new Float32Array(POOLS);
  private readonly paspect = new Float32Array(POOLS);
  private readonly pools: InstancedMesh;
  private readonly pm: Float32Array;

  constructor(private readonly world: CollisionWorld) {
    const dropMat = withCutaway(new MeshStandardMaterial({ color: FRESH, roughness: 0.3, metalness: 0.1 }));
    this.drops = new InstancedMesh(new BoxGeometry(1, 1, 1), dropMat, DROPS);
    this.drops.instanceMatrix.setUsage(DynamicDrawUsage);
    this.drops.frustumCulled = false;
    this.drops.layers.set(FX_LAYER);
    this.drops.name = 'blood-drops';
    this.dm = this.drops.instanceMatrix.array as Float32Array;
    this.dm.fill(0);

    const quad = new GeometryBatch();
    quad.flat(0, 0, 0, 1, 1, new Color(1, 1, 1));
    const poolMat = withCutaway(
      new MeshBasicMaterial({
        map: puddleTexture(23),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    this.pools = fxDecal(new InstancedMesh(quad.build(), poolMat, POOLS));
    this.pools.instanceMatrix.setUsage(DynamicDrawUsage);
    this.pools.frustumCulled = false;
    this.pools.name = 'blood-pools';
    this.pm = this.pools.instanceMatrix.array as Float32Array;
    this.pm.fill(0);
    for (let i = 0; i < POOLS; i++) this.pools.setColorAt(i, FRESH);
    this.root.add(this.drops, this.pools);
  }

  /** A drop of `vol` (m^3, a few cc) leaving (x, y, z) at (vx, vy, vz). */
  drip(x: number, y: number, z: number, vx: number, vy: number, vz: number, vol: number): void {
    const i = this.nextDrop;
    this.nextDrop = (i + 1) % DROPS;
    this.dx[i] = x;
    this.dy[i] = y;
    this.dz[i] = z;
    this.dvx[i] = vx;
    this.dvy[i] = vy;
    this.dvz[i] = vz;
    this.dvol[i] = vol;
  }

  /** A spray of `n` drops from (x, y, z), flung along (vx, vz) and up, spread by `spread` (m/s). */
  spray(x: number, y: number, z: number, vx: number, vz: number, n: number, spread: number, vol: number): void {
    for (let k = 0; k < n; k++) {
      this.drip(
        x,
        y,
        z,
        vx + (Math.random() - 0.5) * spread,
        2 + Math.random() * spread * 0.6,
        vz + (Math.random() - 0.5) * spread,
        vol * (0.5 + Math.random()),
      );
    }
  }

  update(dt: number): void {
    const g = TUNING.gravity;
    const m = this.dm;
    for (let i = 0; i < DROPS; i++) {
      const vol = this.dvol[i] as number;
      if (vol === 0) continue;
      const vy = (this.dvy[i] as number) - g * dt;
      const x = (this.dx[i] as number) + (this.dvx[i] as number) * dt;
      const y = (this.dy[i] as number) + vy * dt;
      const z = (this.dz[i] as number) + (this.dvz[i] as number) * dt;
      _gh.solid = null;
      const floor = this.world.groundAt(x, z, (this.dy[i] as number) + 0.05, 0, _gh);
      const o = i * 16;
      if (y <= floor) {
        // splat: into a pool, unless it's a ramp (a flat puddle can't lie on one)
        // (groundAt filled _gh in; TS can't see that through the call)
        if (!(_gh.solid as Solid | null)?.ramp) this.pool(x, floor, z, vol);
        this.dvol[i] = 0;
        m[o] = 0;
        m[o + 5] = 0;
        m[o + 10] = 0;
        continue;
      }
      this.dx[i] = x;
      this.dy[i] = y;
      this.dz[i] = z;
      this.dvy[i] = vy;
      const s = DROP_SIZE * Math.cbrt(vol);
      m[o] = s;
      m[o + 5] = s * 1.6;
      m[o + 10] = s;
      m[o + 12] = x;
      m[o + 13] = y;
      m[o + 14] = z;
      m[o + 15] = 1;
    }
    this.drops.instanceMatrix.needsUpdate = true;
    this.dryPools(dt);
  }

  /** Blood landing on the floor at (x, y, z): into a pool it touches, or a new one. */
  private pool(x: number, y: number, z: number, vol: number): void {
    let best = -1;
    let oldest = 0;
    for (let i = 0; i < POOLS; i++) {
      if ((this.pv[i] as number) <= 0) {
        if (best < 0) best = i;
        continue;
      }
      if (Math.abs((this.py[i] as number) - y) < 0.1) {
        const r = (this.pr[i] as number) + MERGE;
        const dx = (this.px[i] as number) - x;
        const dz = (this.pz[i] as number) - z;
        if (dx * dx + dz * dz < r * r) {
          this.pv[i] = (this.pv[i] as number) + vol;
          this.page[i] = Math.min(this.page[i] as number, DARKEN * 0.5);
          return;
        }
      }
      if ((this.page[i] as number) > (this.page[oldest] as number)) oldest = i;
    }
    const i = best >= 0 ? best : oldest;
    this.px[i] = x;
    this.py[i] = y + PUDDLE.lift;
    this.pz[i] = z;
    this.pv[i] = vol;
    this.pr[i] = 0;
    this.page[i] = 0;
    const a = Math.random() * Math.PI;
    this.pcos[i] = Math.cos(a);
    this.psin[i] = Math.sin(a);
    this.paspect[i] = PUDDLE.aspect[0] + Math.random() * (PUDDLE.aspect[1] - PUDDLE.aspect[0]);
  }

  private dryPools(dt: number): void {
    const m = this.pm;
    const k = 1 - Math.exp(-4 * dt);
    const dry = 1 - DRY * dt;
    let colors = false;
    for (let i = 0; i < POOLS; i++) {
      const vol = (this.pv[i] as number) * dry;
      const o = i * 16;
      if (vol <= 1e-7) {
        if (m[o] !== 0) {
          m[o] = m[o + 2] = m[o + 8] = m[o + 10] = 0;
        }
        this.pv[i] = 0;
        continue;
      }
      this.pv[i] = vol;
      const age = (this.page[i] as number) + dt;
      this.page[i] = age;
      // spreads with what's in it (eased, so a splat swells it rather than popping)
      let r = this.pr[i] as number;
      r += (Math.min(POOL_MAX, Math.max(POOL_MIN, POOL_K * Math.sqrt(vol))) - r) * k;
      this.pr[i] = r;
      const sx = r * 2;
      const sz = sx * (this.paspect[i] as number);
      const c = this.pcos[i] as number;
      const s = this.psin[i] as number;
      m[o] = c * sx;
      m[o + 2] = -s * sx;
      m[o + 5] = 1;
      m[o + 8] = s * sz;
      m[o + 10] = c * sz;
      m[o + 12] = this.px[i] as number;
      m[o + 13] = this.py[i] as number;
      m[o + 14] = this.pz[i] as number;
      m[o + 15] = 1;
      // darkens as it dries (only re-tinted every so often, it's slow)
      if ((i + Math.floor(age * 4)) % 8 === 0) {
        this.pools.setColorAt(i, _c.copy(FRESH).lerp(DRIED, Math.min(1, age / DARKEN)));
        colors = true;
      }
    }
    this.pools.instanceMatrix.needsUpdate = true;
    if (colors && this.pools.instanceColor) this.pools.instanceColor.needsUpdate = true;
  }
}

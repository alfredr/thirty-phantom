import { Box3, Color, DynamicDrawUsage, Group, InstancedMesh, type Material, type Object3D, Sphere, Vector3 } from 'three';
import { Rng } from '../engine/core/rng';
import { CHUNK, GeometryBatch, NO_TINT } from '../render/geometry';
import { PALETTE } from '../render/palette';
import { BULB, type DripSpec, type FilmSpec } from './drips';

/** Where drops collect into a puddle, and how far it can spread there before running off the edge. */
export interface PoolSite {
  x: number;
  y: number;
  z: number;
  room: number;
}

/** Fraction of a bulb's slime that leaks away (evaporates, soaks in) per second. */
const LEAK = 1 / 20;
/** Fraction of a puddle that evaporates per second. */
const EVAP = 1 / 45;
/**
 * Wall drips: the lip keeps a bulb topped up to WALL_FILL of full. Past
 * SLIDE_AT it's too heavy for the wall to hold and slides, running slime into
 * the strand, until it's down to SLIDE_TO.
 */
const WALL_FILL = 0.85;
const SLIDE_AT = 0.7;
const SLIDE_TO = 0.4;
/** How fast a sliding bulb runs down the wall (m/s). */
const SLIDE = 0.35;
/** Strand thickness off the face (m); its cross-section is this times its width. */
const STRAND = 0.09;
/** Hanging drips: a full bulb pinches off, leaving this much behind. */
const REST = 0.15;
/** Fraction of an underside run's slime that slides to its under edge per second. */
const DRAIN = 1 / 25;
/** Cohesion: spring and damping on a hanging drip's stretch. */
const STIFF = 30;
const DAMPING = 4;
/** Drop gravity, a little floaty for the camera. */
const GRAVITY = 18;
/** Puddle radius per sqrt(volume), and the most it spreads. */
const PUDDLE_K = 1.5;
const PUDDLE_MAX = 2;
/** Batches whose bounds are this far from the focus keep simulating but aren't redrawn. */
const NEAR = 90;
/** Splats this close to the focus get a splash. */
const SPLASH = 45;
/** A full bulb's width per metre of drip width, and its length once it hangs free. */
const BULB_W = BULB.base + BULB.grow;
const FREE_STRETCH = 1 + BULB.stretchFree;

/** How a slime puddle looks, shared with the static puddle decals (build-world). */
export const PUDDLE = {
  color: new Color(PALETTE.slime).multiplyScalar(0.8),
  /** Height above the surface it lies on (m). */
  lift: 0.03,
  /** Random length-to-width range of its oval. */
  aspect: [0.7, 1.1] as const,
};

interface Batch {
  mesh: InstancedMesh;
  m: Float32Array;
  /** Drip and film index ranges. */
  start: number;
  end: number;
  fstart: number;
  fend: number;
  /** Breakable it hangs off; a smashed one takes its slime with it. */
  owner: Object3D | null;
  cx: number;
  cz: number;
  r: number;
}

/**
 * Live edge slime, by volume. Each lip feeds its drips' bulbs at a steady rate
 * and every bulb leaks a little; a bulb's size is just how much it holds.
 *
 * On a wall the lip keeps the bulb topped up past what the wall can hold, so
 * it slides down, running slime into the strand, until the drip reaches as far
 * as it goes. There it settles where inflow and leak balance. Hanging free past
 * the end of its face, a bulb's weight stretches the neck against cohesion. A
 * lightly fed one settles, sagging; a heavily fed one fills until it pinches
 * off and the rest springs back. Drops fall, splat and feed a puddle, and
 * puddles evaporate.
 *
 * Underside slime has no lip feeding it. Each run of it slides down to its
 * under edge, its films shrinking as they go, and collects in the drips there
 * until they fall; once it's spent, it's gone.
 *
 * All state lives in typed arrays sized at build time, the hot loops make no
 * calls that return numbers, and instance matrices are written in place
 * (axis-aligned boxes: scale and translation only), so a frame allocates nothing.
 */
export class SlimeSim {
  readonly root = new Group();
  readonly puddles: InstancedMesh;
  /** A drop landed near the focus, at `splat`, from a drip `splatSize` wide. */
  onSplat: (() => void) | null = null;
  readonly splat = new Vector3();
  splatSize = 0;

  private readonly batches: Batch[] = [];
  /** box() arguments: passed through here, since floats passed to a call that isn't inlined get boxed. */
  private readonly arg = new Float64Array(5);
  /** This frame's step, kept here rather than passed to step() for the same reason. */
  private dt = 0;
  /** How much slime there is in the world (0 none, 1 all of it), and how fast it's oozing in (per s). */
  private presence = 1;
  private emerging = 0;
  /** Materials that fade with it: the slime itself (every edge lip), the puddle decals, any added by fadeWith(). */
  private readonly fading: Material[] = [];

  // per drip: layout
  private readonly axisZ: Uint8Array;
  private readonly out: Int8Array;
  private readonly along: Float32Array;
  private readonly face: Float32Array;
  private readonly top: Float32Array;
  private readonly w: Float32Array;
  private readonly reach: Float32Array;
  private readonly hang: Float32Array;
  private readonly drops: Uint8Array;
  private readonly landY: Float32Array;
  private readonly pool: Int32Array;
  /** First instance: strand, bulb, then neck and drop for hanging drips. */
  private readonly slot: Int32Array;
  /** Volume of a full bulb, and what the lip feeds it per second. */
  private readonly full: Float32Array;
  private readonly feed: Float32Array;
  /** Underside run it collects from (-1: fed by its lip). */
  private readonly run: Int32Array;
  // per drip: state
  private readonly vol: Float32Array;
  private readonly len: Float32Array;
  private readonly sliding: Uint8Array;
  private readonly stretch: Float32Array;
  private readonly stretchV: Float32Array;
  private readonly dropVol: Float32Array;
  private readonly dropY: Float32Array;
  private readonly dropV: Float32Array;
  // per underside film: its box when full, the edge it slides to, its run, its instance
  private readonly film: Float32Array;
  private readonly filmRun: Int32Array;
  private readonly filmSlot: Int32Array;
  // per underside run: slime left, at the start, drips collecting it, and each one's share this frame
  private readonly runVol: Float32Array;
  private readonly runVol0: Float32Array;
  private readonly runDrips: Int32Array;
  private readonly runShare: Float32Array;
  // per puddle
  private readonly pmax: Float32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly pv: Float32Array;
  private readonly pr: Float32Array;
  private readonly pcos: Float32Array;
  private readonly psin: Float32Array;
  private readonly paspect: Float32Array;
  private readonly pm: Float32Array;

  constructor(
    entries: readonly { spec: DripSpec; owner: Object3D | null }[],
    filmEntries: readonly { film: FilmSpec; owner: Object3D | null }[],
    runs: number,
    pools: readonly PoolSite[],
    mat: Material,
    puddleMat: Material,
  ) {
    // group by owner, or by world chunk
    const groups = new Map<string, { owner: Object3D | null; specs: DripSpec[]; films: FilmSpec[] }>();
    const groupFor = (owner: Object3D | null, x: number, z: number) => {
      const key = owner ? `o${owner.id}` : `${Math.floor(x / CHUNK)}|${Math.floor(z / CHUNK)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { owner, specs: [], films: [] }));
      return g;
    };
    for (const { spec, owner } of entries) {
      groupFor(owner, spec.axis === 'x' ? spec.along : spec.face, spec.axis === 'x' ? spec.face : spec.along).specs.push(spec);
    }
    for (const { film, owner } of filmEntries) {
      groupFor(owner, (film.min[0] + film.max[0]) / 2, (film.min[2] + film.max[2]) / 2).films.push(film);
    }
    const n = entries.length;
    const nf = filmEntries.length;
    this.film = new Float32Array(nf * 7);
    this.filmRun = new Int32Array(nf);
    this.filmSlot = new Int32Array(nf);
    this.runVol = new Float32Array(runs);
    this.runVol0 = new Float32Array(runs);
    this.runDrips = new Int32Array(runs);
    this.runShare = new Float32Array(runs);
    this.run = new Int32Array(n);
    this.axisZ = new Uint8Array(n);
    this.out = new Int8Array(n);
    this.along = new Float32Array(n);
    this.face = new Float32Array(n);
    this.top = new Float32Array(n);
    this.w = new Float32Array(n);
    this.reach = new Float32Array(n);
    this.hang = new Float32Array(n);
    this.drops = new Uint8Array(n);
    this.landY = new Float32Array(n);
    this.pool = new Int32Array(n);
    this.slot = new Int32Array(n);
    this.full = new Float32Array(n);
    this.feed = new Float32Array(n);
    this.vol = new Float32Array(n);
    this.len = new Float32Array(n);
    this.sliding = new Uint8Array(n);
    this.stretch = new Float32Array(n);
    this.stretchV = new Float32Array(n);
    this.dropVol = new Float32Array(n);
    this.dropY = new Float32Array(n);
    this.dropV = new Float32Array(n);

    const np = pools.length;
    this.pmax = new Float32Array(np);
    this.px = new Float32Array(np);
    this.py = new Float32Array(np);
    this.pz = new Float32Array(np);
    this.pv = new Float32Array(np);
    this.pr = new Float32Array(np);
    this.pcos = new Float32Array(np);
    this.psin = new Float32Array(np);
    this.paspect = new Float32Array(np);

    const rng = new Rng(77);
    const inflow = new Float32Array(np);
    const box = new GeometryBatch();
    box.box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], NO_TINT, 1, false);
    const geo = box.build();
    const bounds = new Box3();
    const p = new Vector3();
    let k = 0;
    let fk = 0;
    for (const { owner, specs, films } of groups.values()) {
      const start = k;
      const fstart = fk;
      let slots = 0;
      bounds.makeEmpty();
      for (const s of specs) {
        this.axisZ[k] = s.axis === 'z' ? 1 : 0;
        this.out[k] = s.out;
        this.along[k] = s.along;
        this.face[k] = s.face;
        this.top[k] = s.top;
        this.w[k] = s.w;
        this.reach[k] = s.reach;
        this.hang[k] = s.hang;
        this.drops[k] = s.drops ? 1 : 0;
        this.landY[k] = s.landY;
        this.pool[k] = s.pool;
        this.run[k] = s.run;
        this.slot[k] = slots;
        slots += s.hang > 0 ? 4 : 2;
        const full = bulbVolume(s.w, s.hang > 0);
        this.full[k] = full;
        // start each drip somewhere in its life, as if it had been oozing a while
        if (s.run >= 0) {
          // underside: empty, waiting on its run
          this.runDrips[s.run] = (this.runDrips[s.run] as number) + 1;
          this.stretch[k] = s.hang * 0.2;
        } else if (s.hang === 0) {
          this.feed[k] = WALL_FILL * full * LEAK;
          const settled = rng.chance(0.65);
          this.len[k] = settled ? s.reach : s.reach * rng.range(0.45, 1);
          this.vol[k] = settled ? WALL_FILL * full : rng.range(SLIDE_TO, SLIDE_AT) * full;
        } else if (!s.drops) {
          // fed too lightly to ever fill: it settles part full, sagging its whole hang
          const fill = rng.range(0.5, 0.9);
          this.feed[k] = fill * full * LEAK;
          this.vol[k] = fill * full;
          this.stretch[k] = s.hang;
        } else {
          // fed past full: it fills, pinches off, and starts again
          const c = rng.range(1.3, 2.2);
          this.feed[k] = c * full * LEAK;
          const f = rng.range(REST, 1);
          this.vol[k] = f * full;
          this.stretch[k] = s.hang * (0.2 + 0.8 * f * f);
          const period = Math.log((c - REST) / (c - 1)) / LEAK;
          if (s.pool >= 0) inflow[s.pool] = (inflow[s.pool] as number) + ((1 - REST) * full) / period;
        }
        const x = s.axis === 'x' ? s.along : s.face;
        const z = s.axis === 'x' ? s.face : s.along;
        bounds.expandByPoint(p.set(x, s.top + 0.3, z));
        bounds.expandByPoint(p.set(x, s.drops ? s.landY : s.top - s.reach - s.hang * 1.5 - 0.6, z));
        k++;
      }
      for (const f of films) {
        const o = fk * 7;
        this.film.set([f.min[0], f.min[1], f.min[2], f.max[0], f.max[1], f.max[2], f.edge], o);
        this.filmRun[fk] = f.run;
        this.filmSlot[fk] = slots++;
        const v = (f.max[0] - f.min[0]) * (f.max[1] - f.min[1]) * (f.max[2] - f.min[2]);
        this.runVol[f.run] = (this.runVol[f.run] as number) + v;
        this.runVol0[f.run] = (this.runVol0[f.run] as number) + v;
        bounds.expandByPoint(p.set(f.min[0], f.min[1], f.min[2]));
        bounds.expandByPoint(p.set(f.max[0], f.max[1], f.max[2]));
        fk++;
      }
      bounds.expandByScalar(0.6);
      const mesh = new InstancedMesh(geo, mat, slots);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // drips are too thin for their shadows to read, and a batch is a shadow-pass draw call
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = 'slime-drips';
      const sphere = bounds.getBoundingSphere(new Sphere());
      mesh.boundingSphere = sphere;
      (owner ?? this.root).add(mesh);
      this.batches.push({
        mesh,
        m: mesh.instanceMatrix.array as Float32Array,
        start,
        end: k,
        fstart,
        fend: fk,
        owner,
        cx: sphere.center.x,
        cz: sphere.center.z,
        r: sphere.radius,
      });
    }

    // puddles start where inflow and evaporation balance
    const quad = new GeometryBatch();
    quad.flat(0, 0, 0, 1, 1, PUDDLE.color);
    this.fading.push(mat, puddleMat);
    this.puddles = new InstancedMesh(quad.build(), puddleMat, Math.max(1, np));
    this.puddles.instanceMatrix.setUsage(DynamicDrawUsage);
    this.puddles.frustumCulled = false;
    this.puddles.name = 'slime-puddles';
    this.puddles.count = np;
    this.pm = this.puddles.instanceMatrix.array as Float32Array;
    pools.forEach((s, i) => {
      this.pmax[i] = Math.min(PUDDLE_MAX, s.room);
      this.px[i] = s.x;
      this.py[i] = s.y + PUDDLE.lift;
      this.pz[i] = s.z;
      this.pv[i] = (inflow[i] as number) / EVAP;
      this.pr[i] = Math.min(this.pmax[i] as number, PUDDLE_K * Math.sqrt(this.pv[i] as number));
      const a = rng.range(0, Math.PI);
      this.pcos[i] = Math.cos(a);
      this.psin[i] = Math.sin(a);
      this.paspect[i] = rng.range(PUDDLE.aspect[0], PUDDLE.aspect[1]);
    });

    for (const b of this.batches) this.draw(b);
    this.drawPuddles();
  }

  /**
   * How much slime the world has, at once: 0 none at all (lips, drips, puddles hidden), 1 all of
   * it. In between, drips reach part way out of their lips and the rest dissolves in.
   */
  setPresence(f: number): void {
    this.presence = Math.min(1, Math.max(0, f));
    this.emerging = 0;
    this.applyPresence();
  }

  /** Ooze in from however much there is now to all of it, over `seconds`. */
  emerge(seconds = 3): void {
    this.emerging = 1 / Math.max(0.01, seconds);
  }

  /** Another material to fade in and out with the slime (the fountain and pond pools). */
  fadeWith(mat: Material): void {
    if (!this.fading.includes(mat)) this.fading.push(mat);
    this.applyPresence();
  }

  private applyPresence(): void {
    const f = this.presence;
    for (const m of this.fading) {
      m.visible = f > 0;
      m.opacity = f;
      // solid ones dissolve in with dithered alpha (no sorting trouble); decals already blend
      if (!m.transparent && m.alphaHash !== f < 1) {
        m.alphaHash = f < 1;
        m.needsUpdate = true;
      }
    }
  }

  update(dt: number, focus: { x: number; z: number }): void {
    this.dt = Math.min(dt, 0.1);
    if (this.emerging > 0) {
      this.presence = Math.min(1, this.presence + this.dt * this.emerging);
      if (this.presence >= 1) this.emerging = 0;
      this.applyPresence();
    }
    // underside runs slide down to their edge drips, shared out evenly
    const rv = this.runVol;
    for (let r = 0; r < rv.length; r++) {
      const v = rv[r] as number;
      if (v === 0) continue;
      const d = v < 1e-6 ? v : v * DRAIN * this.dt;
      rv[r] = v - d;
      const n = this.runDrips[r] as number;
      this.runShare[r] = n > 0 ? d / n : 0;
    }
    for (let i = 0; i < this.batches.length; i++) {
      const b = this.batches[i] as Batch;
      if (b.owner && !b.owner.visible) continue;
      for (let k = b.start; k < b.end; k++) this.step(k, focus);
      const dx = b.cx - focus.x;
      const dz = b.cz - focus.z;
      const near = b.r + NEAR;
      if (dx * dx + dz * dz < near * near) this.draw(b);
    }
    const pv = this.pv;
    const evap = 1 - EVAP * this.dt;
    for (let i = 0; i < pv.length; i++) pv[i] = (pv[i] as number) * evap;
    this.drawPuddles();
  }

  private step(k: number, focus: { x: number; z: number }): void {
    const dt = this.dt;
    const full = this.full[k] as number;
    // in from the lip (or the run it collects), out by leaking
    const run = this.run[k] as number;
    let vol = (this.vol[k] as number) + ((this.feed[k] as number) - LEAK * (this.vol[k] as number)) * dt;
    if (run >= 0) vol += this.runShare[run] as number;
    if (this.hang[k] === 0) {
      // on the wall: too heavy to hold, it slides and runs into the strand
      const reach = this.reach[k] as number;
      let len = this.len[k] as number;
      if (len < reach && (this.sliding[k] || vol > SLIDE_AT * full)) {
        const section = (this.w[k] as number) * STRAND;
        const d = Math.min(dt * SLIDE, reach - len, (vol - SLIDE_TO * full) / section);
        if (d > 0) {
          len += d;
          vol -= d * section;
        }
        this.sliding[k] = d > 0 && len < reach && vol > SLIDE_TO * full ? 1 : 0;
        this.len[k] = len;
      }
      this.vol[k] = vol;
      return;
    }
    // hanging free: the neck springs toward where the bulb's weight pulls it
    const f = vol / full;
    const hang = this.hang[k] as number;
    const target = this.drops[k] ? hang * (0.2 + 0.8 * f * f) : (hang * vol) / ((this.feed[k] as number) / LEAK);
    let e = this.stretch[k] as number;
    let v = this.stretchV[k] as number;
    v += ((target - e) * STIFF - v * DAMPING) * dt;
    e = Math.max(0, e + v * dt);
    if (this.drops[k] && f >= 1 && this.dropVol[k] === 0) {
      // pinch off: the bulb drops and the neck springs back
      const w = this.w[k] as number;
      const tall = w * BULB_W * FREE_STRETCH;
      this.dropVol[k] = vol - REST * full;
      this.dropY[k] = (this.top[k] as number) - (this.reach[k] as number) - e - tall * (BULB.below - 0.5);
      this.dropV[k] = -Math.max(0, v);
      vol = REST * full;
      v = -hang * 3;
    }
    this.vol[k] = vol;
    this.stretch[k] = e;
    this.stretchV[k] = v;
    const dropVol = this.dropVol[k] as number;
    if (dropVol === 0) return;
    const vy = (this.dropV[k] as number) - GRAVITY * dt;
    const y = (this.dropY[k] as number) + vy * dt;
    const w = this.w[k] as number;
    if (y - w * BULB_W * FREE_STRETCH * 0.5 > (this.landY[k] as number)) {
      this.dropV[k] = vy;
      this.dropY[k] = y;
      return;
    }
    // splat
    this.dropVol[k] = 0;
    const pool = this.pool[k] as number;
    if (pool >= 0) this.pv[pool] = (this.pv[pool] as number) + dropVol;
    if (!this.onSplat) return;
    const c = (this.face[k] as number) + (this.out[k] as number) * 0.035;
    const x = this.axisZ[k] ? c : (this.along[k] as number);
    const z = this.axisZ[k] ? (this.along[k] as number) : c;
    const dx = x - focus.x;
    const dz = z - focus.z;
    if (dx * dx + dz * dz > SPLASH * SPLASH) return;
    this.splat.set(x, this.landY[k] as number, z);
    this.splatSize = w;
    this.onSplat();
  }

  private draw(b: Batch): void {
    const m = b.m;
    const a = this.arg;
    // while the slime oozes in, drips reach only part way out of their lips
    const g = this.presence;
    for (let k = b.start; k < b.end; k++) {
      const s = (this.slot[k] as number) * 16;
      const top = this.top[k] as number;
      const w = this.w[k] as number;
      // how full the bulb is sets its size
      const f = Math.min(1.15, (this.vol[k] as number) / (this.full[k] as number));
      const across = w * (BULB.base + BULB.grow * f) * g;
      if (this.hang[k] === 0) {
        const end = top - (this.len[k] as number) * g;
        a[0] = w;
        a[1] = -0.02;
        a[2] = 0.07;
        a[3] = end;
        a[4] = top;
        this.box(m, s, k);
        // flat against the wall
        const tall = across * (1 + BULB.stretchWall * f);
        a[0] = across;
        a[1] = -0.03;
        a[2] = -0.03 + BULB.depth;
        a[3] = end - tall * BULB.below;
        a[4] = end + tall * (1 - BULB.below);
        this.box(m, s + 16, k);
        continue;
      }
      const face = top - (this.reach[k] as number) * g;
      const end = face - (this.stretch[k] as number) * g;
      // an underside drip is only there while it has slime in it
      const there = (this.run[k] as number) < 0 ? 1 : Math.min(1, f / REST);
      a[0] = w * there;
      a[1] = -0.02;
      a[2] = 0.07;
      a[3] = face;
      a[4] = top;
      this.box(m, s, k);
      // the neck thins as it stretches
      a[0] = w * there * (this.drops[k] ? 1 - 0.55 * f * f : 1 - 0.2 * f);
      a[3] = end;
      a[4] = face + 0.01;
      this.box(m, s + 32, k);
      const tall = across * (1 + BULB.stretchFree * f) * there;
      a[0] = across * there;
      a[1] = -0.03;
      a[2] = -0.03 + BULB.depth + BULB.bulge * across * f;
      a[3] = end - tall * BULB.below;
      a[4] = end + tall * (1 - BULB.below);
      this.box(m, s + 16, k);
      const dropVol = g < 1 ? 0 : (this.dropVol[k] as number);
      if (dropVol > 0) {
        // as big as the slime in it, stretched with speed
        const a0 = w * BULB_W * Math.cbrt(dropVol / (this.full[k] as number));
        const q = 1 + Math.min(0.7, -(this.dropV[k] as number) * 0.05);
        const t = a0 * FREE_STRETCH * q;
        const y = this.dropY[k] as number;
        a[0] = a0 / Math.sqrt(q);
        a[2] = -0.03 + BULB.depth + BULB.bulge * a0;
        a[3] = y - t / 2;
        a[4] = y + t / 2;
        this.box(m, s + 48, k);
      } else {
        m[s + 48] = 0;
        m[s + 53] = 0;
        m[s + 58] = 0;
      }
    }
    // underside films sink toward their edge as their run drains
    const fl = this.film;
    for (let i = b.fstart; i < b.fend; i++) {
      const o = (this.filmSlot[i] as number) * 16;
      const r = this.filmRun[i] as number;
      const left = (this.runVol[r] as number) / (this.runVol0[r] as number);
      const j = i * 7;
      const edge = fl[j + 6] as number;
      const y0 = edge + ((fl[j + 1] as number) - edge) * left * g;
      const y1 = edge + ((fl[j + 4] as number) - edge) * left * g;
      const live = left > 0.02 && g > 0;
      m[o] = live ? (fl[j + 3] as number) - (fl[j] as number) : 0;
      m[o + 5] = live ? y1 - y0 : 0;
      m[o + 10] = live ? (fl[j + 5] as number) - (fl[j + 2] as number) : 0;
      m[o + 12] = ((fl[j] as number) + (fl[j + 3] as number)) * 0.5;
      m[o + 13] = (y0 + y1) * 0.5;
      m[o + 14] = ((fl[j + 2] as number) + (fl[j + 5] as number)) * 0.5;
    }
    b.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Axis-aligned box at matrix offset o off drip k: arg = [width along the edge, o0, o1 off the face, y0, y1]. */
  private box(m: Float32Array, o: number, k: number): void {
    const a = this.arg;
    const o0 = a[1] as number;
    const o1 = a[2] as number;
    const y0 = a[3] as number;
    const y1 = a[4] as number;
    const c = (this.face[k] as number) + (this.out[k] as number) * (o0 + o1) * 0.5;
    const along = this.along[k] as number;
    if (this.axisZ[k]) {
      m[o] = o1 - o0;
      m[o + 10] = a[0] as number;
      m[o + 12] = c;
      m[o + 14] = along;
    } else {
      m[o] = a[0] as number;
      m[o + 10] = o1 - o0;
      m[o + 12] = along;
      m[o + 14] = c;
    }
    m[o + 5] = y1 > y0 ? y1 - y0 : 0;
    m[o + 13] = (y0 + y1) * 0.5;
  }

  private drawPuddles(): void {
    const m = this.pm;
    const k = 1 - Math.exp(-2.5 * this.dt);
    for (let i = 0; i < this.pv.length; i++) {
      // spreads with the slime in it (eased, so a splat swells it rather than popping)
      let r = this.pr[i] as number;
      r += (Math.min(this.pmax[i] as number, PUDDLE_K * Math.sqrt(this.pv[i] as number)) - r) * k;
      this.pr[i] = r;
      const o = i * 16;
      const sx = r < 0.05 ? 0 : r * 2;
      const sz = sx * (this.paspect[i] as number);
      const c = this.pcos[i] as number;
      const s = this.psin[i] as number;
      m[o] = c * sx;
      m[o + 2] = -s * sx;
      m[o + 8] = s * sz;
      m[o + 10] = c * sz;
      m[o + 12] = this.px[i] as number;
      m[o + 13] = this.py[i] as number;
      m[o + 14] = this.pz[i] as number;
    }
    this.puddles.instanceMatrix.needsUpdate = true;
  }
}

/** Slime in a full bulb off a drip of width w (bulbSize at f = 1). */
function bulbVolume(w: number, free: boolean): number {
  const across = w * BULB_W;
  return across * across * (1 + (free ? BULB.stretchFree : BULB.stretchWall)) * (BULB.depth + (free ? BULB.bulge * across : 0));
}

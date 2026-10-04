import type { Vehicle } from '@/actors/vehicle';
import { TUNING } from '@/config';
import { clamp, smoothstep } from '@/engine/core/math';
import type { Npc } from '@/game/randy/npcs';
import type { GateRuntime } from '@/world/gates';
import type { SoundOf } from './cues';
import { EngineState } from './engine-state';
import type { Loop, Mixer } from './mixer';

const A = TUNING.audio;
const E = A.engines;
/** A gate's arm moving faster than this (its opening, 0..1, a second) runs its motor, and stops it below `still`. */
const ARM = { moving: 0.15, still: 0.05 };
/** A running traffic engine ranks as if this much nearer, so two cars about as far off don't keep trading places. */
const STAY = 0.7;
/** By night, a moan in the dark every so often (s, least and most). */
const MOANS: readonly [number, number] = [20, 45];

/** 0 by day, 1 by night, crossing over TUNING.audio.dusk game hours either side of sunrise and nightfall. */
export function nightness(hours: number): number {
  const { sunrise, nightfall } = TUNING.clock;
  const w = A.dusk;
  return 1 - smoothstep(sunrise - w, sunrise + w, hours) * (1 - smoothstep(nightfall - w, nightfall + w, hours));
}

/** A loop that should be playing or not: started when it's wanted (tried again next frame if it can't yet), stopped when it isn't. */
function keep(loop: Loop | null, want: boolean, start: () => Loop | null): Loop | null {
  if (want) return loop ?? start();
  loop?.stop();
  return null;
}

interface Running {
  loop: Loop;
  sound: SoundOf<'engine'>;
  /** Its revs, gear and load. */
  state: EngineState;
  /** Its speed last frame and how fast that's been changing (smoothed): traffic's throttle. */
  speed: number;
  accel: number;
}

/** Engines: Cody's ride, and the nearest few running cars, each with revs and load from how it's going. */
class Engines {
  private readonly on = new Map<Vehicle, Running>();
  private readonly near: Vehicle[] = [];

  constructor(private readonly mixer: Mixer) {}

  /** `ride`: what Cody's driving, if anything, with his throttle (-1..1) and whether he's burning GhASt. */
  update(dt: number, cars: readonly Vehicle[], ride: Vehicle | null, throttle: number, boost: boolean): void {
    const ear = this.mixer.ear;
    const near = this.near;
    near.length = 0;
    for (const v of cars) {
      if (v === ride || !v.engineOn) continue;
      if (v.pos.distanceTo(ear) < (this.on.has(v) ? E.leave : E.reach)) near.push(v);
    }
    const rank = (v: Vehicle): number => v.pos.distanceTo(ear) * (this.on.has(v) ? STAY : 1);
    near.sort((a, b) => rank(a) - rank(b));
    near.length = Math.min(near.length, E.traffic);
    // stopped before any start, so the cue's cap has room
    for (const [v, r] of this.on) {
      if (v === ride || near.includes(v)) continue;
      r.loop.stop();
      this.on.delete(v);
    }
    if (ride) this.run(ride, dt, throttle, boost, true);
    for (const v of near) this.run(v, dt, 0, false, false);
  }

  private run(v: Vehicle, dt: number, throttle: number, boost: boolean, mine: boolean): void {
    const { engine: sound, gears } = v.breed;
    let r = this.on.get(v);
    // turned into the monster truck, or back
    if (r && r.sound !== sound) {
      r.loop.stop();
      this.on.delete(v);
      r = undefined;
    }
    if (!r) {
      const loop = this.mixer.loop('engine', sound, v.pos, 1, mine ? 'Cody' : `car ${v.id}`);
      if (!loop) return;
      r = { loop, sound, state: new EngineState(gears), speed: Math.abs(v.speed), accel: 0 };
      this.on.set(v, r);
    }
    const speed = Math.abs(v.speed);
    // traffic's throttle, from how it's speeding up (it has no pedal to read)
    r.accel += ((speed - r.speed) / Math.max(dt, 1e-3) - r.accel) * (1 - Math.exp(-dt / 0.2));
    r.speed = speed;
    const pedal = mine ? (boost ? 1 : throttle) : r.accel > 0.3 ? clamp(r.accel / 4, 0.25, 1) : 0;
    r.state.update(dt, speed / v.params.maxSpeed, pedal, !v.grounded || v.crashing);
    r.loop.set({ rpm: r.state.rpm, load: r.state.load });
  }
}

/**
 * The loops that follow play from frame to frame: engines, Randy's fire (roaring when fed), the
 * badge gates' arm motors, the GhASt burn, the burner ringing, and the day and night ambience.
 */
export class Loops {
  private readonly engines: Engines;
  private readonly fires = new Map<Npc, Loop>();
  private readonly arms = new Map<GateRuntime, { open: number; loop: Loop | null }>();
  private boost: Loop | null = null;
  private call: Loop | null = null;
  private day: Loop | null = null;
  private night: Loop | null = null;
  private moanIn = MOANS[0];
  /** Randy's on the line: the burner rings till he isn't. */
  ringing = false;

  constructor(private readonly mixer: Mixer) {
    this.engines = new Engines(mixer);
  }

  update(dt: number, s: { cars: readonly Vehicle[]; ride: Vehicle | null; throttle: number; burning: boolean; npcs: readonly Npc[]; gates: readonly GateRuntime[]; hours: number }): void {
    const m = this.mixer;
    this.engines.update(dt, s.cars, s.ride, s.throttle, s.burning);
    const ride = s.ride;
    this.boost = keep(this.boost, s.burning && ride !== null, () => (ride ? m.loop('boost', 'boost-roar', ride.pos) : null));
    this.boost?.set({ roar: 1 });
    this.call = keep(this.call, this.ringing, () => m.loop('call', 'phone-ring', null));
    this.updateFires(s.npcs);
    this.updateArms(dt, s.gates);
    const n = nightness(s.hours);
    this.day = keep(this.day, true, () => m.loop('ambience', 'day-town', null, 1 - n));
    this.night = keep(this.night, true, () => m.loop('ambience', 'night-wind', null, n));
    if (this.day) this.day.gain = 1 - n;
    if (this.night) this.night.gain = n;
    if (n > 0.5 && (this.moanIn -= dt) <= 0) {
      m.play('moan', 'night-moan');
      this.moanIn = MOANS[0] + Math.random() * (MOANS[1] - MOANS[0]);
    }
  }

  /** Each trash can fire crackles while Cody's within earshot, roaring up as it's fed. */
  private updateFires(npcs: readonly Npc[]): void {
    const N = A.nearby;
    for (const n of npcs) {
      if (!n.fire) continue;
      const at = n.fire.root.position;
      const d = at.distanceTo(this.mixer.ear);
      const was = this.fires.get(n) ?? null;
      const loop = keep(was, d < (was ? N.leave : N.reach), () => this.mixer.loop('fire', 'fire-crackle', at, 1, `${n.def.id}'s`));
      if (loop) this.fires.set(n, loop);
      else this.fires.delete(n);
      loop?.set({ roar: n.plume });
    }
  }

  /** A gate's arm motor whirrs while the arm's on the move, near enough to hear. */
  private updateArms(dt: number, gates: readonly GateRuntime[]): void {
    for (const g of gates) {
      let a = this.arms.get(g);
      if (!a) this.arms.set(g, (a = { open: g.open, loop: null }));
      const speed = Math.abs(g.open - a.open) / Math.max(dt, 1e-3);
      a.open = g.open;
      const near = g.center.distanceTo(this.mixer.ear) < A.nearby.reach;
      a.loop = keep(a.loop, near && speed > (a.loop ? ARM.still : ARM.moving), () => this.mixer.loop('gate', 'gate-motor', g.center, 1, `${g.def.kind} gate`));
      a.loop?.set({ speed: clamp(speed / 2, 0, 1) });
    }
  }
}

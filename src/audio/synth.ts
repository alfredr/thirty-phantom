import {
  fire,
  town,
  night,
  type FireP,
  type TownP,
  type NightP,
} from './synth/ambience';
import {
  foley,
  whoosh,
  wail,
  chime,
  ring,
  buzz,
  morph,
  stinger,
  type FoleyP,
  type WhooshP,
  type WailP,
  type ChimeP,
  type RingP,
  type BuzzP,
  type MorphP,
  type StingerP,
} from './synth/effects';
import {
  horn,
  motor,
  spark,
  crank,
  type HornP,
  type MotorP,
  type SparkP,
  type CrankP,
} from './synth/machines';
import type { Kit, Voice } from './synth/nodes';

interface Params {
  spark: SparkP;
  crank: CrankP;
  horn: HornP;
  foley: FoleyP;
  whoosh: WhooshP;
  wail: WailP;
  chime: ChimeP;
  ring: RingP;
  buzz: BuzzP;
  fire: FireP;
  motor: MotorP;
  morph: MorphP;
  stinger: StingerP;
  town: TownP;
  night: NightP;
}

type Recipe<P> = (k: Kit, out: AudioNode, t: number, p: P) => Voice;

const RECIPES: { [R in keyof Params]: Recipe<Params[R]> } = {
  spark,
  crank,
  horn,
  foley,
  whoosh,
  wail,
  chime,
  ring,
  buzz,
  fire,
  motor,
  morph,
  stinger,
  town,
  night,
};

export type RecipeName = keyof Params;
/**
 * Synthesis recipe and parameters, with an optional gain multiplier for the
 * mixer.
 */
export type Synth = {
  [R in RecipeName]: { synth: R; p: Params[R]; vol?: number };
}[RecipeName];

/**
 * Start the selected synthesis recipe at audio context time `t`, connected to
 * `out`.
 */
export function synthesize<R extends RecipeName>(
  k: Kit,
  out: AudioNode,
  t: number,
  s: { synth: R; p: Params[R] },
): Voice {
  return RECIPES[s.synth](k, out, t, s.p);
}

/**
 * Shared audio context, noise buffer, and distortion curves used by synthesis
 * recipes.
 */
export interface Kit {
  readonly ctx: BaseAudioContext;
  /**
   * Six seconds of white noise, long enough to reduce audible repetition in
   * continuous sounds.
   */
  readonly noise: AudioBuffer;
  /**
   * Waveshaper curves: gentle saturation, and a harder one for grit and
   * crunch.
   */
  readonly soft: Float32Array<ArrayBuffer>;
  readonly hard: Float32Array<ArrayBuffer>;
}

/**
 * Normalized controls for continuous sounds: RPM, engine load, fire intensity,
 * and motor speed.
 */
export interface Controls {
  rpm?: number;
  load?: number;
  miss?: number;
  roar?: number;
  speed?: number;
}

export interface Voice {
  /** Audio context time at which playback ends, or Infinity for a loop. */
  readonly end: number;
  /**
   * Stop all sources at audio context time `at`. The mixer fades loop output
   * before stopping it.
   */
  stop(at: number): void;
  set?(c: Controls, at: number): void;
  /**
   * Schedule upcoming sound events from audio context time `at`. Called each
   * frame for audible loops.
   */
  tick?(at: number): void;
}

export function makeKit(ctx: BaseAudioContext): Kit {
  const noise = ctx.createBuffer(
    1,
    Math.round(ctx.sampleRate * 6),
    ctx.sampleRate,
  );
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    d[i] = Math.random() * 2 - 1;
  }

  return {
    ctx,
    noise,
    soft: curve((x) => Math.tanh(1.5 * x) / Math.tanh(1.5)),
    hard: curve((x) => Math.tanh(4 * x)),
  };
}

function curve(f: (x: number) => number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(1024);
  for (let i = 0; i < c.length; i++) {
    c[i] = f((i / (c.length - 1)) * 2 - 1);
  }

  return c;
}

export const rand = (a: number, b: number): number =>
  a + (b - a) * Math.random();

/** Track a voice's source nodes so they can be stopped together. */
export class Sources {
  private readonly list: AudioScheduledSourceNode[] = [];

  add<T extends AudioScheduledSourceNode>(s: T): T {
    this.list.push(s);
    return s;
  }

  readonly stop = (at: number): void => {
    for (const s of this.list) {
      s.stop(at);
    }
  };
}

/** Start an oscillator at context time `t`, optionally stopping it at `end`. */
export function osc(
  k: Kit,
  s: Sources | null,
  type: OscillatorType,
  f: number,
  t: number,
  end?: number,
): OscillatorNode {
  const o = k.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.start(t);

  if (end !== undefined) {
    o.stop(end);
  }

  return s ? s.add(o) : o;
}

/**
 * Start looping white noise at context time `t` from a random buffer offset.
 * Optionally stop at `end`.
 */
export function noise(
  k: Kit,
  s: Sources | null,
  t: number,
  end?: number,
): AudioBufferSourceNode {
  const n = k.ctx.createBufferSource();
  n.buffer = k.noise;
  n.loop = true;
  n.start(t, Math.random() * k.noise.duration);

  if (end !== undefined) {
    n.stop(end);
  }

  return s ? s.add(n) : n;
}

export function filter(
  k: Kit,
  type: BiquadFilterType,
  f: number,
  q = 0.7,
  gain = 0,
): BiquadFilterNode {
  const b = k.ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  b.gain.value = gain;
  return b;
}

export function amp(k: Kit, v: number): GainNode {
  const g = k.ctx.createGain();
  g.gain.value = v;
  return g;
}

export function shape(k: Kit, c: Float32Array<ArrayBuffer>): WaveShaperNode {
  const w = k.ctx.createWaveShaper();
  w.curve = c;
  return w;
}

/**
 * Create an envelope with a linear attack over `a` seconds and an exponential
 * decay lasting roughly `d` seconds.
 */
export function strike(
  k: Kit,
  t: number,
  peak: number,
  a: number,
  d: number,
): GainNode {
  const g = k.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setTargetAtTime(0, t + a, d / 5);
  return g;
}

/** Connect `nodes` in order. */
export function chain(...nodes: [AudioNode, ...AudioNode[]]): void {
  nodes.reduce((a, b) => {
    a.connect(b);
    return b;
  });
}

/** Modulate an audio parameter with an oscillator scaled by `depth`. */
export function wobble(
  k: Kit,
  lfo: AudioNode,
  depth: number,
  param: AudioParam,
): void {
  lfo.connect(amp(k, depth)).connect(param);
}

/**
 * Compensate for the lower energy of narrow-band noise. `bw` is the filter
 * bandwidth in Hz.
 */
export function loud(k: Kit, bw: number): number {
  return Math.min(
    10,
    Math.sqrt(k.ctx.sampleRate / 2 / Math.max(bw, 20)) * 0.35,
  );
}

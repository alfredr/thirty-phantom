import { Vector3 } from 'three';

import { TUNING } from '@/config';
import { clamp, smoothstep } from '@/engine/core/math';

import { type Bus, type Cue, CUES, type CueName, type SoundOf, type Source } from './cues';
import { soundLog } from './flags';
import { engine, type Mark } from './grains';
import { type Controls, type Kit, makeKit, synthesize, type Voice } from './synth';

/** Cached fetch state. Failed requests are not retried. */
type Fetched<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: T }
  | { readonly state: 'failed' };

const A = TUNING.audio;
/** Loop fade duration and source-following time constant, in seconds. */
const FADE = 0.08;
const FOLLOW = 0.05;

/**
 * Return distance attenuation for a cue with the given range, in meters. Apply inverse-distance falloff and fade to
 * silence over the final 40% of the range.
 */
export function falloff(d: number, range: number): number {
  if (d >= range) {
    return 0;
  }

  return Math.min(1, A.near / Math.max(d, 1e-3)) * (1 - smoothstep(range * 0.6, range, d));
}

export interface PlayOpts {
  /** Sound position. Omit or use null for centered audio without distance attenuation. */
  at?: Vector3 | null;
  /** Gain multiplier applied in addition to the cue and sound levels. */
  gain?: number;
  /** Optional context included in audio logs, such as a vehicle ID. */
  note?: string;
}

/** Handle for a playing loop. The owner updates its position, gain, and synthesis controls, then stops it. */
export interface Loop {
  /** Mutable source position read each frame, or null for audio without spatial effects. */
  readonly at: Vector3 | null;
  /** Gain multiplier applied to the loop each frame. */
  gain: number;
  readonly stopped: boolean;
  set(c: Controls): void;
  stop(): void;
}

interface Live {
  cue: CueName;
  /** `cue: sound`, as logged. */
  name: string;
  voice: Voice;
  out: GainNode;
  pan: StereoPannerNode;
  /** Combined cue, sound, and playback gain before distance attenuation. */
  level: number;
  range: number | null;
  loop: LoopVoice | null;
  note: string | undefined;
}

class LoopVoice implements Loop {
  gain = 1;
  stopped = false;

  constructor(
    readonly at: Vector3 | null,
    private readonly mixer: Mixer,
    readonly live: Live,
  ) {}

  set(c: Controls): void {
    this.mixer.control(this.live, c);
  }

  stop(): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.mixer.release(this.live);
  }
}

/** Format a logged gain to two decimal places. */
const fmt = (v: number): string => v.toFixed(2);

/**
 * Mix synthesized and recorded sounds through effects and ambience buses, a master gain, and a limiter. Apply distance
 * attenuation, camera-relative stereo panning, and voice limits. Call unlock() from a user gesture before playing
 * audio.
 */
export class Mixer {
  private ctx: AudioContext | null = null;
  private kit: Kit | null = null;
  private master: GainNode | null = null;
  private buses: Record<Bus, GainNode> | null = null;
  private readonly live: Live[] = [];
  /** Decoded audio cached by file path. */
  private readonly files = new Map<string, Fetched<AudioBuffer>>();
  /** Engine cycle metadata cached by file path. */
  private readonly marks = new Map<string, Fetched<readonly Mark[]>>();
  /** Listener position and horizontal camera-right vector used for spatial audio. */
  readonly ear = new Vector3();
  readonly right = new Vector3(1, 0, 0);
  private muted = false;

  get ready(): boolean {
    return this.ctx?.state === 'running';
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Create or resume the audio context. Call from a keyboard, pointer, or touch event. */
  unlock(): void {
    if (!this.ctx) {
      if (typeof AudioContext === 'undefined') {
        return;
      }

      this.build();
    }

    if (this.ctx && this.ctx.state !== 'running') {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  /** Suspend the audio context when the page is hidden. Resume it with unlock(). */
  suspend(): void {
    if (this.ctx?.state === 'running') {
      void this.ctx.suspend();
    }
  }

  setMuted(on: boolean): void {
    this.muted = on;
    const ctx = this.ctx;
    if (ctx && this.master) {
      this.master.gain.setTargetAtTime(on ? 0 : A.master, ctx.currentTime, 0.03);
    }
  }

  private build(): void {
    const ctx = new AudioContext();
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -8;
    limit.knee.value = 6;
    limit.ratio.value = 12;
    limit.attack.value = 0.002;
    limit.release.value = 0.2;
    limit.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : A.master;
    master.connect(limit);

    const bus = (v: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(master);
      return g;
    };

    this.ctx = ctx;
    this.kit = makeKit(ctx);
    this.master = master;
    this.buses = { sfx: bus(A.sfx), ambience: bus(A.ambience) };
    soundLog(`audio started (${ctx.sampleRate} Hz)`);
    // Start loading recorded sounds and engine metadata without blocking playback.
    const cues: Readonly<Record<string, Cue>> = CUES;
    for (const cue of Object.values(cues)) {
      for (const src of Object.values(cue.sounds)) {
        if ('file' in src) {
          this.load(src.file);
        }

        if ('marks' in src) {
          this.loadMarks(src.marks);
        }
      }
    }
  }

  /** Play a one-shot cue. Return false if audio is unavailable, muted, inaudible, still loading, or at its voice limit. */
  play<C extends CueName>(cue: C, sound: SoundOf<C>, o: PlayOpts = {}): boolean {
    const def: Cue = CUES[cue];
    const src = def.sounds[sound];
    if (!src || !this.ctx || this.muted || !this.ready) {
      return false;
    }

    const at = o.at ?? null;
    const level = def.vol * (src.vol ?? 1) * (o.gain ?? 1);
    const d = at ? at.distanceTo(this.ear) : 0;
    const heard = level * (at && def.range !== null ? falloff(d, def.range) : 1);
    // Silently discard sounds below the audible threshold.
    if (heard < A.cull) {
      return false;
    }

    const name = `${cue}: ${sound}`;
    let shots = 0;
    let same = 0;
    for (const l of this.live) {
      if (!l.loop) {
        shots++;
      }

      if (l.cue === cue) {
        same++;
      }
    }

    if (shots >= A.voices) {
      return this.drop(name, 'all voices busy');
    }

    if (same >= def.max) {
      return this.drop(name, `${def.max} already playing`);
    }

    const live = this.start(cue, name, def, src, at, level, heard, this.ctx.currentTime + 0.005, false, o.note);
    if (!live) {
      return this.drop(name, 'file still loading');
    }

    this.log(live, src, at ? d : null, heard, null);
    return true;
  }

  /**
   * Start a looping cue, or return null if its source is unavailable or its cue limit is reached. A null position
   * disables spatial effects.
   */
  loop<C extends CueName>(cue: C, sound: SoundOf<C>, at: Vector3 | null, gain = 1, note?: string): Loop | null {
    const def: Cue = CUES[cue];
    const src = def.sounds[sound];
    if (!src || !this.ctx) {
      return null;
    }

    let same = 0;
    for (const l of this.live) {
      if (l.cue === cue) {
        same++;
      }
    }

    if (same >= def.max) {
      return null;
    }

    const level = def.vol * (src.vol ?? 1);
    const d = at ? at.distanceTo(this.ear) : 0;
    const heard = level * gain * (at && def.range !== null ? falloff(d, def.range) : 1);
    const live = this.start(cue, `${cue}: ${sound}`, def, src, at, level, 0, this.ctx.currentTime, true, note);
    if (!live) {
      return null;
    }

    const handle = new LoopVoice(at, this, live);
    handle.gain = gain;
    live.loop = handle;
    live.out.gain.setTargetAtTime(heard, this.ctx.currentTime, FADE / 3);
    this.log(live, src, at ? d : null, heard, 'loop start');
    return handle;
  }

  /** Update loop gain and panning, schedule audible loop voices, and disconnect completed one-shots. */
  update(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    const now = ctx.currentTime;
    let n = 0;
    for (const l of this.live) {
      if (l.loop) {
        const heard = this.heard(l) * l.loop.gain;
        l.out.gain.setTargetAtTime(heard, now, FOLLOW);

        if (l.loop.at) {
          l.pan.pan.setTargetAtTime(this.panFor(l.loop.at), now, FOLLOW);
        }

        if (heard > 1e-3) {
          l.voice.tick?.(now);
        }
      } else if (l.voice.end + 0.1 < now) {
        l.out.disconnect();
        continue;
      }

      this.live[n++] = l;
    }

    this.live.length = n;
  }

  /** Send synthesis controls to a voice at the current audio context time. */
  control(l: Live, c: Controls): void {
    if (this.ctx) {
      l.voice.set?.(c, this.ctx.currentTime);
    }
  }

  /** Remove a loop from the active set, fade it out, then stop and disconnect its sources. */
  release(l: Live): void {
    const i = this.live.indexOf(l);
    if (i >= 0) {
      this.live.splice(i, 1);
    }

    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    const now = ctx.currentTime;
    l.out.gain.cancelScheduledValues(now);
    l.out.gain.setValueAtTime(l.out.gain.value, now);
    l.out.gain.linearRampToValueAtTime(0, now + FADE);
    l.voice.stop(now + FADE + 0.02);
    window.setTimeout(() => l.out.disconnect(), (FADE + 0.1) * 1000);
    soundLog(`${l.name} loop stop${l.note ? `, ${l.note}` : ''}`);
  }

  private start(
    cue: CueName,
    name: string,
    def: Cue,
    src: Source,
    at: Vector3 | null,
    level: number,
    heard: number,
    t: number,
    loop: boolean,
    note: string | undefined,
  ): Live | null {
    const ctx = this.ctx;
    const kit = this.kit;
    const buses = this.buses;
    if (!ctx || !kit || !buses) {
      return null;
    }

    const out = ctx.createGain();
    out.gain.value = heard;
    const pan = ctx.createStereoPanner();
    pan.pan.value = at ? this.panFor(at) : 0;
    let voice: Voice;
    if ('synth' in src) {
      voice = synthesize(kit, out, t, src);
    } else {
      const file = this.files.get(src.file);
      if (file?.state !== 'ready') {
        this.load(src.file);
        return null;
      }

      const buf = file.value;
      if ('engine' in src) {
        const marks = this.marks.get(src.marks);
        if (marks?.state !== 'ready') {
          this.loadMarks(src.marks);
          return null;
        }

        return this.keep(cue, name, def, engine(kit, out, t, buf, marks.value, src.engine), out, pan, level, note);
      }

      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = loop;
      // Vary playback rate to make repeated recordings less uniform.
      const rate = 1 + (Math.random() * 2 - 1) * ('vary' in src ? (src.vary ?? 0) : 0);
      s.playbackRate.value = rate;
      s.connect(out);
      s.start(t);
      voice = { end: loop ? Infinity : t + buf.duration / rate, stop: (when) => s.stop(when) };
    }

    return this.keep(cue, name, def, voice, out, pan, level, note);
  }

  /** Connect a voice to its stereo panner and output bus, then register it for updates. */
  private keep(
    cue: CueName,
    name: string,
    def: Cue,
    voice: Voice,
    out: GainNode,
    pan: StereoPannerNode,
    level: number,
    note: string | undefined,
  ): Live {
    const buses = this.buses;
    if (buses) {
      out.connect(pan).connect(buses[def.bus]);
    }

    const live: Live = { cue, name, voice, out, pan, level, range: def.range, loop: null, note };
    this.live.push(live);
    return live;
  }

  /** Calculate a loop's distance-adjusted level before applying its mutable gain. */
  private heard(l: Live): number {
    const at = l.loop?.at;
    if (!at || l.range === null) {
      return l.level;
    }

    return l.level * falloff(at.distanceTo(this.ear), l.range);
  }

  /** Calculate camera-relative stereo pan, reducing separation near the listener. */
  private panFor(at: Vector3): number {
    const dx = at.x - this.ear.x;
    const dz = at.z - this.ear.z;
    const h = Math.hypot(dx, dz);
    if (h < 1e-3) {
      return 0;
    }

    return clamp((dx * this.right.x + dz * this.right.z) / h, -1, 1) * A.pan * smoothstep(0, A.near, h);
  }

  /** Fetch and decode an audio file once. Cache the result or the failure. */
  private load(path: string): void {
    const ctx = this.ctx;
    if (!ctx || this.files.has(path)) {
      return;
    }

    const url = `${import.meta.env.BASE_URL}audio/${path}`;
    this.files.set(path, { state: 'loading' });
    void fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => ctx.decodeAudioData(data))
      .then((value) => void this.files.set(path, { state: 'ready', value }))
      .catch((err: unknown) => {
        this.files.set(path, { state: 'failed' });
        console.warn(`[sound] ${url} failed to load`, err);
      });
  }

  /** Fetch engine cycle metadata once. Cache the result or the failure. */
  private loadMarks(path: string): void {
    if (this.marks.has(path)) {
      return;
    }

    const url = `${import.meta.env.BASE_URL}audio/${path}`;
    this.marks.set(path, { state: 'loading' });
    void fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: unknown) => {
        if (
          typeof data !== 'object' ||
          data === null ||
          !('marks' in data) ||
          !Array.isArray(data.marks) ||
          !data.marks.every(
            (mark: unknown): mark is Mark => Array.isArray(mark) && mark.length === 4 && mark.every(Number.isFinite),
          )
        ) {
          throw new Error('Invalid engine cycle metadata');
        }

        this.marks.set(path, { state: 'ready', value: data.marks });
      })
      .catch((err: unknown) => {
        this.marks.set(path, { state: 'failed' });
        console.warn(`[sound] ${url} failed to load`, err);
      });
  }

  private drop(name: string, why: string): false {
    soundLog(`dropped ${name} (${why})`, 'debug');
    return false;
  }

  private log(l: Live, src: Source, d: number | null, heard: number, what: string | null): void {
    const parts = [what, d !== null ? `${Math.round(d)} m` : null, `vol ${fmt(heard)}`, l.note].filter((p) => p);
    soundLog(`${l.name} (${'synth' in src ? 'synth' : 'file'}) ${parts.join(', ')}`);
  }
}

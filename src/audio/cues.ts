import type { EngineP } from './grains';
import type { Synth } from './synth';

/** The two mixes: effects, and the ambience bed under them (TUNING.audio sets each one's level). */
export type Bus = 'sfx' | 'ambience';

/**
 * A sound: one of synth.ts's recipes with its params, or a file under public/audio/ (lazy-loaded,
 * mp3 or m4a for iOS; CC0 only, each credited in public/audio/CREDITS.md). Synthesis first; a
 * file stands in where it doesn't do well (the screams, the engines).
 * `vol` trims one sound against the rest of its cue; a file's `vary` plays it up to that much
 * faster or slower each time (0.06: within 6%), so a recording isn't the same every time. An
 * `engine` is a recording cut into tagged cycles (`marks`, from tools/engine-grains.py), played
 * by its revs and load (grains.ts).
 */
export type Source = Synth | { file: string; vol?: number; vary?: number } | { file: string; marks: string; engine: EngineP; vol?: number };

export interface Cue {
  bus: Bus;
  /** Level at the source, before distance (0..1). */
  vol: number;
  /** Heard out to this far (m), falling off from TUNING.audio.near; null: everywhere at full level (Cody's own, the phone, ambience). */
  range: number | null;
  /** At most this many playing at once. */
  max: number;
  /** Runs till it's stopped (engines, the fire, ambience). */
  loop?: true;
  /** Its sounds, by name. The console logs each one by `cue: name` as it starts. */
  sounds: Readonly<Record<string, Source>>;
}

/**
 * The cue table: every sound in the game, by cue (what happened) and name (which sound). The
 * console shows `[sound] cue: name` as each one starts, so a weird one can be looked up here and
 * retuned, or swapped for a file. src/audio/sound.ts says what triggers each cue.
 */
export const CUES = {
  /** Traffic held up, leaning on the horn ('honk'): by kind of car, and angrier for longer and harsher. */
  honk: {
    bus: 'sfx',
    vol: 0.5,
    range: 90,
    max: 3,
    sounds: {
      'horn-sedan': { synth: 'horn', p: { f: [415, 523], dur: 0.42, wave: 'sawtooth', tone: 2200 } },
      'horn-sedan-angry': { synth: 'horn', p: { f: [415, 523], dur: 1.1, wave: 'sawtooth', tone: 2400, drive: 2.5 } },
      'horn-pickup': { synth: 'horn', p: { f: [330, 415], dur: 0.55, wave: 'sawtooth', tone: 1700 } },
      'horn-pickup-angry': { synth: 'horn', p: { f: [330, 415], dur: 1.3, wave: 'sawtooth', tone: 1900, drive: 2.5 } },
      'horn-bike': { synth: 'horn', p: { f: [622], dur: 0.12, beeps: 2, gap: 0.07, wave: 'square', tone: 2600 }, vol: 0.5 },
      'horn-bike-angry': { synth: 'horn', p: { f: [622], dur: 0.12, beeps: 5, gap: 0.05, wave: 'square', tone: 2800, drive: 2 }, vol: 0.7 },
    },
  },
  /** Engines running: Cody's ride, and the nearest traffic. CC0 recordings cut into cycles and played by the engine's revs and load (grains.ts, engine-state.ts). */
  engine: {
    bus: 'sfx',
    vol: 0.9,
    range: 45,
    max: 4,
    loop: true,
    sounds: {
      'engine-sedan': {
        file: 'engine-sedan.mp3',
        marks: 'engine-sedan.json',
        engine: { idle: 106, top: 400, rate: 45, tone: [2500, 9000], gain: 1, breath: { band: [500, 2400], vol: 0.12 }, burble: { rate: 10, fade: 1.5, vol: 0.25 } },
      },
      'engine-pickup': {
        file: 'engine-pickup.mp3',
        marks: 'engine-pickup.json',
        engine: { idle: 43.4, top: 138, rate: 45, tone: [1800, 7000], gain: 1.7, breath: { band: [400, 1800], vol: 0.12 }, burble: { rate: 6, fade: 1.2, vol: 0.2 } },
      },
      'engine-bike': {
        file: 'engine-bike.mp3',
        marks: 'engine-bike.json',
        engine: { idle: 45, top: 175, rate: 50, tone: [3000, 10000], gain: 1.6, breath: { band: [700, 3200], vol: 0.15 }, burble: { rate: 12, fade: 1.2, vol: 0.2 } },
      },
      'engine-truck': {
        file: 'engine-truck.mp3',
        marks: 'engine-truck.json',
        engine: { idle: 34, top: 85, rate: 45, tone: [1500, 6000], gain: 1.1, lope: 0.45, cyl: 8, breath: { band: [300, 1400], vol: 0.14 }, burble: { rate: 8, fade: 1.8, vol: 0.35 } },
      },
    },
  },
  /** The monster truck burning GhASt ('boosted', held): a roar over its engine. */
  boost: {
    bus: 'sfx',
    vol: 0.75,
    range: 60,
    max: 1,
    loop: true,
    sounds: { 'boost-roar': { synth: 'fire', p: { rate: [70, 70], body: [1600, 1600], vol: 0.6 } } },
  },
  /** The GhASt burn lighting up ('boosted'). */
  ignite: {
    bus: 'sfx',
    vol: 0.7,
    range: 60,
    max: 1,
    sounds: { 'boost-ignite': { synth: 'whoosh', p: { f: [200, 1400, 600], q: 0.9, len: 0.7, peak: 0.25, vol: 1, boom: 60 } } },
  },
  /** A knock between cars, or into a wall ('impact', soft). */
  bump: {
    bus: 'sfx',
    vol: 0.6,
    range: 50,
    max: 3,
    sounds: {
      'bump-car': { synth: 'foley', p: { thump: { from: 110, to: 55, len: 0.12, vol: 0.9 }, body: { f: 700, len: 0.12, vol: 0.5 }, crunch: { f: 1400, q: 1, len: 0.05, vol: 0.2 } } },
      'bump-wall': { synth: 'foley', p: { thump: { from: 100, to: 50, len: 0.13, vol: 1 }, body: { f: 500, len: 0.15, vol: 0.6 }, rattle: { n: 2, f: 1100, len: 0.1, vol: 0.2 } } },
    },
  },
  /** A crash: car into car, or into a wall ('impact', hard). The harder, the darker and lower. */
  crash: {
    bus: 'sfx',
    vol: 0.73,
    range: 80,
    max: 4,
    sounds: {
      'crash-car': {
        synth: 'foley',
        p: {
          thump: { from: 90, to: 45, len: 0.15, vol: 1 },
          body: { f: 1200, len: 0.35, vol: 0.8 },
          crunch: { f: 2200, q: 0.8, len: 0.25, vol: 0.9 },
          rattle: { n: 6, f: 1400, len: 0.5, vol: 0.3, at: 0.08 },
        },
      },
      'crash-wall': {
        synth: 'foley',
        p: {
          thump: { from: 80, to: 40, len: 0.15, vol: 1 },
          body: { f: 900, len: 0.4, vol: 0.9 },
          crunch: { f: 1600, q: 0.8, len: 0.25, vol: 0.8 },
          rattle: { n: 6, f: 1100, len: 0.5, vol: 0.3, at: 0.05 },
        },
      },
      'crash-hard': {
        synth: 'foley',
        p: {
          thump: { from: 65, to: 32, len: 0.15, vol: 1 },
          body: { f: 700, len: 0.6, vol: 1 },
          crunch: { f: 1500, q: 0.7, len: 0.45, vol: 1 },
          glass: { n: 10, len: 0.35, vol: 0.35, at: 0.03 },
          rattle: { n: 10, f: 1000, len: 0.8, vol: 0.3, at: 0.12 },
        },
      },
    },
  },
  /** Coming down from the air ('impact' on the ground). */
  land: {
    bus: 'sfx',
    vol: 0.65,
    range: 60,
    max: 2,
    sounds: {
      'land-car': { synth: 'foley', p: { thump: { from: 85, to: 42, len: 0.14, vol: 1 }, body: { f: 450, len: 0.2, vol: 0.7 }, rattle: { n: 3, f: 900, len: 0.2, vol: 0.25 } } },
      'land-truck': { synth: 'foley', p: { thump: { from: 60, to: 30, len: 0.15, vol: 1 }, body: { f: 300, len: 0.35, vol: 1 }, crunch: { f: 600, q: 1, len: 0.2, vol: 0.5 } } },
    },
  },
  /** The monster truck flattening a car ('crushed'). */
  crush: {
    bus: 'sfx',
    vol: 0.76,
    range: 80,
    max: 2,
    sounds: {
      'crush-car': {
        synth: 'foley',
        p: {
          thump: { from: 60, to: 30, len: 0.15, vol: 1 },
          body: { f: 600, len: 0.6, vol: 1 },
          crunch: { f: 1300, q: 0.7, len: 0.6, vol: 1 },
          glass: { n: 12, len: 0.45, vol: 0.35, at: 0.05 },
        },
      },
    },
  },
  /** The truck breaking through a parapet ('smashed'). */
  smash: {
    bus: 'sfx',
    vol: 0.76,
    range: 90,
    max: 2,
    sounds: {
      'smash-parapet': {
        synth: 'foley',
        p: {
          thump: { from: 55, to: 28, len: 0.15, vol: 1 },
          body: { f: 500, len: 0.7, vol: 1 },
          crunch: { f: 900, q: 0.7, len: 0.5, vol: 0.9 },
          rattle: { n: 14, f: 800, len: 1, vol: 0.4, at: 0.1 },
        },
      },
    },
  },
  /** Street furniture going over, smashed, or a lamp landing ('prop'), by its kind: metal clanks and crunches, wood knocks, leaves. */
  prop: {
    bus: 'sfx',
    vol: 1,
    range: 60,
    max: 6,
    sounds: {
      'prop-lamp': { synth: 'foley', p: { thump: { from: 110, to: 55, len: 0.08, vol: 0.78 }, crunch: { f: 2600, q: 1.1, len: 0.1, vol: 0.91 }, body: { f: 1500, len: 0.12, vol: 0.52 } } },
      'prop-lamp-down': {
        synth: 'foley',
        p: {
          thump: { from: 90, to: 45, len: 0.12, vol: 0.8 },
          body: { f: 800, len: 0.25, vol: 0.6 },
          crunch: { f: 2200, q: 1, len: 0.15, vol: 0.5 },
          glass: { n: 10, len: 0.3, vol: 0.5 },
        },
        vol: 0.77,
      },
      'prop-fence': { synth: 'foley', p: { crunch: { f: 2400, q: 1, len: 0.1, vol: 0.8 }, rattle: { n: 8, f: 1700, len: 0.35, vol: 0.8 }, thump: { from: 110, to: 55, len: 0.08, vol: 0.64 } } },
      'prop-guardrail': { synth: 'foley', p: { thump: { from: 100, to: 50, len: 0.12, vol: 0.8 }, body: { f: 1000, len: 0.25, vol: 0.6 }, crunch: { f: 1900, q: 0.9, len: 0.18, vol: 0.6 } }, vol: 0.81 },
      'prop-railing': { synth: 'foley', p: { crunch: { f: 2100, q: 1, len: 0.12, vol: 0.79 }, rattle: { n: 6, f: 1500, len: 0.35, vol: 0.71 }, thump: { from: 110, to: 55, len: 0.08, vol: 0.63 } } },
      'prop-gate-arm': {
        synth: 'foley',
        p: {
          snap: { f: 2000, q: 1.5, len: 0.03, vol: 1.32 },
          crunch: { f: 2400, q: 1.2, len: 0.05, vol: 0.79 },
          thump: { from: 110, to: 55, len: 0.06, vol: 0.66 },
          rattle: { n: 3, f: 1300, len: 0.3, vol: 0.66 },
        },
      },
      'prop-bench': { synth: 'foley', p: { snap: { f: 1100, q: 1.6, len: 0.04, vol: 1 }, thump: { from: 110, to: 55, len: 0.1, vol: 0.8 }, rattle: { n: 4, f: 900, len: 0.3, vol: 0.45 } }, vol: 0.83 },
      'prop-tree': {
        synth: 'foley',
        p: {
          snap: { f: 1500, q: 1.3, len: 0.05, vol: 1 },
          crunch: { f: 800, q: 1.2, len: 0.2, vol: 0.6 },
          rattle: { n: 10, f: 900, len: 0.6, vol: 0.45 },
          rustle: { f: 2200, len: 1.2, vol: 0.6, at: 0.35 },
          thump: { from: 65, to: 32, len: 0.15, vol: 1, at: 0.5 },
          body: { f: 400, len: 0.4, vol: 0.8, at: 0.5 },
        },
        vol: 0.65,
      },
      'prop-hedge': {
        synth: 'foley',
        p: {
          rustle: { f: 1800, len: 0.8, vol: 1.13 },
          rattle: { n: 12, f: 1200, len: 0.5, vol: 0.57 },
          snap: { f: 1300, q: 1.4, len: 0.03, vol: 0.6 },
          thump: { from: 100, to: 50, len: 0.1, vol: 0.5 },
        },
        vol: 0.66,
      },
      'prop-shelter': {
        synth: 'foley',
        p: {
          glass: { n: 24, len: 0.7, vol: 1.1 },
          crunch: { f: 3200, q: 0.8, len: 0.25, vol: 0.6 },
          body: { f: 1500, len: 0.25, vol: 0.5 },
          thump: { from: 100, to: 50, len: 0.12, vol: 0.7 },
        },
      },
    },
  },
  /** Randy's trash can fire, crackling where it stands; it roars up when fed. */
  fire: {
    bus: 'sfx',
    vol: 0.5,
    range: 30,
    max: 2,
    loop: true,
    sounds: { 'fire-crackle': { synth: 'fire', p: { rate: [9, 40], body: [450, 1600], vol: 1, lap: 0.13, hiss: 0.25, wander: 1, clusters: 0.1, shifts: 0.025 } } },
  },
  /** A tire going into Randy's fire, which plumes up ('stoked'). */
  stoke: {
    bus: 'sfx',
    vol: 0.52,
    range: 40,
    max: 2,
    sounds: { 'fire-whoomph': { synth: 'whoosh', p: { f: [150, 900, 300], q: 0.8, len: 1.1, peak: 0.2, vol: 1, boom: 55 } } },
  },
  /** Ghosts sucked into the monster truck's intake ('swallowed'). */
  swallow: {
    bus: 'sfx',
    vol: 0.48,
    range: null,
    max: 2,
    sounds: { 'ghast-slurp': { synth: 'wail', p: { from: 900, to: 220, len: 0.7, vibrato: 0.03, voices: 2, cents: 25, wave: 'sine', air: 0.6, vol: 1, rise: 0.15 } } },
  },
  /** Someone vanishing in a puff of smoke ('puff': Randy at 7pm). */
  puff: {
    bus: 'sfx',
    vol: 0.6,
    range: 50,
    max: 2,
    sounds: { 'puff-smoke': { synth: 'whoosh', p: { f: [500, 1200, 250], q: 0.7, len: 0.6, peak: 0.12, vol: 1, boom: 90 } } },
  },
  /** Cody picking up money ('money'). */
  money: {
    bus: 'sfx',
    vol: 0.36,
    range: null,
    max: 3,
    sounds: {
      'coin-cash': { synth: 'chime', p: { notes: [1319, 1760], step: 0.07, decay: 0.25, wave: 'triangle', bell: 2.76, vol: 1 } },
      'coin-wallet': { synth: 'chime', p: { notes: [1047, 1319, 1568, 2093], step: 0.06, decay: 0.3, wave: 'triangle', bell: 2.76, vol: 1 } },
      'coin-glovebox': { synth: 'chime', p: { notes: [1568, 2093], step: 0.09, decay: 0.3, wave: 'triangle', bell: 2.76, vol: 1 } },
    },
  },
  /** Cody picking up a car part, a tire, or something handed or sold to him ('item', got). */
  item: {
    bus: 'sfx',
    vol: 0.4,
    range: null,
    max: 3,
    sounds: {
      'item-part': { synth: 'chime', p: { notes: [523, 784], step: 0.06, decay: 0.12, wave: 'square', vol: 0.72 } },
      'item-tire': { synth: 'foley', p: { thump: { from: 180, to: 90, len: 0.15, vol: 1.1 }, rattle: { n: 2, f: 600, len: 0.12, vol: 0.44, q: 4 } } },
      'item-gift': { synth: 'chime', p: { notes: [784, 988, 1175, 1568], step: 0.07, decay: 0.35, wave: 'triangle', bell: 2, vol: 0.9 }, vol: 0.84 },
    },
  },
  /** Randy calling on the burner ('phone' ring, till the call's over). */
  call: {
    bus: 'sfx',
    vol: 0.24,
    range: null,
    max: 1,
    loop: true,
    sounds: { 'phone-ring': { synth: 'ring', p: { f: [1320, 1660], trill: 20, pattern: [0.4, 0.2, 0.4, 2], vol: 1 } } },
  },
  /** A text from Randy landing on the burner ('phone' text). */
  text: {
    bus: 'sfx',
    vol: 0.36,
    range: null,
    max: 2,
    sounds: { 'phone-text': { synth: 'buzz', p: { f: 170, pulses: 2, len: 0.14, gap: 0.1, ding: [1760, 2637], step: 0.1, vol: 1 } } },
  },
  /** Moonrise at 7pm ('nightfall'): a gong and an eerie chord. */
  moonrise: {
    bus: 'sfx',
    vol: 0.45,
    range: null,
    max: 1,
    sounds: { 'stinger-moonrise': { synth: 'stinger', p: { gong: 82, chord: [146.8, 174.6, 220, 277.2], swell: 1.2, len: 5, vol: 1 } } },
  },
  /** Sunrise ('sunrise'): a brighter, softer chord. */
  dawn: {
    bus: 'sfx',
    vol: 0.33,
    range: null,
    max: 1,
    sounds: { 'stinger-dawn': { synth: 'stinger', p: { gong: 196, chord: [261.6, 329.6, 392, 523.3], swell: 0.8, len: 3.5, vol: 1 } } },
  },
  /** Cody's outfit swap in a puff ('outfit'): into phantom Cody, or back. */
  outfit: {
    bus: 'sfx',
    vol: 0.5,
    range: 40,
    max: 1,
    sounds: {
      'outfit-phantom': { synth: 'wail', p: { from: 400, to: 620, len: 1, vibrato: 0.025, voices: 3, cents: 20, wave: 'triangle', air: 0.8, vol: 1, rise: 0.5 } },
      'outfit-day': { synth: 'chime', p: { notes: [1568, 1976, 2349, 3136], step: 0.05, decay: 0.4, wave: 'sine', bell: 2, vol: 0.7 }, vol: 0.87 },
    },
  },
  /** A car turning into the monster truck ('entered', possessed), or one turning back at sunrise. */
  morph: {
    bus: 'sfx',
    vol: 0.51,
    range: 70,
    max: 2,
    sounds: {
      'morph-truck': { synth: 'morph', p: { shudder: 0.55, from: 45, to: 110, blorp: [420, 70], vol: 1 } },
      'morph-car': { synth: 'morph', p: { shudder: 0.55, from: 110, to: 50, blorp: [160, 420], vol: 0.8 } },
    },
  },
  /** A truck got out unseen and left its phantom imprint ('phantom'). */
  phantom: {
    bus: 'sfx',
    vol: 0.72,
    range: null,
    max: 1,
    sounds: { 'phantom-imprint': { synth: 'wail', p: { from: 330, to: 494, len: 1.6, vibrato: 0.02, voices: 3, cents: 18, wave: 'triangle', air: 0.5, vol: 1, rise: 0.3 } } },
  },
  /** Someone on foot taking fright and running ('fright'): CC0 recordings, public/audio/CREDITS.md. */
  scream: {
    bus: 'sfx',
    vol: 0.62,
    range: 45,
    max: 3,
    sounds: {
      'scream-high': { file: 'scream-high.mp3', vary: 0.06, vol: 0.7 },
      'scream-mid': { file: 'scream-mid.mp3', vary: 0.06, vol: 0.8 },
      'scream-low': { file: 'scream-low.mp3', vary: 0.06 },
    },
  },
  /** A badge gate's arm going up or down. */
  gate: {
    bus: 'sfx',
    vol: 0.4,
    range: 35,
    max: 2,
    loop: true,
    sounds: { 'gate-motor': { synth: 'motor', p: { f: [70, 140], tone: 500, vol: 1 } } },
  },
  /** The badge scanner: a scan logged in or out, or a car sneaking in unbadged ('crossing'). */
  badge: {
    bus: 'sfx',
    vol: 0.75,
    range: 40,
    max: 2,
    sounds: {
      'badge-beep': { synth: 'chime', p: { notes: [1568, 2093], step: 0.09, decay: 0.09, wave: 'square', vol: 0.5 } },
      'badge-buzz': { synth: 'chime', p: { notes: [196, 196], step: 0.18, decay: 0.16, wave: 'sawtooth', vol: 0.87 } },
    },
  },
  /** The bed under it all: the town by day, wind and crickets by night, crossfaded at dusk and dawn. */
  ambience: {
    bus: 'ambience',
    vol: 0.5,
    range: null,
    max: 2,
    loop: true,
    sounds: {
      'day-town': { synth: 'town', p: { hum: 300, vol: 0.6, birds: 0.25, every: [3, 9] } },
      'night-wind': { synth: 'night', p: { wind: 420, vol: 0.65, crickets: 0.065, chirp: [4300, 4750] } },
    },
  },
  /** Now and then at night, a moan from somewhere in the dark. */
  moan: {
    bus: 'ambience',
    vol: 0.3,
    range: null,
    max: 1,
    sounds: { 'night-moan': { synth: 'wail', p: { from: 210, to: 150, len: 2.8, vibrato: 0.02, voices: 2, cents: 14, wave: 'triangle', air: 0.4, vol: 1, rise: 0.4 } } },
  },
} satisfies Record<string, Cue>;

export type CueName = keyof typeof CUES;
/** The names of a cue's sounds. */
export type SoundOf<C extends CueName> = keyof (typeof CUES)[C]['sounds'] & string;

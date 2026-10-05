import type { Vector3 } from 'three';

import type { Npc } from '@/actors/npcs/npcs';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import type { MindEvent } from '@/engine/sim/mind';
import type { Crossing, SpotRuntime } from '@/game/deck/garage';
import type { Game } from '@/game/game';
import type { DialogueLine } from '@/ui/dialogue';
import type { Signpost } from '@/ui/signpost';
import type { LevelData } from '@/world/level-data';

import { type Beats, type Part, steps } from './director';
import type { Objective } from './objectives';
import { rampRun } from './ramp-run';
import type { RoofScene } from './roof-scene';
import { type Access, barriers, dayLook, doors, entry, keepEscapes, noTrades, stall } from './story-access';
import type { StoryCamera } from './story-camera';
import { free, hold, pause, pauseWhen, type StoryClock, sweep } from './story-clock';
import { ghostSupply, ghostTrail, nearestGhost } from './story-ghosts';
import { type Goals, goal, mark, pins } from './story-goals';
import { call, nudge, type Outreach, say, text } from './story-outreach';
import { type Recovery, region } from './story-recovery';
import {
  type Chapter,
  coughing,
  faceCody,
  facing,
  getIn,
  handPhone,
  type Imprint,
  imprintSign,
  nearestCar,
  perform,
  ledgerOnJump,
  meltedKeys,
  moltenKeys,
  roofScene,
  type Scenes,
  seatAtFire,
  settled,
  skipPhone,
  type Stage,
  tailpipe,
  talkToRandy,
  watchViews,
} from './tutorial-scenes';

export interface Cast {
  readonly game: Game;
  readonly level: LevelData;
  readonly clock: StoryClock;
  readonly goals: Goals;
  readonly outreach: Outreach;
  readonly access: Access;
  readonly recovery: Recovery;
  readonly scenes: Scenes;
  readonly camera: StoryCamera;
  readonly sign: Signpost;
  readonly chapter: Chapter;
  readonly gas: RoofScene;
  readonly pickup: Vehicle;
  readonly randy: Npc;
  readonly stage: Stage;
  readonly touch: boolean;
  startErrand(): void;
  remember(part: 1 | 2): void;
  bam(): void;
  wake(): void;
}

export type TutorialEvent =
  | MindEvent<'entered', { v: Vehicle; possessed: boolean }>
  | MindEvent<'exited', { spot: SpotRuntime | null }>
  | MindEvent<'crossing', { crossing: Crossing }>
  | MindEvent<'swallowed'>
  | MindEvent<'boosted'>
  | MindEvent<'summoned'>
  | MindEvent<'spooked'>
  | MindEvent<'phantom', { imprint: Imprint }>
  | MindEvent<'hotwired', { v: Vehicle }>
  | MindEvent<'nightfall'>
  | MindEvent<'sunrise'>
  | MindEvent<'talk', { tires: number }>
  | MindEvent<'signed'>;

export type BeatId =
  | 'roof'
  | 'badge'
  | 'handBadge'
  | 'toss'
  | 'keys'
  | 'phone'
  | 'gas'
  | 'pour'
  | 'allGood'
  | 'basteLine'
  | 'flare'
  | 'uhOh'
  | 'discovery'
  | 'wonder'
  | 'keysCall'
  | 'hotwire'
  | 'sorry'
  | 'weird'
  | 'ramp'
  | 'landing'
  | 'tell'
  | 'imprint'
  | 'yours'
  | 'camera'
  | 'ghost'
  | 'boost'
  | 'soul'
  | 'basementCall'
  | 'tires'
  | 'grab'
  | 'noWheels'
  | 'bring'
  | 'sitDown'
  | 'moonlight'
  | 'rules'
  | 'spook'
  | 'raise'
  | 'possess'
  | 'escape'
  | 'rest'
  | 'morning'
  | 'gate'
  | 'park'
  | 'tonight'
  | 'night2'
  | 'racket';

export type ErrandId = 'cooled' | 'handed';

type P = Part<Cast, TutorialEvent, BeatId>;

const { act, on, react, progressOn, when, after, all } = steps<Cast, TutorialEvent, BeatId>();
const errand = steps<Cast, TutorialEvent, ErrandId>();

export const GHAST = '<span class="ghast-word">G<small>h</small>AS<small>t</small></span>';
const LOCKED = "THE DOORS WON'T OPEN. THE TRUCK LIKES YOU.";
const GET_IN = 'WALK UP TO THE DRIVER DOOR. {interact} GET IN.';
const SMOKE = 'smoke';
const MOLTEN = 'molten';
const PIN_RANGE = 150;
const TIRE_PIN = '#ffb84a';
const MAP_LESSON = '{phone} OPENS YOUR PHONE. {map} GOES STRAIGHT TO THE MAP. IT SHOWS WHERE THE IMPORTANT STUFF IS.';
const SWEEP = 3;
const ACK_SPEED = 4;
const DROVE = 4;
const SORRY = 'SORRY! THINGS GET A LITTLE WEIRD AROUND HERE JUST AFTER 7...';
const SIT = 10 - SWEEP;
const STRAINED_START = 1.8;

const GATE_ROOF = 'NOT THE GATE, KID. THE GATE SAW THAT. SNEAK IT BACK IN AND GO OFF A KICKER.';
const GATE_NIGHT = 'NOT THE GATE, KID. THE GATE SEES EVERYTHING. GRAB ANOTHER ONE.';

const tires = (c: Cast): number => c.game.inventory.count('tire');
const loose = (c: Cast): readonly Vector3[] => c.game.looseItems('tire');
const riding = (c: Cast): Vehicle | null => c.game.vehicles.find((v) => v.role === 'player') ?? null;
const possessing = (c: Cast): boolean => riding(c)?.form === 'truck';
const inPickup = (c: Cast): boolean => c.pickup.role === 'player';
const outside = (c: Cast): boolean => {
  const p = c.game.player;
  return p.visible && !c.game.garage.inFootprint(p.pos) && p.pos.y > -1;
};

const onRoof = (c: Cast): boolean => !c.game.player.visible || c.game.player.pos.y > c.stage.roof - 1.5;
const gated = (crossing: Crossing): boolean => crossing.kind === 'logged-out' && crossing.vehicle.form === 'truck';

const markPickup = (c: Cast): Objective[] =>
  inPickup(c) ? [] : [{ id: 'tutorial-truck', label: 'YOUR PICKUP', kind: 'primary', at: c.pickup.pos }];
const markLip = (c: Cast): Objective[] => [
  { id: 'tutorial-ramp', label: 'THE RAMP', kind: 'primary', at: c.stage.lip },
];
const markRandy = (c: Cast): Objective[] => [
  { id: 'tutorial-randy', label: 'RANDY', kind: 'primary', at: c.randy.pos },
];
const markGhost = (c: Cast): Objective[] => {
  const at = nearestGhost(c.game, c.pickup.pos);
  return at ? [{ id: 'tutorial-ghost', label: 'GHOST', kind: 'optional', at }] : [];
};

const markCar = (c: Cast): Objective[] => {
  const v = nearestCar(c, riding(c)?.pos ?? c.game.player.pos, (car) => car.role === 'parked');
  return v ? [{ id: 'tutorial-car', label: 'PARKED CAR', kind: 'primary', at: v.pos }] : [];
};

const markDeckCar = (c: Cast): Objective[] => {
  const v = c.game.player.visible
    ? nearestCar(c, c.game.player.pos, (car) => car.role === 'parked' && car.insideDeck)
    : null;
  return v ? [{ id: 'tutorial-deck-car', label: 'DECK CAR', kind: 'optional', at: v.pos }] : [];
};

const markGate = (c: Cast): Objective[] => {
  const g = c.level.gates.find((gate) => gate.kind === 'entry');
  return g ? [{ id: 'tutorial-gate', label: 'EAST GATE', kind: 'primary', at: c.scenes.gateAt(g) }] : [];
};

const markTire = (c: Cast): Objective[] => {
  const me = riding(c)?.pos ?? c.game.player.pos;
  let best: Vector3 | null = null;
  for (const at of loose(c)) {
    if (!best || at.distanceTo(me) < best.distanceTo(me)) {
      best = at;
    }
  }

  return best ? [{ id: 'tutorial-tire', label: 'TIRE', kind: 'primary', at: best }] : [];
};

const mapLesson: P = react('exited', (c) => {
  if (c.outreach.once('lesson:map')) {
    c.outreach.text('lesson:map', MAP_LESSON);
  }
});

const scene: readonly P[] = [dayLook('truck', 'possess'), pause(), entry('none'), roofScene()];
const stalled: P = stall<Cast>((c) => c.pickup);
const truckRules: readonly P[] = [dayLook('truck', 'possess'), doors(LOCKED), keepEscapes()];
const fedRules: readonly P[] = [dayLook('truck', 'possess', 'intake'), doors(LOCKED), keepEscapes()];
const roofFence: P = region<Cast>({
  inside: onRoof,
  home: (c) => c.scenes.doorOf(c.pickup),
  line: { who: 'right', say: '...THAT WAS DUMB.', solo: true },
});

const brisket = (c: Cast): DialogueLine[] => {
  const g = c.game;
  const r = c.randy;
  const lines: DialogueLine[] = [];
  if (g.inventory.count('tire') > 0) {
    lines.push({ who: 'left', say: 'OHHH. NICE WHEELS.', cue: () => void g.trades.give(r, 'tire', g.player.pos) });
  }

  lines.push(
    { who: 'left', say: 'SIT. WARM UP. BRISKET?', cue: () => c.scenes.coat(true) },
    { who: 'right', say: '...FINE. ONE BITE.', cue: () => c.scenes.coat(false) },
    { who: 'right', say: "WOW. THAT'S REALLY GOOD." },
    { who: 'right', say: "I'D DESCRIBE IT AS... POSITIVELY TRANSFORMATIVE." },
    { who: 'left', say: 'HEH. GO GET SOME AIR, KID. MOON LOOKS GOOD TONIGHT.' },
  );
  return lines;
};

const toldYou = (c: Cast): DialogueLine[] => [
  { who: 'left', say: "TOLD YOU YOU COULD HAVE 'EM BACK.", cue: () => meltedKeys(c) },
];

export const BEATS: Beats<Cast, TutorialEvent, BeatId> = {
  roof: {
    parts: [
      ...scene,
      say<Cast>(
        [
          { who: 'right', say: "COME ON... BADGE WON'T SCAN ME OUT AFTER SEVEN." },
          { who: 'right', say: "I'M GONNA BE STUCK UP HERE ALL NIGHT." },
          { who: 'right', say: "AND I'M ON E. PERFECT." },
          { who: 'left', say: 'BADGE TROUBLE, KID? STEP OUT. LEMME SEE IT.' },
        ],
        { wait: 1 },
      ),
    ],
    next: 'badge',
  },
  badge: {
    parts: [
      ...scene,
      act((c) => {
        c.game.alight();
        c.gas.turnToward(c.randy.pos);
      }),
      facing(),
      say<Cast>([{ who: 'left', say: 'I KNOW THESE SCANNERS. HAND ME YOUR BADGE.' }]),
    ],
    next: 'handBadge',
  },
  handBadge: {
    parts: [
      ...scene,
      perform(
        (c) => c.gas.handBadge(c.randy, c.pickup),
        (c) => c.gas.skipBadge(c.randy, c.pickup),
      ),
    ],
    next: 'toss',
  },
  toss: {
    parts: [
      ...scene,
      facing(),
      say<Cast>((c) => [
        {
          who: 'left',
          say: "AH MAN. YOU DON'T NEED THIS.",
          cue: () => c.scenes.throwBadge(),
          until: () => !c.randy.throwing?.active,
        },
        { who: 'right', say: 'HUH?' },
      ]),
    ],
    next: 'keys',
  },
  keys: {
    parts: [
      ...scene,
      act((c) => c.camera.settle()),
      perform(
        (c) => c.gas.pickKeys(c.randy, c.pickup),
        (c) => c.gas.skipKeys(c.randy, c.pickup),
      ),
    ],
    next: 'phone',
  },
  phone: {
    parts: [
      ...scene,
      facing(),
      all([
        say<Cast>((c) => [
          { who: 'left', say: "YOU'RE GONNA NEED THIS.", cue: () => c.camera.settle() },
          { who: 'right', say: "THAT'S NOT..." },
        ]),
        perform(handPhone, (c) => skipPhone(c)),
      ]),
    ],
    next: 'gas',
  },
  gas: {
    parts: [
      ...scene,
      facing(),
      say<Cast>([
        { who: 'left', say: 'DID YOU SAY YOU WERE LOW ON GAS?' },
        { who: 'right', say: 'I...' },
        { who: 'left', say: 'I GOT YOU.' },
      ]),
    ],
    next: 'pour',
  },
  pour: {
    parts: [
      ...scene,
      act((c) => c.game.hud.clearToasts()),
      perform(
        (c) => c.gas.pourGas(c.randy, c.pickup),
        (c) => c.gas.skipGas(),
      ),
    ],
    next: 'allGood',
  },
  allGood: {
    parts: [...scene, say<Cast>((c) => [{ who: 'left', say: 'ALL GOOD!', cue: () => c.gas.dropCan(c.randy, 0) }])],
    next: 'basteLine',
  },
  basteLine: {
    parts: [...scene, say<Cast>([{ who: 'left', say: 'TIME TO BASTE.' }])],
    next: 'flare',
  },
  flare: {
    parts: [
      ...scene,
      perform(
        (c) => c.gas.baste(c.randy, c.stage.randy),
        (c) => c.gas.skipBaste(c.randy),
      ),
    ],
    next: 'uhOh',
  },
  uhOh: {
    parts: [
      ...scene,
      say<Cast>([
        { who: 'left', say: '...WAIT. WHICH TANK WAS THAT.' },
        { who: 'left', say: 'UH OH...' },
      ]),
    ],
    next: 'discovery',
  },
  discovery: {
    parts: [
      dayLook('truck', 'possess'),
      hold(18),
      entry('none'),
      act((c) => c.scenes.leave()),
      roofFence,
      getIn('refuse'),
      goal<Cast>('GET IN YOUR PICKUP', { how: GET_IN, marks: markPickup }),
      when((c) => c.scenes.gone),
    ],
    next: 'wonder',
  },
  wonder: {
    parts: [
      dayLook('truck', 'possess'),
      hold(18),
      entry('none'),
      roofFence,
      getIn('refuse'),
      goal<Cast>('GET IN YOUR PICKUP', { how: GET_IN, marks: markPickup }),
      say<Cast>([
        { who: 'right', say: 'WHERE DID HE GO?', solo: true },
        { who: 'right', say: '...WAIT. HE HAD MY KEYS!!', solo: true },
      ]),
    ],
    next: 'keysCall',
  },
  keysCall: {
    parts: [
      dayLook('truck', 'possess'),
      hold(18.25),
      entry('none'),
      roofFence,
      getIn('refuse'),
      goal<Cast>('GET IN YOUR PICKUP', { how: GET_IN, marks: markPickup }),
      call<Cast>((c) => [
        { who: 'left', say: 'DO YOU WANT THE GOOD NEWS OR THE BAD NEWS...', look: SMOKE },
        { who: 'right', say: 'ACTUALLY... I JUST WANT MY KEYS.' },
        { who: 'left', say: 'GOOD NEWS: YOU CAN HAVE THEM BACK.', look: SMOKE },
        { who: 'left', say: 'BAD NEWS: MIGHT BE A SECOND. I DROPPED THEM IN THE SMOKER.', look: SMOKE },
        {
          who: 'left',
          say: 'YOUR KEYS ARE BURNING A HOLE IN MY POCKET.',
          look: MOLTEN,
          cue: () => moltenKeys(c),
        },
        {
          who: 'left',
          say: 'MEANTIME, HOTWIRE IT. GET IN, JOIN THE IGNITION WIRES, TOUCH THE STARTER TO THEM.',
          look: MOLTEN,
        },
      ]),
    ],
    next: 'hotwire',
  },
  hotwire: {
    parts: [
      dayLook('truck', 'possess'),
      hold(18.5),
      entry('pickup'),
      roofFence,
      getIn('board'),
      goal<Cast>((c) => (inPickup(c) ? '{pay} HOTWIRE YOUR PICKUP' : 'GET IN YOUR PICKUP'), {
        how: (c) => (inPickup(c) ? 'IN THE DRIVER SEAT, PRESS {pay} TO JOIN THE WIRES.' : GET_IN),
        marks: markPickup,
      }),
      nudge<Cast>('HOTWIRE THAT PICKUP'),
      progressOn('entered', (c, e) => e.v === c.pickup),
      on('hotwired', (c, e) => e.v === c.pickup),
    ],
    next: 'sorry',
  },
  sorry: {
    parts: [
      ...truckRules,
      hold(18.5),
      barriers(),
      stalled,
      coughing(STRAINED_START),
      text<Cast>(SORRY, { done: true, reply: true, after: STRAINED_START }),
    ],
    next: 'weird',
  },
  weird: {
    parts: [...truckRules, hold(18.5), barriers(), stalled, coughing(), after(SIT)],
    next: 'ramp',
  },
  ramp: {
    parts: [
      ...truckRules,
      sweep(19, SWEEP, 19.5),
      barriers(),
      stall<Cast>((c) => c.pickup, {
        releaseOn: 'nightfall',
        released: (c) => c.game.events.emit('sfx', { name: 'engine-roar', at: tailpipe(c.pickup) }),
      }),
      coughing(),
      react('nightfall', (c) => c.camera.moonrise(c.pickup.yaw)),
      text<Cast>((c) => `NO BADGE, NO GATE. PULL OUT, HANG A ${c.stage.turn}, FLOOR IT UP THAT RAMP.`, {
        until: (c) => c.pickup.pos.distanceTo(c.stage.truck) > DROVE || Math.abs(c.pickup.speed) > ACK_SPEED,
      }),
      goal<Cast>('LEAVE THE DECK VIA THE RAMP', { how: "FULL SPEED UP THE RAMP. DON'T STOP.", marks: markLip }),
      nudge<Cast>('FLY OFF THAT RAMP'),
      ledgerOnJump(),
      rampRun<Cast>({
        vehicle: (c) => c.pickup,
        ramp: (c) => c.stage.ramp,
        resetTo: (c) => c.stage.start,
        deck: (c) => c.stage.roof,
        assistAfterMisses: 2,
        forceAfterMisses: 3,
        forceAfterIdleSeconds: 90,
        forced: "THE TRUCK'S GOT IDEAS",
      }),
      react('crossing', (c, e, s) => {
        if (e.crossing.kind === 'escaped') {
          c.game.hud.showLedger(true);
        } else if (gated(e.crossing)) {
          c.outreach.text(`${s.key}:gate`, GATE_ROOF);
        }
      }),
      react('phantom', (c, e) => {
        c.chapter.imprint = e.imprint;
      }),
      on('phantom'),
    ],
    next: 'landing',
  },
  landing: {
    parts: [...truckRules, hold(19.5), when(settled, { for: 2 }), after(12)],
    next: 'tell',
  },
  tell: {
    parts: [
      ...truckRules,
      hold(19.75),
      pauseWhen<Cast>((c) => c.outreach.phone.calling),
      call<Cast>(
        [
          { who: 'left', say: 'OH YEAH! I NEED TO TELL YOU...' },
          { who: 'left', say: "THAT SPOT YOU PULLED OUT OF? THE GARAGE THINKS YOU'RE STILL PARKED IN IT." },
          { who: 'left', say: 'TAKE A LOOK.' },
        ],
        { keep: true },
      ),
    ],
    next: 'imprint',
  },
  imprint: {
    parts: [...truckRules, pause(), imprintSign(), on('signed')],
    next: 'yours',
  },
  yours: {
    parts: [
      ...truckRules,
      pause(),
      call<Cast>([
        { who: 'left', say: "HEH. NO SWIPE OUT, NO EXIT ON THE LOG. TRUCK'S YOURS TONIGHT." },
        { who: 'right', say: "WASN'T IT MINE ALREADY?" },
        { who: 'left', say: "WE'RE SO PAST THAT." },
        { who: 'right', say: '...WUT?...' },
      ]),
    ],
    next: (c) => (c.touch ? 'ghost' : 'camera'),
  },
  camera: {
    parts: [
      ...truckRules,
      hold(20.5),
      watchViews(),
      text<Cast>('{camera} SWITCHES THE CAMERA. TOP OR BEHIND.', {
        after: 8,
        until: (c) => c.chapter.views.size >= 2,
      }),
      goal<Cast>((c, s) => (s.t < 8 ? 'TAKE IT FOR A SPIN' : `{camera} TRY THE CAMERAS (${c.chapter.views.size}/2)`), {
        how: 'PRESS {camera} UNTIL THE VIEW CHANGES, THEN AGAIN.',
      }),
      when((c) => c.chapter.views.size >= 2),
      after(38),
    ],
    next: 'ghost',
  },
  ghost: {
    parts: [
      ...fedRules,
      hold(21),
      text<Cast>("TANK'S FULL OF MOP SAUCE. TURNS OUT GHOSTS LOVE IT. SEE THEM GHOSTS? DRIVE RIGHT THROUGH 'EM.", {
        until: (c) => c.game.ghast > 0,
      }),
      ghostTrail<Cast>((c) => riding(c) ?? c.pickup),
      pins<Cast>((c) => c.game.activeGhosts(), PIN_RANGE),
      goal<Cast>('DRIVE THROUGH A GHOST', { how: 'STEER INTO A GLOWING GHOST.', marks: markGhost }),
      nudge<Cast>('DRIVE THROUGH A GHOST', {
        crawling: [
          { who: 'right', say: 'WHERE CAN I FIND A GHOST?' },
          { who: 'left', say: 'UH... MAKE SOME?' },
        ],
      }),
      on('swallowed'),
      when((c) => c.game.ghast > 0),
    ],
    next: 'boost',
  },
  boost: {
    parts: [
      ...fedRules,
      hold(21.5),
      text<Cast>(`FEEL THAT? GHOSTS IN THE TANK. THAT'S ${GHAST}. HOLD {boost} TO BURN IT.`, {
        until: (c) => c.game.burning,
      }),
      ghostSupply<Cast>((c) => riding(c) ?? c.pickup),
      pins<Cast>((c) => (c.game.ghast > 0 ? [] : c.game.activeGhosts()), PIN_RANGE),
      goal<Cast>(`{boost} BURN THE ${GHAST}`, { how: 'HOLD {boost} WHILE YOU DRIVE.' }),
      nudge<Cast>('BURN THAT GHAST'),
      on('boosted'),
    ],
    next: 'soul',
  },
  soul: {
    parts: [...fedRules, hold(21.75), text<Cast>('HA! SOUL POWER.', { brief: 2.5, done: true })],
    next: 'basementCall',
  },
  basementCall: {
    parts: [
      ...fedRules,
      hold(22),
      ghostSupply<Cast>((c) => riding(c) ?? c.pickup),
      pins<Cast>((c) => (c.game.ghast < 1 ? c.game.activeGhosts() : []), PIN_RANGE),
      goal<Cast>(
        (c) => (c.game.ghast < 1 ? `TOP OFF THE TANK (${Math.floor(c.game.ghast * 100)}%)` : 'FULL TANK. LET IT RIP.'),
        { how: (c) => (c.game.ghast < 1 ? 'DRIVE THROUGH GHOSTS TO FILL UP.' : `HOLD {boost} TO BURN THE ${GHAST}.`) },
      ),
      call<Cast>([
        { who: 'left', say: "KID. IT'S RANDY. NICE JUMP." },
        { who: 'left', say: 'MEET ME IN THE BASEMENT. AND BRING WHEELS.' },
        { who: 'right', say: 'WHEELS?' },
        { who: 'left', say: 'SMASH SOMETHING. THEY FALL OFF.' },
        { who: 'left', say: '{interact} GETS YOU OUT. GRAB SOME ON YOUR WAY.' },
        { who: 'right', say: 'UH... OK.' },
      ]),
    ],
    next: 'tires',
  },
  tires: {
    parts: [
      dayLook('truck', 'possess', 'intake'),
      hold(22.5),
      noTrades(),
      talkToRandy(),
      mapLesson,
      goal<Cast>('SMASH A CAR FOR TIRES', { how: 'RAM PARKED CARS. TIRES POP OFF.', marks: markCar }),
      nudge<Cast>('BRING ME SOME WHEELS'),
      when((c) => tires(c) > 0, { next: 'bring' }),
      when((c) => loose(c).length > 0, { next: 'grab' }),
      on('talk', (_c, e) => e.tires === 0, 'noWheels'),
    ],
    next: 'grab',
  },
  grab: {
    parts: [
      dayLook('truck', 'possess', 'intake'),
      hold(22.75),
      noTrades(),
      talkToRandy(),
      mapLesson,
      pins<Cast>(loose, PIN_RANGE, TIRE_PIN),
      goal<Cast>('GRAB THE TIRES', { how: '{interact} GET OUT AND GRAB THEM.', marks: markTire }),
      nudge<Cast>('GRAB THOSE TIRES'),
      when((c) => tires(c) > 0, { next: 'bring' }),
      when((c) => loose(c).length === 0, { next: 'tires' }),
      on('talk', (_c, e) => e.tires === 0, 'noWheels'),
    ],
    next: 'bring',
  },
  noWheels: {
    parts: [
      dayLook('truck', 'possess', 'intake'),
      hold(22.5),
      noTrades(),
      faceCody(),
      say<Cast>([
        { who: 'left', say: 'NO WHEELS? GO GET ME SOME.' },
        { who: 'left', say: 'SMASH SOMETHING. THEY FALL OFF.' },
      ]),
    ],
    next: 'tires',
  },
  bring: {
    parts: [
      dayLook('truck', 'possess', 'intake'),
      hold(23),
      noTrades(),
      talkToRandy(),
      mapLesson,
      goal<Cast>('BRING THE TIRES TO RANDY', { how: 'WALK UP TO RANDY. {interact} TALK.', marks: markRandy }),
      nudge<Cast>('BRING ME THOSE WHEELS'),
      on('talk', (_c, e) => e.tires > 0, 'sitDown'),
      when((c) => tires(c) === 0, { next: 'tires' }),
    ],
    next: 'sitDown',
  },
  sitDown: {
    parts: [dayLook('truck', 'possess', 'intake'), hold(23.25), noTrades(), seatAtFire(), say<Cast>(brisket)],
    next: 'moonlight',
  },
  moonlight: {
    parts: [
      dayLook('truck', 'possess', 'intake'),
      hold(23.5),
      goal<Cast>('GO BACK OUT INTO THE MOONLIGHT', { how: 'TAKE THE STAIRS UP AND WALK OUT OF THE DECK.' }),
      nudge<Cast>('GO GET SOME AIR'),
      when(outside),
    ],
    next: 'rules',
  },
  rules: {
    parts: [
      hold(23.75),
      act((c) => c.bam()),
      text<Cast>("AT NIGHT YOU CAN'T STEAL CARS. YOU POSSESS 'EM, AND ONLY INSIDE THE HAUNTED DECK.", { done: true }),
    ],
    next: 'spook',
  },
  spook: {
    parts: [
      hold(0.5),
      text<Cast>("PEOPLE SPOOK EASY NOW. SCARE A DRIVER AND THEY'LL BOLT RIGHT INTO THE DECK.", {
        doing: true,
      }),
      goal<Cast>('SPOOK SOMEBODY', { how: 'WALK UP TO A CAR ON THE ROAD. THE DRIVER WILL SEE YOU.' }),
      nudge<Cast>('SPOOK SOMEBODY'),
      on('spooked'),
      after(45),
    ],
    next: 'raise',
  },
  raise: {
    parts: [
      hold(1.5),
      text<Cast>("LONG AS IT'S DARK, YOU CAN RAISE THE DEAD. GO ON. THEY OWE YOU. SUN COMES UP, THEY'RE DUST.", {
        doing: true,
      }),
      goal<Cast>('{summon} RAISE THE DEAD', { how: 'ON FOOT, PRESS {summon}.' }),
      nudge<Cast>('RAISE THE DEAD'),
      on('summoned'),
    ],
    next: 'possess',
  },
  possess: {
    parts: [
      hold(2.5),
      text<Cast>('POSSESS ONE IN THE DECK. GET IT OUT. NOT THROUGH THE GATE.', { until: possessing }),
      goal<Cast>('{interact} POSSESS A CAR IN THE DECK', {
        how: 'WALK UP TO A CAR PARKED IN THE DECK. {interact} POSSESS.',
        marks: markDeckCar,
      }),
      nudge<Cast>('POSSESS A CAR IN THE DECK'),
      on('entered', (_c, e) => e.possessed),
    ],
    next: 'escape',
  },
  escape: {
    parts: [
      hold(4.5),
      text<Cast>('WALLS BREAK. KICKERS JUMP.', { doing: true }),
      goal<Cast>('GET IT OUT. NOT THE GATE.', { how: 'SMASH THROUGH A WALL OR JUMP A KICKER.' }),
      nudge<Cast>('GET IT OUT'),
      react('crossing', (c, e) => {
        if (gated(e.crossing)) {
          c.outreach.text('night1:gate', GATE_NIGHT);
        }
      }),
      on('crossing', (_c, e) => gated(e.crossing), 'possess'),
      on('crossing', (_c, e) => e.crossing.kind === 'escaped'),
      on('exited', () => true, 'possess'),
    ],
    next: 'rest',
  },
  rest: {
    parts: [
      free(),
      act((c) => c.remember(1)),
      text<Cast>("THAT'S ANOTHER ONE. KEEP 'EM COMING TILL SUNRISE."),
      on('sunrise'),
    ],
    next: 'morning',
  },
  morning: {
    parts: [
      act((c) => c.wake()),
      hold(10),
      text<Cast>("MORNING. DAY JOB NOW: THE DECK NEEDS CARS TO PHANTOM. STREET'S FULL OF 'EM. TAKE ONE.", {
        until: (c) => !!riding(c) && riding(c) !== c.pickup,
      }),
      goal<Cast>('{interact} STEAL A CAR', { how: 'WALK UP TO ANY CAR. {interact} STEAL. PARKED ONES NEED {pay}.' }),
      nudge<Cast>('STEAL A CAR'),
      on('entered', (c, e) => !e.possessed && e.v !== c.pickup),
    ],
    next: 'gate',
  },
  gate: {
    parts: [
      hold(12),
      text<Cast>('BRING IT IN THE EAST GATE. GATE LOGS IT IN. NO BADGE NEEDED FOR THAT PART, HA.', {
        doing: true,
      }),
      goal<Cast>('DRIVE IN THROUGH THE EAST GATE', {
        how: 'DRIVE UP TO THE EAST GATE AND THROUGH IT.',
        marks: markGate,
      }),
      nudge<Cast>('BRING IT IN THE EAST GATE'),
      react('crossing', (c, e, s) => {
        if (e.crossing.kind === 'snuck-in') {
          c.outreach.text(
            `${s.key}:sneak`,
            'NO GATE? CUTE. THE GATE IS HOW IT COUNTS. BACK OUT, COME IN THE EAST GATE.',
          );
        }
      }),
      on('crossing', (_c, e) => e.crossing.kind === 'logged-in'),
    ],
    next: 'park',
  },
  park: {
    parts: [
      hold(14),
      text<Cast>('PARK IT UPSTAIRS AND GET OUT. WHAT YOU LOG IN BY DAY, YOU PHANTOM OUT BY NIGHT.', {
        doing: true,
      }),
      goal<Cast>('PARK IN A FREE SPOT, {interact} GET OUT', {
        how: 'STOP INSIDE A FREE SPOT, THEN {interact} GET OUT.',
      }),
      nudge<Cast>('PARK IT AND GET OUT'),
      on('exited', (_c, e) => e.spot !== null),
    ],
    next: 'tonight',
  },
  tonight: {
    parts: [hold(16), act((c) => c.startErrand()), text<Cast>('GOOD. COME 7, PHANTOM IT OUT.', { done: true })],
    next: 'night2',
  },
  night2: {
    parts: [
      sweep(19, SWEEP, 22),
      text<Cast>('POSSESS ONE. GET IT OUT.', { doing: true }),
      goal<Cast>((c) => (possessing(c) ? 'GET IT OUT. NOT THE GATE.' : '{interact} POSSESS A CAR IN THE DECK'), {
        how: (c) =>
          possessing(c)
            ? 'SMASH THROUGH A WALL OR JUMP A KICKER.'
            : 'WALK UP TO A CAR PARKED IN THE DECK. {interact} POSSESS.',
        marks: markDeckCar,
      }),
      nudge<Cast>('POSSESS ONE AND GET IT OUT'),
      react('crossing', (c, e, s) => {
        if (gated(e.crossing)) {
          c.outreach.text(`${s.key}:gate`, GATE_NIGHT);
        }
      }),
      on('crossing', (_c, e) => e.crossing.kind === 'escaped'),
    ],
    next: 'racket',
  },
  racket: {
    parts: [
      hold(22.5),
      text<Cast>("THAT'S THE WHOLE RACKET. THIRTY PHANTOMS AND THE DECK'S OURS. BRISKET OFFER STANDS.", {
        done: true,
      }),
    ],
    next: null,
  },
};

export const ERRAND: Beats<Cast, TutorialEvent, ErrandId> = {
  cooled: {
    parts: [
      text<Cast>('KEYS COOLED OFF. SWING BY.'),
      mark<Cast>((c) => [{ id: 'tutorial-keys', label: 'RANDY', kind: 'optional', at: c.randy.pos }]),
      talkToRandy(),
      errand.on('talk'),
    ],
    next: 'handed',
  },
  handed: {
    parts: [faceCody(), say<Cast>(toldYou)],
    next: null,
  },
};

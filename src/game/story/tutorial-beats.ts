import type { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import type { Crossing } from '@/game/deck/garage';
import type { DialogueLine } from '@/ui/dialogue';

import { act, after, all, on, progressOn, react, run, when, type BeatBehavior } from './behaviors';
import type { Beats } from './director';
import type { Objective } from './objectives';
import { rampRun } from './ramp-run';
import { BADGE_HANDOFF, KEY_PICKUP, POUR_GAS, BASTE_FIRE } from './roof-choreography';
import { barriers, dayLook, doors, entry, keepEscapes, noTrades, stall } from './story-access';
import { free, hold, pause, pauseWhen, sweep } from './story-clock';
import { ghostSupply, ghostTrail, nearestGhost } from './story-ghosts';
import { goal, mark, pins } from './story-goals';
import { call, nudge, say, text } from './story-outreach';
import { region } from './story-recovery';
import type { TutorialContext, TutorialEvent } from './tutorial-context';
import {
  coat,
  doorOf,
  gateAt,
  tossBadge,
  coughing,
  faceCody,
  facing,
  getIn,
  handPhone,
  imprintSign,
  nearestCar,
  directRandy,
  ledgerOnJump,
  leaveRoof,
  meltedKeys,
  moltenKeys,
  roofScene,
  seatAtFire,
  settled,
  tailpipe,
  talkToRandy,
  watchViews,
} from './tutorial-scenes';

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

type TutorialBehavior = BeatBehavior<TutorialContext, TutorialEvent, BeatId>;

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

const tires = (c: TutorialContext): number => c.game.inventory.count('tire');
const loose = (c: TutorialContext): readonly Vector3[] => c.game.looseItems('tire');
const riding = (c: TutorialContext): Vehicle | null => c.game.vehicles.find((v) => v.role === 'player') ?? null;
const possessing = (c: TutorialContext): boolean => riding(c)?.form === 'truck';
const inPickup = (c: TutorialContext): boolean => c.pickup.role === 'player';
const outside = (c: TutorialContext): boolean => {
  const p = c.game.player;
  return p.visible && !c.game.garage.inFootprint(p.pos) && p.pos.y > -1;
};

const onRoof = (c: TutorialContext): boolean => !c.game.player.visible || c.game.player.pos.y > c.stage.roof - 1.5;
const gated = (crossing: Crossing): boolean => crossing.kind === 'logged-out' && crossing.vehicle.form === 'truck';

const markPickup = (c: TutorialContext): Objective[] =>
  inPickup(c) ? [] : [{ id: 'tutorial-truck', label: 'YOUR PICKUP', kind: 'primary', at: c.pickup.pos }];
const markLip = (c: TutorialContext): Objective[] => [
  { id: 'tutorial-ramp', label: 'THE RAMP', kind: 'primary', at: c.stage.lip },
];
const markRandy = (c: TutorialContext): Objective[] => [
  { id: 'tutorial-randy', label: 'RANDY', kind: 'primary', at: c.randy.pos },
];
const markGhost = (c: TutorialContext): Objective[] => {
  const at = nearestGhost(c.game, c.pickup.pos);
  return at ? [{ id: 'tutorial-ghost', label: 'GHOST', kind: 'optional', at }] : [];
};

const markCar = (c: TutorialContext): Objective[] => {
  const v = nearestCar(
    c.game.vehicles,
    riding(c)?.pos ?? c.game.player.pos,
    (car) => car !== c.pickup && car.role === 'parked',
  );
  return v ? [{ id: 'tutorial-car', label: 'PARKED CAR', kind: 'primary', at: v.pos }] : [];
};

const markDeckCar = (c: TutorialContext): Objective[] => {
  const v = c.game.player.visible
    ? nearestCar(
        c.game.vehicles,
        c.game.player.pos,
        (car) => car !== c.pickup && car.role === 'parked' && car.insideDeck,
      )
    : null;
  return v ? [{ id: 'tutorial-deck-car', label: 'DECK CAR', kind: 'optional', at: v.pos }] : [];
};

const markGate = (c: TutorialContext): Objective[] => {
  const g = c.level.gates.find((gate) => gate.kind === 'entry');
  return g ? [{ id: 'tutorial-gate', label: 'EAST GATE', kind: 'primary', at: gateAt(g) }] : [];
};

const markTire = (c: TutorialContext): Objective[] => {
  const me = riding(c)?.pos ?? c.game.player.pos;
  let best: Vector3 | null = null;
  for (const at of loose(c)) {
    if (!best || at.distanceTo(me) < best.distanceTo(me)) {
      best = at;
    }
  }

  return best ? [{ id: 'tutorial-tire', label: 'TIRE', kind: 'primary', at: best }] : [];
};

const mapLesson: TutorialBehavior = react('exited', (c) => {
  if (c.outreach.once('lesson:map')) {
    c.outreach.text('lesson:map', MAP_LESSON);
  }
});

const scene: readonly TutorialBehavior[] = [dayLook('truck', 'possess'), pause, entry('none'), roofScene];
const stalled: TutorialBehavior = stall((c) => c.pickup);
const truckRules: readonly TutorialBehavior[] = [dayLook('truck', 'possess'), doors(LOCKED), keepEscapes];
const fedRules: readonly TutorialBehavior[] = [dayLook('truck', 'possess', 'intake'), doors(LOCKED), keepEscapes];
const roofFence: TutorialBehavior = region({
  inside: onRoof,
  home: (c) => doorOf(c.pickup),
  line: { who: 'right', say: '...THAT WAS DUMB.', solo: true },
});

const brisket = (c: TutorialContext): DialogueLine[] => {
  const g = c.game;
  const r = c.randy;
  const lines: DialogueLine[] = [];
  if (g.inventory.count('tire') > 0) {
    lines.push({ who: 'left', say: 'OHHH. NICE WHEELS.', cue: () => void g.trades.give(r, 'tire', g.player.pos) });
  }

  lines.push(
    { who: 'left', say: 'SIT. WARM UP. BRISKET?', cue: () => coat(c.game, c.randy, true) },
    { who: 'right', say: '...FINE. ONE BITE.', cue: () => coat(c.game, c.randy, false) },
    { who: 'right', say: "WOW. THAT'S REALLY GOOD." },
    { who: 'right', say: "I'D DESCRIBE IT AS... POSITIVELY TRANSFORMATIVE." },
    { who: 'left', say: 'HEH. GO GET SOME AIR, KID. MOON LOOKS GOOD TONIGHT.' },
  );
  return lines;
};

const toldYou = (c: TutorialContext): DialogueLine[] => [
  { who: 'left', say: "TOLD YOU YOU COULD HAVE 'EM BACK.", cue: () => meltedKeys(c.game, c.randy, c.pickup) },
];

export const BEATS: Beats<TutorialContext, TutorialEvent, BeatId> = {
  roof: {
    parts: [
      ...scene,
      say(
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
        c.roofScene.turnToward(c.randy.pos);
      }),
      facing,
      say([{ who: 'left', say: 'I KNOW THESE SCANNERS. HAND ME YOUR BADGE.' }]),
    ],
    next: 'handBadge',
  },
  handBadge: {
    parts: [...scene, directRandy((c) => c.roofScene.play(BADGE_HANDOFF, c.randy, c.pickup))],
    next: 'toss',
  },
  toss: {
    parts: [
      ...scene,
      facing,
      all([
        directRandy((c) => tossBadge(c.randy, c.stage.toss, c.camera)),
        say((c) => [
          {
            who: 'left',
            say: "AH MAN. YOU DON'T NEED THIS.",
            until: () => !c.randy.throwing?.active,
          },
          { who: 'right', say: 'HUH?' },
        ]),
      ]),
    ],
    next: 'keys',
  },
  keys: {
    parts: [
      ...scene,
      act((c) => c.camera.settle()),
      directRandy((c) => c.roofScene.play(KEY_PICKUP, c.randy, c.pickup)),
    ],
    next: 'phone',
  },
  phone: {
    parts: [
      ...scene,
      facing,
      all([
        say((c) => [
          { who: 'left', say: "YOU'RE GONNA NEED THIS.", cue: () => c.camera.settle() },
          { who: 'right', say: "THAT'S NOT..." },
        ]),
        directRandy((c) => handPhone(c.game, c.randy, c.camera)),
      ]),
    ],
    next: 'gas',
  },
  gas: {
    parts: [
      ...scene,
      facing,
      say([
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
      directRandy((c) => c.roofScene.play(POUR_GAS, c.randy, c.pickup)),
    ],
    next: 'allGood',
  },
  allGood: {
    parts: [...scene, say((c) => [{ who: 'left', say: 'ALL GOOD!', cue: () => c.roofScene.dropCan(c.randy, 0) }])],
    next: 'basteLine',
  },
  basteLine: {
    parts: [...scene, say([{ who: 'left', say: 'TIME TO BASTE.' }])],
    next: 'flare',
  },
  flare: {
    parts: [...scene, directRandy((c) => c.roofScene.play(BASTE_FIRE, c.randy, c.pickup, c.stage.randy))],
    next: 'uhOh',
  },
  uhOh: {
    parts: [
      ...scene,
      say([
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
      roofFence,
      getIn('refuse'),
      goal('GET IN YOUR PICKUP', { how: GET_IN, marks: markPickup }),
      leaveRoof,
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
      goal('GET IN YOUR PICKUP', { how: GET_IN, marks: markPickup }),
      say([
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
      goal('GET IN YOUR PICKUP', { how: GET_IN, marks: markPickup }),
      call((c) => [
        { who: 'left', say: 'DO YOU WANT THE GOOD NEWS OR THE BAD NEWS...', look: SMOKE },
        { who: 'right', say: 'ACTUALLY... I JUST WANT MY KEYS.' },
        { who: 'left', say: 'GOOD NEWS: YOU CAN HAVE THEM BACK.', look: SMOKE },
        { who: 'left', say: 'BAD NEWS: MIGHT BE A SECOND. I DROPPED THEM IN THE SMOKER.', look: SMOKE },
        {
          who: 'left',
          say: 'YOUR KEYS ARE BURNING A HOLE IN MY POCKET.',
          look: MOLTEN,
          cue: () => moltenKeys(c.game, c.randy, c.pickup),
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
      goal((c) => (inPickup(c) ? '{pay} HOTWIRE YOUR PICKUP' : 'GET IN YOUR PICKUP'), {
        how: (c) => (inPickup(c) ? 'IN THE DRIVER SEAT, PRESS {pay} TO JOIN THE WIRES.' : GET_IN),
        marks: markPickup,
      }),
      nudge('HOTWIRE THAT PICKUP'),
      progressOn('entered', (c, e) => e.v === c.pickup),
      on('hotwired', (c, e) => e.v === c.pickup),
    ],
    next: 'sorry',
  },
  sorry: {
    parts: [
      ...truckRules,
      hold(18.5),
      barriers,
      stalled,
      coughing(STRAINED_START),
      text(SORRY, { done: true, reply: true, after: STRAINED_START }),
    ],
    next: 'weird',
  },
  weird: {
    parts: [...truckRules, hold(18.5), barriers, stalled, coughing(), after(SIT)],
    next: 'ramp',
  },
  ramp: {
    parts: [
      ...truckRules,
      sweep(19, SWEEP, 19.5),
      barriers,
      stall((c) => c.pickup, {
        releaseOn: 'nightfall',
        released: (c) => c.game.events.emit('sfx', { name: 'engine-roar', at: tailpipe(c.pickup) }),
      }),
      coughing(),
      react('nightfall', (c) => c.camera.moonrise(c.pickup.yaw)),
      text((c) => `NO BADGE, NO GATE. PULL OUT, HANG A ${c.stage.turn}, FLOOR IT UP THAT RAMP.`, {
        until: (c) => c.pickup.pos.distanceTo(c.stage.truck) > DROVE || Math.abs(c.pickup.speed) > ACK_SPEED,
      }),
      goal('LEAVE THE DECK VIA THE RAMP', {
        how: "FULL SPEED UP THE RAMP. DON'T STOP.",
        marks: markLip,
      }),
      nudge('FLY OFF THAT RAMP'),
      ledgerOnJump,
      rampRun({
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
        c.progress.firstPhantom = e.imprint;
      }),
      on('phantom'),
    ],
    next: 'landing',
  },
  landing: {
    parts: [...truckRules, hold(19.5), when((c) => settled(c.pickup), { for: 2 }), after(12)],
    next: 'tell',
  },
  tell: {
    parts: [
      ...truckRules,
      hold(19.75),
      pauseWhen((c) => c.outreach.phone.calling),
      call(
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
    parts: [...truckRules, pause, run(imprintSign)],
    next: 'yours',
  },
  yours: {
    parts: [
      ...truckRules,
      pause,
      call([
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
      watchViews,
      text('{camera} SWITCHES THE CAMERA. TOP OR BEHIND.', {
        after: 8,
        until: (c) => c.progress.viewsSeen.size >= 2,
      }),
      goal((c, s) => (s.t < 8 ? 'TAKE IT FOR A SPIN' : `{camera} TRY THE CAMERAS (${c.progress.viewsSeen.size}/2)`), {
        how: 'PRESS {camera} UNTIL THE VIEW CHANGES, THEN AGAIN.',
      }),
      when((c) => c.progress.viewsSeen.size >= 2),
      after(38),
    ],
    next: 'ghost',
  },
  ghost: {
    parts: [
      ...fedRules,
      hold(21),
      text("TANK'S FULL OF MOP SAUCE. TURNS OUT GHOSTS LOVE IT. SEE THEM GHOSTS? DRIVE RIGHT THROUGH 'EM.", {
        until: (c) => c.game.ghast > 0,
      }),
      ghostTrail((c) => riding(c) ?? c.pickup),
      pins((c) => c.game.activeGhosts(), PIN_RANGE),
      goal('DRIVE THROUGH A GHOST', { how: 'STEER INTO A GLOWING GHOST.', marks: markGhost }),
      nudge('DRIVE THROUGH A GHOST', {
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
      text(`FEEL THAT? GHOSTS IN THE TANK. THAT'S ${GHAST}. HOLD {boost} TO BURN IT.`, {
        until: (c) => c.game.burning,
      }),
      ghostSupply((c) => riding(c) ?? c.pickup),
      pins((c) => (c.game.ghast > 0 ? [] : c.game.activeGhosts()), PIN_RANGE),
      goal(`{boost} BURN THE ${GHAST}`, { how: 'HOLD {boost} WHILE YOU DRIVE.' }),
      nudge('BURN THAT GHAST'),
      on('boosted'),
    ],
    next: 'soul',
  },
  soul: {
    parts: [...fedRules, hold(21.75), text('HA! SOUL POWER.', { brief: 2.5, done: true })],
    next: 'basementCall',
  },
  basementCall: {
    parts: [
      ...fedRules,
      hold(22),
      ghostSupply((c) => riding(c) ?? c.pickup),
      pins((c) => (c.game.ghast < 1 ? c.game.activeGhosts() : []), PIN_RANGE),
      goal(
        (c) => (c.game.ghast < 1 ? `TOP OFF THE TANK (${Math.floor(c.game.ghast * 100)}%)` : 'FULL TANK. LET IT RIP.'),
        { how: (c) => (c.game.ghast < 1 ? 'DRIVE THROUGH GHOSTS TO FILL UP.' : `HOLD {boost} TO BURN THE ${GHAST}.`) },
      ),
      call([
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
      noTrades,
      talkToRandy,
      mapLesson,
      goal('SMASH A CAR FOR TIRES', { how: 'RAM PARKED CARS. TIRES POP OFF.', marks: markCar }),
      nudge('BRING ME SOME WHEELS'),
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
      noTrades,
      talkToRandy,
      mapLesson,
      pins(loose, PIN_RANGE, TIRE_PIN),
      goal('GRAB THE TIRES', { how: '{interact} GET OUT AND GRAB THEM.', marks: markTire }),
      nudge('GRAB THOSE TIRES'),
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
      noTrades,
      faceCody,
      say([
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
      noTrades,
      talkToRandy,
      mapLesson,
      goal('BRING THE TIRES TO RANDY', {
        how: 'WALK UP TO RANDY. {interact} TALK.',
        marks: markRandy,
      }),
      nudge('BRING ME THOSE WHEELS'),
      on('talk', (_c, e) => e.tires > 0, 'sitDown'),
      when((c) => tires(c) === 0, { next: 'tires' }),
    ],
    next: 'sitDown',
  },
  sitDown: {
    parts: [dayLook('truck', 'possess', 'intake'), hold(23.25), noTrades, seatAtFire, say(brisket)],
    next: 'moonlight',
  },
  moonlight: {
    parts: [
      dayLook('truck', 'possess', 'intake'),
      hold(23.5),
      goal('GO BACK OUT INTO THE MOONLIGHT', { how: 'TAKE THE STAIRS UP AND WALK OUT OF THE DECK.' }),
      nudge('GO GET SOME AIR'),
      when(outside),
    ],
    next: 'rules',
  },
  rules: {
    parts: [
      hold(23.75),
      act((c) => c.announcePhantomCody()),
      text("AT NIGHT YOU CAN'T STEAL CARS. YOU POSSESS 'EM, AND ONLY INSIDE THE HAUNTED DECK.", {
        done: true,
      }),
    ],
    next: 'spook',
  },
  spook: {
    parts: [
      hold(0.5),
      text("PEOPLE SPOOK EASY NOW. SCARE A DRIVER AND THEY'LL BOLT RIGHT INTO THE DECK.", {
        doing: true,
      }),
      goal('SPOOK SOMEBODY', { how: 'WALK UP TO A CAR ON THE ROAD. THE DRIVER WILL SEE YOU.' }),
      nudge('SPOOK SOMEBODY'),
      on('spooked'),
      after(45),
    ],
    next: 'raise',
  },
  raise: {
    parts: [
      hold(1.5),
      text("LONG AS IT'S DARK, YOU CAN RAISE THE DEAD. GO ON. THEY OWE YOU. SUN COMES UP, THEY'RE DUST.", {
        doing: true,
      }),
      goal('{summon} RAISE THE DEAD', { how: 'ON FOOT, PRESS {summon}.' }),
      nudge('RAISE THE DEAD'),
      on('summoned'),
    ],
    next: 'possess',
  },
  possess: {
    parts: [
      hold(2.5),
      text('POSSESS ONE IN THE DECK. GET IT OUT. NOT THROUGH THE GATE.', { until: possessing }),
      goal('{interact} POSSESS A CAR IN THE DECK', {
        how: 'WALK UP TO A CAR PARKED IN THE DECK. {interact} POSSESS.',
        marks: markDeckCar,
      }),
      nudge('POSSESS A CAR IN THE DECK'),
      on('entered', (_c, e) => e.possessed),
    ],
    next: 'escape',
  },
  escape: {
    parts: [
      hold(4.5),
      text('WALLS BREAK. KICKERS JUMP.', { doing: true }),
      goal('GET IT OUT. NOT THE GATE.', { how: 'SMASH THROUGH A WALL OR JUMP A KICKER.' }),
      nudge('GET IT OUT'),
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
      free,
      act((c) => c.rememberFirstNight()),
      text("THAT'S ANOTHER ONE. KEEP 'EM COMING TILL SUNRISE."),
      on('sunrise'),
    ],
    next: 'morning',
  },
  morning: {
    parts: [
      act((c) => c.showDayPresentation()),
      hold(10),
      text("MORNING. DAY JOB NOW: THE DECK NEEDS CARS TO PHANTOM. STREET'S FULL OF 'EM. TAKE ONE.", {
        until: (c) => !!riding(c) && riding(c) !== c.pickup,
      }),
      goal('{interact} STEAL A CAR', {
        how: 'WALK UP TO ANY CAR. {interact} STEAL. PARKED ONES NEED {pay}.',
      }),
      nudge('STEAL A CAR'),
      on('entered', (c, e) => !e.possessed && e.v !== c.pickup),
    ],
    next: 'gate',
  },
  gate: {
    parts: [
      hold(12),
      text('BRING IT IN THE EAST GATE. GATE LOGS IT IN. NO BADGE NEEDED FOR THAT PART, HA.', {
        doing: true,
      }),
      goal('DRIVE IN THROUGH THE EAST GATE', {
        how: 'DRIVE UP TO THE EAST GATE AND THROUGH IT.',
        marks: markGate,
      }),
      nudge('BRING IT IN THE EAST GATE'),
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
      text('PARK IT UPSTAIRS AND GET OUT. WHAT YOU LOG IN BY DAY, YOU PHANTOM OUT BY NIGHT.', {
        doing: true,
      }),
      goal('PARK IN A FREE SPOT, {interact} GET OUT', {
        how: 'STOP INSIDE A FREE SPOT, THEN {interact} GET OUT.',
      }),
      nudge('PARK IT AND GET OUT'),
      on('exited', (_c, e) => e.spot !== null),
    ],
    next: 'tonight',
  },
  tonight: {
    parts: [hold(16), act((c) => c.startErrand()), text('GOOD. COME 7, PHANTOM IT OUT.', { done: true })],
    next: 'night2',
  },
  night2: {
    parts: [
      sweep(19, SWEEP, 22),
      text('POSSESS ONE. GET IT OUT.', { doing: true }),
      goal((c) => (possessing(c) ? 'GET IT OUT. NOT THE GATE.' : '{interact} POSSESS A CAR IN THE DECK'), {
        how: (c) =>
          possessing(c)
            ? 'SMASH THROUGH A WALL OR JUMP A KICKER.'
            : 'WALK UP TO A CAR PARKED IN THE DECK. {interact} POSSESS.',
        marks: markDeckCar,
      }),
      nudge('POSSESS ONE AND GET IT OUT'),
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
      text("THAT'S THE WHOLE RACKET. THIRTY PHANTOMS AND THE DECK'S OURS. BRISKET OFFER STANDS.", {
        done: true,
      }),
    ],
    next: null,
  },
};

export const ERRAND: Beats<TutorialContext, TutorialEvent, ErrandId> = {
  cooled: {
    parts: [
      text('KEYS COOLED OFF. SWING BY.'),
      mark((c) => [{ id: 'tutorial-keys', label: 'RANDY', kind: 'optional', at: c.randy.pos }]),
      talkToRandy,
      on('talk'),
    ],
    next: 'handed',
  },
  handed: {
    parts: [faceCody, say(toldYou)],
    next: null,
  },
};

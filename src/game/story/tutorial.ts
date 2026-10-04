import { type Mesh, type Object3D, Raycaster, Vector3 } from 'three';

import type { Npc } from '@/actors/npcs/npcs';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import { TUNING } from '@/config';
import { type EventOf, Mind, mind, type MindEvent, type State, type StateOf } from '@/engine/sim/mind';
import { el } from '@/engine/ui/dom';
import { type CodyAction, ScriptedOffer } from '@/game/cody/cody-actions';
import type { VehicleAccess } from '@/game/cody/cody-ride';
import { type Crossing, type Garage, spotLabel, type SpotRuntime } from '@/game/deck/garage';
import type { CamMode, Cutscene, Game } from '@/game/game';
import { GameClock } from '@/game/game-clock';
import type { StockSlot } from '@/game/items/stock';
import { ISO_ELEVATION } from '@/render/iso-camera';
import { Dialogue, type DialogueLine } from '@/ui/dialogue';
import type { Phone } from '@/ui/phone/phone';
import { Signpost } from '@/ui/signpost';
import { wantsTouch } from '@/ui/touch-controls';
import type { LevelData, RampDef } from '@/world/level-data';

import type { Objective } from './objectives';

/** Persist completion when the phantom-rules lesson begins or the tutorial is skipped. */
const DONE_KEY = '30pc.tutorial';
/** Opening time in game hours. The roof conversation pauses the clock, leaving 90 game minutes before nightfall. */
const START_HOUR = 17.5;
/** Delays in seconds from Randy’s departure to his call and from hangup to the return-to-truck text. */
const SORRY_AFTER = 3;
const TEXT_AFTER = 3;
/**
 * Opening placement distances in meters: minimum and preferred ramp approach, Randy’s offsets from the spot, and badge
 * landing distance beyond the deck edge.
 */
const MIN_RUN = 9;
const RUN_UP = 14;
const RANDY_AHEAD = 1.1;
const RANDY_SIDE = 1.2;
const TOSS_PAST = 12;
/** Conversation focus height in meters, isometric zoom, and dialogue start delay in seconds. */
const TALK_HEIGHT = 1.2;
const TALK_ZOOM = 12;
const TALK_DELAY = 1;
/** Throw camera zoom and hold duration after the expected landing, in seconds. */
const THROW_ZOOM = 24;
const THROW_HOLD = 1.5;
/** Haunting emergence duration at the first moonrise, in seconds. */
const EMERGE = 3;
/** Post-jump idle threshold in m/s, required idle duration in seconds, and maximum wait before Randy calls. */
const IDLE_SPEED = 0.5;
const IDLE_FOR = 2;
const LANDING_MAX = 12;
/** Maximum landing wait in seconds, imprint camera zoom, sign height in meters, and sign timeout in seconds. */
const IMPRINT_LAND = 3;
const IMPRINT_ZOOM = 16;
const IMPRINT_SIGN = 2.4;
const IMPRINT_HOLD = 15;
/** Camera focus height above the imprint, in meters, leaving screen space for its sign. */
const IMPRINT_ABOVE = 5;
/** Call time in game hours and ringing delay in seconds. */
const CALL_HOUR = 22;
const RING = 1.6;
/** Basement conversation range in meters and camera zoom. */
const TALK_REACH = 3.6;
const BASEMENT_ZOOM = 10;
/** Joyride hint delays in seconds for keyboard camera controls and collecting the first ghost. */
const CAMERA_HINT = 5;
const GHOST_HINT = 14;
/** Basement dialogue used when Cody has no tires; returning to the task suppresses its repeated text. */
const NO_WHEELS: readonly DialogueLine[] = [
  { who: 'left', say: 'NO WHEELS? GO GET ME SOME.' },
  { who: 'left', say: 'SMASH SOMETHING. THEY FALL OFF.' },
];
/** Post-jump call introducing the first phantom before the imprint cutscene. */
const TELL: readonly DialogueLine[] = [
  { who: 'left', say: 'OH YEAH! I NEED TO TELL YOU...' },
  { who: 'left', say: "THAT SPOT YOU PULLED OUT OF? THE GARAGE THINKS YOU'RE STILL PARKED IN IT." },
  { who: 'left', say: 'TAKE A LOOK.' },
];
/** Number of keyboard camera modes required by the camera lesson. */
const CAMERA_MODES = 3;
/** Shared GhASt markup with reduced h and t characters. */
const GHAST = '<span class="ghast-word">G<small>h</small>AS<small>t</small></span>';
/** Phantom-rules display duration and fallback timeout for the fright lesson, in seconds. */
const LESSON = 9;
const SPOOK_WAIT = 45;
/** Delay before closing the phone after the final text, in seconds. */
const DONE_WAIT = 9;
/** Stable objective IDs for the pickup and optional badge markers. */
const TRUCK_MARK = 'tutorial-truck';
const BADGE_MARK = 'tutorial-badge';
/** Objective ID for Randy’s basement marker. */
const RANDY_MARK = 'tutorial-randy';

const _fwd = new Vector3();
const _side = new Vector3();
const _toCamera = new Vector3();
const _sign = new Vector3();

/** Tutorial states in story order, with timers and resources retained by each step. */
type TutorialState =
  /** Tutorial inactive or skipped. */
  | State<'off'>
  /** Roof conversation, including its start delay and scene resources. */
  | State<'scene', { t: number; talking: boolean; camera?: Cutscene; release?: () => void }>
  /** Cody searches for the badge after leaving the pickup. */
  | State<'out'>
  /** Wait after Randy’s moonrise departure. */
  | State<'gone', { t: number }>
  /** Ring and play Randy’s departure call. */
  | State<'sorry', { t: number; talking: boolean }>
  /** Wait before the return-to-truck text. */
  | State<'hangup', { t: number }>
  | State<'back'>
  | State<'hotwire'>
  | State<'jump'>
  /** Wait for the truck to settle while retaining the first imprint details. */
  | State<'landing', { t: number; idle: number; imprint: Imprint }>
  /** Play the call introducing the imprint. */
  | State<'tell', { t: number; talking: boolean; imprint: Imprint }>
  /** Display the imprint cutscene and dismissible sign. */
  | State<'imprint', { t: number; shown: boolean; imprint: Imprint; release?: () => void }>
  /** Track camera and GhASt lessons during the joyride. */
  | State<
      'cruise',
      { t: number; cameras: Set<CamMode> | null; ghast: { hinted: boolean; fed: boolean; burned: boolean } }
    >
  /** Play the scheduled basement invitation call. */
  | State<'call', { t: number; talking: boolean }>
  | State<'basement', { quiet?: boolean }>
  | State<'noWheels', { release?: () => void }>
  /** Play the tire handover and brisket scene. */
  | State<'brisket', { release?: () => void }>
  | State<'outside'>
  | State<'rules', { t: number }>
  | State<'spook', { t: number }>
  | State<'raise'>
  /** Wait for possession; `quiet` suppresses the repeated introductory text. */
  | State<'possess', { quiet: boolean }>
  | State<'escape'>
  | State<'rest'>
  | State<'steal'>
  | State<'badge'>
  | State<'park'>
  | State<'tonight'>
  | State<'done', { t: number }>
  /** Tutorial complete. */
  | State<'over'>;

type Step = TutorialState['at'];

interface TutorialSettings {
  randyTalk: boolean;
  trades: boolean;
  skipAfterEating: boolean;
  keepEscaped: boolean;
  vehicleAccess: VehicleAccess;
}

interface SceneOptions {
  camera?: Cutscene;
  randyFace?: Vector3 | null;
  pauseClock?: boolean;
}

/** First imprint position and sign content. */
interface Imprint {
  at: Vector3;
  title: string;
  meta: string;
}

/** Dialogue identifiers used to route completion events. */
type Talk = 'script' | 'sorry' | 'tell' | 'call' | 'noWheels' | 'brisket';

/** Game events and local dialogue/sign completion events consumed by the tutorial. */
type TutorialEvent =
  | MindEvent<'entered', { v: Vehicle; possessed: boolean }>
  | MindEvent<'crossing', { crossing: Crossing }>
  | MindEvent<'swallowed'>
  | MindEvent<'boosted'>
  | MindEvent<'summoned'>
  | MindEvent<'camera', { mode: CamMode }>
  | MindEvent<'phantom', { imprint: Imprint }>
  | MindEvent<'spooked'>
  | MindEvent<'exited', { spot: SpotRuntime | null }>
  | MindEvent<'nightfall'>
  | MindEvent<'sunrise'>
  /** Report completion of a named tutorial dialogue. */
  | MindEvent<'talked', { which: Talk }>
  /** Report dismissal of the imprint sign. */
  | MindEvent<'signed'>;

/** Steps that suppress the normal sleep effect of eating brisket. */
const STORY: ReadonlySet<Step> = new Set<Step>([
  'scene',
  'out',
  'gone',
  'sorry',
  'hangup',
  'back',
  'hotwire',
  'jump',
  'landing',
  'tell',
  'imprint',
  'cruise',
  'call',
  'basement',
  'noWheels',
  'brisket',
  'outside',
  'rules',
  'spook',
  'raise',
]);

/** Steps with task or text entries in STEPS. */
type Texted = Exclude<
  Step,
  | 'off'
  | 'scene'
  | 'out'
  | 'gone'
  | 'sorry'
  | 'hangup'
  | 'landing'
  | 'tell'
  | 'imprint'
  | 'call'
  | 'noWheels'
  | 'brisket'
  | 'over'
>;

/** Sunrise advances the opening story and phantom lessons to the day job. */
const FIRST_NIGHT: ReadonlySet<Step> = new Set<Step>([...STORY, 'possess', 'escape', 'rest']);

/** Task and opening text for each texted step. Control placeholders are rendered as key caps; null omits that content. */
const STEPS: Readonly<Record<Texted, { goal: string | null; text: string | null }>> = {
  back: {
    goal: '{interact} GET BACK IN THE PICKUP',
    text: "SEVEN O'CLOCK, KID. GET IN YOUR PICKUP. YOU'RE GONNA HOTWIRE IT.",
  },
  hotwire: { goal: '{pay} HOTWIRE YOUR PICKUP', text: null },
  jump: {
    goal: '{forward} UP THE RAMP. OFF THE ROOF.',
    text: 'NO BADGE, NO GATE. PULL OUT, HANG A {turn}, FLOOR IT UP THAT RAMP.',
  },
  cruise: {
    goal: 'TAKE IT FOR A SPIN',
    text: "HEH. NO SWIPE OUT, NO EXIT ON THE LOG. TRUCK'S YOURS TONIGHT, KID. ENJOY.",
  },
  basement: {
    goal: 'FIND TIRES. GIVE THEM TO RANDY.',
    text: 'BASEMENT. UNDER THE DECK, BY THE STAIRS. AND BRING WHEELS.',
  },
  outside: { goal: 'GO BACK OUT INTO THE MOONLIGHT', text: null },
  rules: {
    goal: null,
    text: "BAM. PHANTOM CODY. AT NIGHT YOU CAN'T STEAL CARS. YOU POSSESS 'EM, AND ONLY INSIDE THE HAUNTED DECK.",
  },
  spook: {
    goal: 'SPOOK SOMEBODY',
    text: "PEOPLE SPOOK EASY NOW. SCARE A DRIVER AND THEY'LL BOLT RIGHT INTO THE DECK.",
  },
  raise: {
    goal: '{summon} RAISE THE DEAD (TILL SUNRISE)',
    text: "LONG AS IT'S DARK, YOU CAN RAISE THE DEAD. GO ON. THEY OWE YOU. SUN COMES UP, THEY'RE DUST.",
  },
  steal: {
    goal: '{interact} STEAL A CAR',
    text: "MORNING. DAY JOB NOW: THE DECK NEEDS CARS TO PHANTOM. STREET'S FULL OF 'EM. TAKE ONE.",
  },
  badge: {
    goal: 'DRIVE IN THROUGH THE EAST GATE',
    text: 'BRING IT IN THE EAST GATE. GATE LOGS IT IN. NO BADGE NEEDED FOR THAT PART, HA.',
  },
  park: {
    goal: 'PARK IN A FREE SPOT, {interact} GET OUT',
    text: 'PARK IT UPSTAIRS AND GET OUT. WHAT YOU LOG IN BY DAY, YOU PHANTOM OUT BY NIGHT.',
  },
  tonight: { goal: 'WAIT FOR NIGHT', text: 'GOOD. COME 7, PHANTOM IT OUT.' },
  possess: {
    goal: '{interact} POSSESS A CAR IN THE DECK',
    text: 'ANY CAR PARKED IN THE DECK. POSSESS IT, THEN GET IT OUT. NOT THROUGH THE GATE.',
  },
  escape: {
    goal: 'GET IT OUT. NOT THROUGH THE GATE',
    text: 'NOW GET IT OUT. NOT THE GATE. WALLS BREAK. KICKERS JUMP.',
  },
  rest: { goal: null, text: "THAT'S ANOTHER ONE. KEEP 'EM COMING TILL SUNRISE." },
  done: {
    goal: null,
    text: "THAT'S THE WHOLE RACKET. THIRTY PHANTOMS AND THE DECK'S OURS. BRISKET OFFER STANDS.",
  },
};

/** Calculated positions and directions for the roof opening. */
interface Stage {
  /** Selected parking spot and initial pickup pose. */
  spot: SpotRuntime;
  truck: Vector3;
  yaw: number;
  /** Turn direction from the parking spot toward the ramp approach. */
  turn: 'LEFT' | 'RIGHT';
  /** Randy’s pose and the pickup window used as his look target. */
  randy: Vector3;
  randyYaw: number;
  window: Vector3;
  /** Badge landing position on the street. */
  toss: Vector3;
}

/** Resume possession lessons if nightfall interrupts the daytime parking task. */
const nightJob = (): StateOf<TutorialState, 'possess'> => ({ at: 'possess', quiet: false });

/**
 * Run the tutorial through state-driven dialogue, cutscenes, objectives, and phone messages, beginning at 5:30 PM on
 * the roof. Remember completion when the phantom-rules lesson begins or the player skips it; the title offers replay.
 * Each transition updates rules and markers and emits a quest step event.
 */
export class Tutorial {
  /** Whether to start the tutorial on the next game start. */
  private wanted = !remembered(DONE_KEY);
  private active = false;
  private readonly dialogue: Dialogue;
  /** Game-owned phone used for tutorial calls and messages. */
  private get phone(): Phone {
    return this.game.phone;
  }
  private readonly sign: Signpost;
  private randy: Npc | null = null;
  private truck: Vehicle | null = null;
  private stage: Stage | null = null;
  /** Mutable camera focus shared by conversation scenes. */
  private readonly talkFocus = new Vector3();
  /** Remaining badge-follow camera time in seconds and its current focus point. */
  private throwCam: number | null = null;
  private readonly throwFocus = new Vector3();
  /** Camera preference to restore after the jump, unless the player changes it. */
  private cam: CamMode | null = null;
  /** Badge collection state and cancellation callback for its trigger. */
  private badgeFound = false;
  private badgeGot: (() => void) | null = null;
  private settings: TutorialSettings | null = null;
  private holdingCody = false;
  private moltenKeys: StockSlot | null = null;
  private readonly steps = mind<Tutorial, TutorialState, TutorialEvent>({
    off: {},
    scene: {
      enter: (t, s) => {
        s.camera = { focus: t.talkFocus, zoom: TALK_ZOOM };
        s.release = t.takeScene({ camera: s.camera, randyFace: t.stage?.window, pauseClock: true });
      },
      exit: (t, s) => {
        s.release?.();
        t.throwCam = null;
      },
      tick: (t, s, dt) => {
        s.t += dt;

        if (t.throwCam !== null) {
          t.followThrow(s, dt);
        }

        if (s.t > TALK_DELAY && !s.talking && !t.dialogue.open) {
          s.talking = true;
          t.play('script', t.script());
        }

        return null;
      },
      on: {
        talked: (_t, _s, { which }) => (which === 'script' ? { at: 'out' } : null),
        nightfall: (t) => t.moonrise(),
      },
    },
    out: {
      enter: (t) => t.game.alight(),
      on: {
        nightfall: (t) => t.moonrise(),
        entered: (t, s, e) => t.boardedBeforeJump(s.at, e),
      },
    },
    gone: {
      tick: (_t, s, dt) => ((s.t += dt) > SORRY_AFTER ? { at: 'sorry', t: 0, talking: false } : null),
      on: { entered: (t, s, e) => t.boardedBeforeJump(s.at, e) },
    },
    sorry: {
      enter: (t) => t.phone.call(),
      exit: (t) => t.endCall(),
      tick: (t, s, dt) => {
        if ((s.t += dt) > RING && !s.talking && !t.dialogue.open) {
          s.talking = true;
          t.play('sorry', t.sorry());
        }

        return null;
      },
      on: {
        talked: (_t, _s, { which }) => (which === 'sorry' ? { at: 'hangup', t: 0 } : null),
        entered: (t, s, e) => t.boardedBeforeJump(s.at, e),
      },
    },
    hangup: {
      tick: (_t, s, dt) => ((s.t += dt) > TEXT_AFTER ? { at: 'back' } : null),
      on: { entered: (t, s, e) => t.boardedBeforeJump(s.at, e) },
    },
    back: {
      enter: (t) => t.arrive('back'),
      on: { entered: (t, s, e) => t.boardedBeforeJump(s.at, e) },
    },
    hotwire: {
      on: {
        entered: (t, _s, e) => t.boardedBeforeJump('back', e),
        exited: () => ({ at: 'back' }),
      },
    },
    jump: {
      enter: (t) => t.arrive('jump'),
      tick: (t) => {
        // Reveal the ledger as the truck becomes airborne above the roof.
        const v = t.truck;
        if (v && t.stage && !v.grounded && v.pos.y > t.stage.truck.y + 0.5) {
          t.game.hud.showLedger(true);
        }

        return null;
      },
      on: {
        crossing: (t, _s, { crossing }) => {
          // Ensure the ledger is visible when an unlogged exit creates the first phantom.
          if (crossing.kind === 'escaped') {
            t.game.hud.showLedger(true);
          } else if (crossing.kind === 'logged-out') {
            t.text('NOT THE GATE, KID. THE GATE SAW THAT. SNEAK IT BACK IN AND GO OFF A KICKER.');
          }

          return null;
        },
        // Wait for landing and the explanatory call before showing the imprint.
        phantom: (_t, _s, { imprint }) => ({ at: 'landing', t: 0, idle: 0, imprint }),
      },
    },
    landing: {
      tick: (t, s, dt) => {
        s.t += dt;
        const v = t.truck;
        s.idle = v && v.grounded && Math.hypot(v.vel.x, v.vel.z) < IDLE_SPEED ? s.idle + dt : 0;

        return s.idle > IDLE_FOR || s.t > LANDING_MAX ? { at: 'tell', t: 0, talking: false, imprint: s.imprint } : null;
      },
    },
    tell: {
      enter: (t) => t.phone.call(),
      exit: (t) => t.endCall(),
      tick: (t, s, dt) => {
        if ((s.t += dt) > RING && !s.talking && !t.dialogue.open) {
          s.talking = true;
          t.play('tell', TELL);
        }

        return null;
      },
      on: {
        talked: (_t, s, { which }) =>
          which === 'tell' ? { at: 'imprint', t: 0, shown: false, imprint: s.imprint } : null,
      },
    },
    imprint: {
      exit: (_t, s) => s.release?.(),
      tick: (t, s, dt) => {
        s.t += dt;
        t.showImprint(s);
        return null;
      },
      on: {
        signed: () => ({ at: 'cruise', t: 0, cameras: null, ghast: { hinted: false, fed: false, burned: false } }),
      },
    },
    cruise: {
      enter: (t) => t.arrive('cruise'),
      tick: (t, s, dt) => {
        s.t += dt;
        const g = t.game;
        if (!s.cameras && s.t > CAMERA_HINT && !wantsTouch()) {
          s.cameras = new Set([g.cameraMode]);
          t.text("{camera} SWITCHES THE CAMERA. TRY 'EM ALL.");
        } else if (!s.ghast.hinted && !s.ghast.fed && s.t > GHOST_HINT) {
          s.ghast.hinted = true;
          t.text("SEE THEM GHOSTS? DRIVE RIGHT THROUGH 'EM.");
        } else if (!g.clock.isDay && g.clock.hours >= CALL_HOUR) {
          return { at: 'call', t: 0, talking: false };
        }

        return null;
      },
      on: {
        // Teach collection before acknowledging the first boost.
        swallowed: (t, s) => {
          if (s.ghast.fed) {
            return null;
          }

          s.ghast.fed = true;
          t.text(`FEEL THAT? GHOSTS IN THE TANK. THAT'S ${GHAST}. HOLD {boost} TO BURN IT.`);
          return null;
        },
        boosted: (t, s) => {
          if (!s.ghast.fed || s.ghast.burned) {
            return null;
          }

          s.ghast.burned = true;
          t.text('HA! SOUL POWER.');
          return null;
        },
        camera: (t, s, { mode }) => {
          if (!s.cameras || s.cameras.size >= CAMERA_MODES) {
            return null;
          }

          s.cameras.add(mode);

          if (s.cameras.size >= CAMERA_MODES) {
            t.text('THERE YOU GO. PICK ONE YOU LIKE.');
          }

          return null;
        },
      },
    },
    call: {
      enter: (t) => t.phone.call(),
      exit: (t) => t.endCall(),
      tick: (t, s, dt) => {
        if ((s.t += dt) > RING && !s.talking && !t.dialogue.open) {
          s.talking = true;
          t.play('call', t.call());
        }

        return null;
      },
      on: { talked: (_t, _s, { which }) => (which === 'call' ? { at: 'basement' } : null) },
    },
    basement: {
      enter: (t, s) => t.arrive('basement', !s.quiet),
    },
    noWheels: {
      enter: (t, s) => {
        s.release = t.takeScene({ randyFace: null });
        t.play('noWheels', NO_WHEELS);
      },
      exit: (_t, s) => s.release?.(),
      on: { talked: (_t, _s, { which }) => (which === 'noWheels' ? { at: 'basement', quiet: true } : null) },
    },
    brisket: {
      enter: (t, s) => t.sitDown(s),
      exit: (_t, s) => s.release?.(),
      on: { talked: (_t, _s, { which }) => (which === 'brisket' ? { at: 'outside' } : null) },
    },
    outside: {
      enter: (t) => t.arrive('outside'),
      tick: (t) => {
        const g = t.game;
        if (!g.player.visible || g.garage.inFootprint(g.player.pos) || g.player.pos.y <= -1) {
          return null;
        }

        // Resume normal form changes after Cody leaves the basement and deck.
        t.releaseCody();
        g.hud.toast('BAM.', 'PHANTOM CODY', '', 2.6);
        t.dialogue.setPortrait('right', g.portraits.codyNight);
        return { at: 'rules', t: 0 };
      },
    },
    rules: {
      enter: (t) => t.arrive('rules'),
      tick: (_t, s, dt) => ((s.t += dt) > LESSON ? { at: 'spook', t: 0 } : null),
    },
    spook: {
      enter: (t) => t.arrive('spook'),
      // Advance on a fright event or after the timeout.
      tick: (_t, s, dt) => ((s.t += dt) > SPOOK_WAIT ? { at: 'raise' } : null),
      on: { spooked: () => ({ at: 'raise' }) },
    },
    raise: {
      enter: (t) => t.arrive('raise'),
      // Advance only on a successful summon event, since an input press can fail.
      on: { summoned: () => ({ at: 'possess', quiet: false }) },
    },
    possess: {
      enter: (t, s) => t.arrive('possess', !s.quiet),
      on: { entered: (_t, _s, { possessed }) => (possessed ? { at: 'escape' } : null) },
    },
    escape: {
      enter: (t) => t.arrive('escape'),
      on: {
        crossing: (t, _s, { crossing }) => {
          if (crossing.kind === 'escaped') {
            return t.game.clock.day === 1 ? { at: 'rest' } : { at: 'done', t: 0 };
          }

          if (crossing.kind !== 'logged-out' || crossing.vehicle.form !== 'truck') {
            return null;
          }

          t.text('NOT THE GATE, KID. THE GATE SEES EVERYTHING. GRAB ANOTHER ONE.');
          return { at: 'possess', quiet: true };
        },
      },
    },
    rest: {
      enter: (t) => t.arrive('rest'),
    },
    steal: {
      enter: (t) => {
        t.wake();
        t.arrive('steal');
      },
      on: { entered: (_t, _s, { possessed }) => (possessed ? null : { at: 'badge' }), nightfall: nightJob },
    },
    badge: {
      enter: (t) => t.arrive('badge'),
      on: {
        crossing: (t, _s, { crossing }) => {
          if (crossing.kind === 'logged-in') {
            return { at: 'park' };
          }

          if (crossing.kind === 'snuck-in') {
            t.text('NO GATE? CUTE. THE GATE IS HOW IT COUNTS. BACK OUT, COME IN THE EAST GATE.');
          }

          return null;
        },
        nightfall: nightJob,
      },
    },
    park: {
      enter: (t) => t.arrive('park'),
      on: { exited: (_t, _s, { spot }) => (spot ? { at: 'tonight' } : null), nightfall: nightJob },
    },
    tonight: {
      enter: (t) => t.arrive('tonight'),
      on: { nightfall: nightJob },
    },
    done: {
      enter: (t) => t.arrive('done'),
      tick: (_t, s, dt) => {
        if ((s.t += dt) <= DONE_WAIT) {
          return null;
        }

        return { at: 'over' };
      },
    },
    over: { enter: (t) => t.finish() },
  });

  private readonly quest: Mind<Tutorial, TutorialState, TutorialEvent>;

  /** Whether this run is active. game/save.ts uses this to suppress normal progress restoration and writes. */
  get running(): boolean {
    return this.active;
  }

  constructor(
    private readonly game: Game,
    private readonly level: LevelData,
  ) {
    this.dialogue = new Dialogue({ left: 'RANDY ROLSEN', right: 'CODY' }, game.input.focus);
    this.sign = new Signpost(game.hud.root, game.input.focus);
    this.quest = new Mind<Tutorial, TutorialState, TutorialEvent>(
      this.steps,
      this,
      { at: 'off' },
      {
        on: {
          // Move unfinished first-night lessons to the daytime parking task at sunrise.
          sunrise: (_t, s) => (FIRST_NIGHT.has(s.at) ? { at: 'steal' } : null),
        },
        moved: (t, _from, to) => {
          t.applyRules(to.at);
          t.show();
          t.game.events.emit('step', { quest: 'tutorial', step: to.at });
        },
      },
    );
    this.titleLink();
    game.addOffer(() => this.randyOffer());
    const ev = game.events;
    const send = (event: TutorialEvent): void => {
      if (this.active) {
        this.quest.send(event);
      }
    };

    ev.on('start', () => this.begin());
    ev.on('frame', (dt) => this.frame(dt));
    ev.on('entered', ({ v, possessed }) => send({ type: 'entered', v, possessed }));
    ev.on('crossing', (crossing) => send({ type: 'crossing', crossing }));
    ev.on('swallowed', () => send({ type: 'swallowed' }));
    ev.on('boosted', () => send({ type: 'boosted' }));
    ev.on('summoned', () => send({ type: 'summoned' }));
    ev.on('camera', (mode) => {
      // Preserve the player’s new camera choice instead of restoring the pre-jump mode.
      this.cam = null;
      send({ type: 'camera', mode });
    });
    ev.on('phantom', ({ at, spot, n, hours, day }) => {
      const title = n === 1 ? '1ST PHANTOM' : `PHANTOM #${n}`;
      const meta = `${spot ? `${spotLabel(spot)}. ` : ''}${GameClock.format(hours)}, NIGHT ${day}`;
      send({ type: 'phantom', imprint: { at: at.clone(), title, meta } });
    });
    ev.on('spooked', () => send({ type: 'spooked' }));
    ev.on('exited', ({ spot }) => {
      // Restore the pre-jump camera when Cody exits, unless already superseded.
      this.giveCamera();
      send({ type: 'exited', spot });
    });
    ev.on('nightfall', () => send({ type: 'nightfall' }));
    ev.on('sunrise', () => send({ type: 'sunrise' }));
  }

  /** Add the title’s skip/replay toggle. The click also reaches the title’s game-start handler. */
  private titleLink(): void {
    const title = document.querySelector<HTMLElement>('.hud-title');
    if (!title) {
      return;
    }

    const link = el('div', 'title-tut', title, this.wanted ? 'SKIP TUTORIAL' : 'REPLAY TUTORIAL');
    link.addEventListener('click', () => {
      this.wanted = !this.wanted;

      if (!this.wanted) {
        remember(DONE_KEY);
      }
    });
  }

  /** Start the roof scene when requested and when Randy and a suitable layout are available. */
  private begin(): void {
    const g = this.game;
    this.randy = g.npcs.find('randy');
    this.stage = stageOn(this.level, g.garage, (x, z) => g.world.collision.groundAt(x, z, 2, 0));

    if (!this.wanted || !this.randy || !this.stage) {
      return;
    }

    this.active = true;
    this.settings = {
      randyTalk: g.randyTalk.enabled,
      trades: g.trades.enabled,
      skipAfterEating: g.skipAfterEating,
      keepEscaped: g.keepEscaped,
      vehicleAccess: g.vehicleAccess,
    };
    // Reserve Randy’s dialogue for tutorial scenes.
    g.randyTalk.enabled = false;
    const r = this.randy;
    const st = this.stage;
    const { randy, cody } = g.portraits;
    this.dialogue.setPortrait('left', randy);
    this.dialogue.setPortrait('right', cody);
    this.phone.setAvatar(randy);
    g.hud.clearToasts();
    g.hud.showLedger(false);
    g.haunt(false);
    // Hold Cody’s daytime form until he leaves the basement, while granting possession and truck driving.
    g.cody.hold('truck', 'possess');
    this.holdingCody = true;
    g.skipAfterEating = false;
    g.clock.hours = START_HOUR;
    // Register the opening pickup as already parked and logged in.
    const truck = g.park(st.truck, st.yaw, 'pickup');
    truck.plate = '30-CODY-01';
    g.garage.checkIn(st.spot, truck);
    g.board(truck, true);
    this.truck = truck;
    r.place(st.randy, st.randyYaw);
    r.prop('burner').visible = false;
    this.talkFocus
      .addVectors(st.window, st.randy)
      .multiplyScalar(0.5)
      .setY(st.randy.y + TALK_HEIGHT);
    // Sample the pickup and speakers to choose the least-obstructed isometric view.
    _fwd.set(Math.sin(st.yaw), 0, Math.cos(st.yaw));
    _side.set(_fwd.z, 0, -_fwd.x);
    const sights: Vector3[] = [];
    for (const along of [-2.2, 0, 2.2]) {
      for (const across of [-1, 0, 1]) {
        for (const up of [0.6, 1.4]) {
          sights.push(
            st.truck
              .clone()
              .addScaledVector(_fwd, along)
              .addScaledVector(_side, across)
              .setY(st.truck.y + up),
          );
        }
      }
    }

    sights.push(st.randy.clone().setY(st.randy.y + 1.4), this.talkFocus);
    g.iso.azimuth = g.iso.azimuthTarget = clearView(g.world.root, sights, g.iso.azimuth);
    g.iso.snapTo(this.talkFocus);
    this.throwCam = null;
    this.badgeGot?.();
    this.badgeFound = false;
    this.badgeGot = g.triggers.on({ got: 'badge' }, () => {
      this.badgeFound = true;
      this.badgeGot = null;
    });
    this.quest.go({ at: 'scene', t: 0, talking: false });
    this.show();
  }

  private frame(dt: number): void {
    if (!this.active) {
      return;
    }

    this.quest.tick(dt);
    this.show();
  }

  /** Send optional opening text and persist completion when the phantom-rules lesson begins. */
  private arrive(step: Texted, say = true): void {
    const s = STEPS[step];
    if (say && s.text) {
      this.text(s.text);
    }

    if (step === 'rules') {
      this.wanted = false;
      remember(DONE_KEY);
    }
  }

  /** Return the task text for the current state. */
  private goalOf(s: TutorialState): string | null {
    switch (s.at) {
      case 'out':
      case 'gone':
      case 'sorry':
      case 'hangup':
        return 'FIND YOUR BADGE';
      case 'cruise':
        return this.cruiseGoal(s);
      case 'noWheels':
      case 'brisket':
        return STEPS.basement.goal;
      case 'off':
      case 'scene':
      case 'landing':
      case 'tell':
      case 'imprint':
      case 'call':
      case 'over':
        return null;
      default:
        return STEPS[s.at].goal;
    }
  }

  /**
   * Build state-specific markers: the uncollected badge, the pickup during the return task, and Randy during the
   * basement errand.
   */
  private marksOf(s: TutorialState): Objective[] {
    const marks: Objective[] = [];
    const looking = s.at === 'out' || s.at === 'gone' || s.at === 'sorry' || s.at === 'hangup' || s.at === 'back';
    // The persistent badge pickup is a copy at the calculated landing position.
    if (looking && !this.badgeFound && this.stage) {
      marks.push({ id: BADGE_MARK, label: 'YOUR BADGE', kind: 'optional', at: this.stage.toss });
    }

    if (s.at === 'back' && this.truck) {
      marks.push({ id: TRUCK_MARK, label: 'YOUR PICKUP', kind: 'primary', at: this.truck.pos });
    }

    if ((s.at === 'basement' || s.at === 'noWheels') && this.randy) {
      marks.push({ id: RANDY_MARK, label: 'RANDY', kind: 'primary', at: this.randy.pos });
    }

    return marks;
  }

  /** Refresh task text and this tutorial’s objective markers from the current state. */
  private show(): void {
    const s = this.quest.state;
    this.game.objectives.goal = this.goalOf(s);
    this.game.objectives.replace(this, this.marksOf(s));
  }

  private text(msg: string): void {
    this.phone.text(msg.replace('{turn}', this.stage?.turn ?? 'RIGHT'));
  }

  /** Send a named completion event when the dialogue finishes. */
  private play(which: Talk, lines: readonly DialogueLine[]): void {
    this.dialogue.play(lines, () => {
      this.quest.send({ type: 'talked', which });
    });
  }

  /** Require the opening pickup's hotwire before its transformation and roof jump. */
  private boardedBeforeJump(
    from: 'out' | 'gone' | 'sorry' | 'hangup' | 'back',
    e: EventOf<TutorialEvent, 'entered'>,
  ): StateOf<TutorialState, 'jump' | 'hotwire'> | null {
    if (e.v !== this.truck) {
      return null;
    }

    if (!e.possessed) {
      return this.game.vehicleAccess === e.v ? { at: 'hotwire' } : null;
    }

    const g = this.game;
    // Possession can arrive before the nightfall event if Cody remained seated.
    if (from === 'out') {
      this.moonrise();
    }

    this.cam = g.cameraMode;
    g.setCamera('chase');
    g.chase.snapBehind(e.v.yaw);
    g.keepEscaped = true;
    return { at: 'jump' };
  }

  /** Build the roof dialogue and synchronize the badge, phone, and key handovers. */
  private script(): DialogueLine[] {
    const g = this.game;
    const r = this.randy as Npc;
    const toss = (this.stage as Stage).toss;
    const coat =
      (open: boolean, phone = false) =>
      (): void => {
        r.send({ type: 'flash', open });
        r.prop('burner').visible = phone;
      };

    return [
      { who: 'right', say: "COME ON... BADGE WON'T SCAN ME OUT AFTER SEVEN." },
      { who: 'right', say: "I'M GONNA BE STUCK UP HERE ALL NIGHT." },
      {
        who: 'left',
        say: 'BADGE TROUBLE, KID? LEMME SEE IT. I KNOW THESE SCANNERS.',
        cue: () => {
          r.prop('badge').visible = true;
        },
      },
      {
        who: 'left',
        say: "AH MAN. YOU DON'T NEED THIS.",
        cue: () => {
          this.throwCam = r.throwing!.throw('badge', toss, { showPath: true }) + THROW_HOLD;
        },
      },
      { who: 'right', say: 'HUH?' },

      {
        who: 'left',
        say: 'BRISKET?',
        cue: () => {
          coat(true)();
          g.waresShown = r;
        },
      },
      { who: 'right', say: 'NO... I NEED MY ID.' },
      { who: 'left', say: 'SUIT YOURSELF.' },
      // Transfer the burner that later calls and messages use.
      {
        who: 'left',
        say: "YOU'RE GOING TO NEED THIS.",
        cue: () => {
          coat(true, true)();
          g.handOver(r, 'burner');
        },
      },
      {
        who: 'narrator',
        say: 'RANDY TAKES YOUR KEYS.',
        cue: () => {
          if (this.truck) {
            this.truck.ignition.take(r.keys);
          }

          g.vehicleAccess = 'none';
        },
      },
      {
        who: 'narrator',
        say: 'OOPS. RANDY DROPS THEM INTO THE FIRE.',
        cue: () => {
          this.truck?.ignition.transfer(r.keys, 'destroyed');

          if (r.fire) {
            r.fire.plume = 1;
          }
        },
      },
      { who: 'left', say: 'YOU CAN HAVE THEM BACK. MIGHT BE A SECOND.' },
      {
        who: 'narrator',
        say: 'RANDY FISHES THE KEYS OUT AND PUTS THEM IN HIS POCKET.',
        cue: () => {
          this.moltenKeys = { id: 'molten-keys', kind: 'moltenKeys', count: 1 };
          r.stock?.slots.push(this.moltenKeys);
        },
      },
      { who: 'left', say: 'YOUR KEYS ARE BURNING A HOLE IN MY POCKET.' },
    ];
  }

  /** Follow the badge through wind-up and flight, hold its landing position, then restore the conversation view. */
  private followThrow(s: StateOf<TutorialState, 'scene'>, dt: number): void {
    const r = this.randy;
    const st = this.stage;
    if (this.throwCam === null || !r || !st || !s.camera) {
      return;
    }

    this.throwCam -= dt;

    // After landing, track the copy’s known position rather than the restored hand rig.
    if (r.throwing?.active) {
      r.prop('badge').getWorldPosition(this.throwFocus);
    } else {
      this.throwFocus.copy(st.toss);
    }

    s.camera.focus = this.throwCam > 0 ? this.throwFocus : this.talkFocus;
    s.camera.zoom = this.throwCam > 0 ? THROW_ZOOM : TALK_ZOOM;

    if (this.throwCam <= 0) {
      this.throwCam = null;
    }
  }

  /** Reveal the haunting and return Randy to his level-defined basement position with a departure puff. */
  private moonrise(): StateOf<TutorialState, 'gone'> {
    const g = this.game;
    const r = this.randy as Npc;
    this.removeMoltenKeys();
    g.vehicleAccess = this.truck ?? 'none';
    g.haunt(true, EMERGE);
    g.puff(r.pos);
    r.place(new Vector3(...r.def.pos), r.def.yaw);
    return { at: 'gone', t: 0 };
  }

  /**
   * After landing or a timeout, focus the first phantom and show its explanatory sign. Update the sign position each
   * frame and dismiss it after its timeout.
   */
  private showImprint(s: StateOf<TutorialState, 'imprint'>): void {
    const g = this.game;
    const im = s.imprint;
    _sign.copy(im.at).setY(im.at.y + IMPRINT_SIGN);

    if (s.shown) {
      if (!this.sign.open) {
        return;
      }

      this.sign.place(g.toScreen(_sign));

      if (s.t > IMPRINT_HOLD) {
        this.sign.dismiss();
      }

      return;
    }

    if (this.truck && !this.truck.grounded && s.t < IMPRINT_LAND) {
      return;
    }

    this.talkFocus.copy(im.at).setY(im.at.y + IMPRINT_ABOVE);
    const sights = [-2, 0, 2].map((d) => im.at.clone().add(_side.set(d, 1, d * 0.3)));
    g.iso.azimuth = g.iso.azimuthTarget = clearView(g.world.root, sights, g.iso.azimuth);
    s.release = this.takeScene({ camera: { focus: this.talkFocus, zoom: IMPRINT_ZOOM } });
    // Clear competing notifications before displaying the sign.
    g.hud.clearToasts();
    s.t = 0;
    s.shown = true;
    this.sign.show(im.title, im.meta, `FILL ALL ${TUNING.garage.spots} SPOTS WITH PHANTOMS.`, () => {
      this.quest.send({ type: 'signed' });
    });
    this.sign.place(null);
  }

  /** Offer the basement conversation when Cody is on foot near Randy and no tutorial dialogue is open. */
  private randyOffer(): CodyAction | null {
    const g = this.game;
    const r = this.randy;
    if (
      !this.quest.in('basement') ||
      !r ||
      this.dialogue.open ||
      !g.player.visible ||
      g.npcs.talkable(g.player.pos, TALK_REACH) !== r
    ) {
      return null;
    }

    return new ScriptedOffer({
      label: 'TALK TO RANDY',
      start: () => this.quest.go({ at: g.inventory.count('tire') ? 'brisket' : 'noWheels' }),
    });
  }

  /** Hold Randy and the camera for the basement conversation. */
  private sitDown(s: StateOf<TutorialState, 'brisket'>): void {
    const g = this.game;
    const r = this.randy;
    if (!r) {
      return;
    }

    this.talkFocus
      .addVectors(r.pos, g.player.pos)
      .multiplyScalar(0.5)
      .setY(r.pos.y + TALK_HEIGHT);
    s.release = this.takeScene({ camera: { focus: this.talkFocus, zoom: BASEMENT_ZOOM }, randyFace: null });
    this.play('brisket', this.brisket(r));
  }

  /** Build the basement dialogue, trading carried tires when present. */
  private brisket(r: Npc): DialogueLine[] {
    const g = this.game;
    const coat = (open: boolean) => (): void => {
      r.send({ type: 'flash', open });
    };

    const lines: DialogueLine[] = [];
    if (g.inventory.count('tire') > 0) {
      lines.push({ who: 'left', say: 'OHHH. NICE WHEELS.', cue: () => void g.trades.give(r, 'tire', g.player.pos) });
    }

    lines.push(
      { who: 'left', say: 'SIT. WARM UP. BRISKET?', cue: coat(true) },
      { who: 'right', say: '...FINE. ONE BITE.', cue: coat(false) },
      { who: 'right', say: "WOW. THAT'S REALLY GOOD." },
      { who: 'right', say: "I'D DESCRIBE IT AS... POSITIVELY TRANSFORMATIVE." },
      { who: 'left', say: 'HEH. GO GET SOME AIR, KID. MOON LOOKS GOOD TONIGHT.' },
    );
    return lines;
  }

  /** Release the tutorial form override, restore escape behavior, reveal the ledger, and return the camera. */
  private wake(): void {
    const g = this.game;
    this.removeMoltenKeys();
    g.vehicleAccess = this.settings?.vehicleAccess ?? 'any';
    this.releaseCody();
    g.keepEscaped = this.settings?.keepEscaped ?? false;
    g.hud.showLedger(true);
    this.giveCamera();
  }

  private removeMoltenKeys(): void {
    const slots = this.randy?.stock?.slots;
    if (slots && this.moltenKeys) {
      const i = slots.indexOf(this.moltenKeys);
      if (i !== -1) {
        slots.splice(i, 1);
      }
    }

    this.moltenKeys = null;
  }

  /** A scene releases its own camera and actors on every exit, including interruptions. */
  private takeScene({ camera, randyFace, pauseClock = false }: SceneOptions): () => void {
    const g = this.game;
    const previousCamera = g.cutscene;
    const paused = g.clock.paused;
    const wares = g.waresShown;
    const r = randyFace !== undefined ? this.randy : null;
    const phone = r?.prop('burner').visible ?? false;
    if (camera) {
      g.cutscene = camera;
    }

    if (pauseClock) {
      g.clock.paused = true;
    }

    if (r) {
      r.send({ type: 'held', face: randyFace ?? null });
    }

    return () => {
      this.dialogue.cancel();
      this.sign.cancel();

      if (camera && g.cutscene === camera) {
        g.cutscene = previousCamera;
      }

      if (pauseClock) {
        g.clock.paused = paused;
      }

      g.waresShown = wares;

      if (r) {
        r.send({ type: 'released' });
        r.prop('burner').visible = phone;
      }
    };
  }

  private endCall(): void {
    this.dialogue.cancel();
    this.phone.endCall();
  }

  private releaseCody(): void {
    if (!this.holdingCody) {
      return;
    }

    this.holdingCody = false;
    this.game.cody.release();
    this.game.transformCody();
  }

  /** Apply trade and phase-skip overrides on every state transition. */
  private applyRules(step: Step): void {
    if (!this.settings) {
      return;
    }

    this.game.trades.enabled = this.settings.trades && step !== 'basement' && step !== 'noWheels' && step !== 'brisket';
    this.game.skipAfterEating = this.settings.skipAfterEating && !STORY.has(step);
  }

  private finish(): void {
    this.wake();
    this.phone.close();
    this.badgeGot?.();
    this.badgeGot = null;

    if (this.settings) {
      this.game.randyTalk.enabled = this.settings.randyTalk;
      this.game.trades.enabled = this.settings.trades;
      this.game.skipAfterEating = this.settings.skipAfterEating;
      this.settings = null;
    }

    this.active = false;
  }

  /** Prioritize the GhASt boost lesson, then camera cycling, then the general joyride task. */
  private cruiseGoal(s: StateOf<TutorialState, 'cruise'>): string | null {
    if (s.ghast.fed && !s.ghast.burned) {
      return `{boost} BURN THE ${GHAST}`;
    }

    if (s.cameras && s.cameras.size < CAMERA_MODES) {
      return `{camera} TRY THE CAMERAS (${s.cameras.size}/${CAMERA_MODES})`;
    }

    return STEPS.cruise.goal;
  }

  /** Restore the saved camera mode unless a later player choice cleared it. */
  private giveCamera(): void {
    if (this.cam === null) {
      return;
    }

    this.game.setCamera(this.cam);
    this.cam = null;
  }

  /** Build Randy’s departure apology call. */
  private sorry(): DialogueLine[] {
    return [
      { who: 'left', say: "IT'S RANDY. SORRY, I HAD TO GO." },
      { who: 'right', say: 'YOU STILL HAVE MY KEYS.' },
      { who: 'left', say: "RIGHT. YOU'LL HAVE TO HOTWIRE YOUR PICKUP." },
      { who: 'left', say: 'GET IN. JOIN THE IGNITION WIRES, THEN TOUCH THE STARTER WIRE TO THEM.' },
      { who: 'left', say: 'PARKED CARS WORK THE SAME WAY. TAKE ONE WITH A DRIVER AND THE KEYS ARE ALREADY IN IT.' },
    ];
  }

  /** Build Randy’s scheduled basement invitation. */
  private call(): DialogueLine[] {
    return [
      { who: 'left', say: "KID. IT'S RANDY. NICE JUMP." },
      { who: 'left', say: 'MEET ME IN THE BASEMENT. AND BRING WHEELS.' },
      { who: 'right', say: 'UH... OK.' },
    ];
  }
}

/**
 * Calculate the scene layout for the opening tutorial. Select the roof ramp nearest the exit gate, then find a free
 * parking spot aligned with its approach. Require at least MIN_RUN meters of run-up, preferring RUN_UP meters and no
 * parked car beside the driver’s door.
 *
 * Calculate the pickup and Randy’s positions, the turn toward the ramp, and a badge landing point beyond the nearest
 * deck edge. Return null if no suitable ramp or parking spot is available.
 */
export function stageOn(level: LevelData, garage: Garage, ground: (x: number, z: number) => number): Stage | null {
  const exit = level.gates.find((g) => g.kind === 'exit');
  const { min, max } = level.deck;
  const ex = exit ? exit.hinge[0] : max[0];
  const ez = exit ? exit.hinge[2] : (min[2] + max[2]) / 2;
  // Treat kickers near the maximum base height as roof ramps.
  const kickers = level.ramps.filter((r) => r.kicker);
  const roof = Math.max(...kickers.map((r) => r.low));
  let kicker: RampDef | null = null;
  let best = Infinity;
  for (const r of kickers) {
    if (r.low < roof - 0.5) {
      continue;
    }

    const d = Math.hypot((r.min[0] + r.max[0]) / 2 - ex, (r.min[2] + r.max[2]) / 2 - ez);
    if (d < best) {
      best = d;
      kicker = r;
    }
  }

  if (!kicker) {
    return null;
  }

  const k = kicker;
  // Separate the launch axis from the width used to test approach alignment.
  const ax = k.axis === 'x' ? 0 : 2;
  const across = ax === 0 ? 2 : 0;
  const low = k.dir > 0 ? k.min[ax] : k.max[ax];
  let spot: SpotRuntime | null = null;
  best = Infinity;

  for (const s of garage.spots) {
    if (Math.abs(s.center.y - k.low) > 0.6 || !garage.isFree(s)) {
      continue;
    }

    // Require the point beyond the spot’s front to align with the ramp approach.
    const reach = Math.max(...s.def.size) / 2 + 1.5;
    const out = [s.center.x + Math.sin(s.def.yaw) * reach, s.center.z + Math.cos(s.def.yaw) * reach];
    const side = out[across === 0 ? 0 : 1] as number;
    if (side < k.min[across] - 1 || side > k.max[across] + 1) {
      continue;
    }

    const run = (low - (out[ax === 0 ? 0 : 1] as number)) * k.dir;
    if (run < MIN_RUN) {
      continue;
    }

    // Penalize spots where another parked car would compete for interaction at the driver door.
    const door = new Vector3(
      s.center.x - Math.cos(s.def.yaw) * 2.6,
      s.center.y,
      s.center.z + Math.sin(s.def.yaw) * 2.6,
    );
    const crowded = garage.spots.some((o) => o !== s && o.occupant && o.center.distanceTo(door) < 1.5);
    const score = Math.abs(run - RUN_UP) + (crowded ? 100 : 0);
    if (score < best) {
      best = score;
      spot = s;
    }
  }

  if (!spot) {
    return null;
  }

  const yaw = spot.def.yaw;
  const truck = spot.center.clone();
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  // Use the same exit-side vector as CodyRide.exit.
  const sx = -Math.cos(yaw);
  const sz = Math.sin(yaw);
  const launch = ax === 0 ? [k.dir, 0] : [0, k.dir];
  // Vehicle.drive turns right toward (-cos(yaw), sin(yaw)), the same vector as (sx, sz).
  const turn = sx * (launch[0] as number) + sz * (launch[1] as number) > 0 ? 'RIGHT' : 'LEFT';
  const ahead = Math.max(...spot.def.size) / 2 + RANDY_AHEAD;
  const randy = new Vector3(truck.x + fx * ahead + sx * RANDY_SIDE, truck.y, truck.z + fz * ahead + sz * RANDY_SIDE);
  // Face along the aisle and slightly back toward the car to keep the fire clear.
  const randyYaw = Math.atan2(sx * 0.87 - fx * 0.5, sz * 0.87 - fz * 0.5);
  const window = new Vector3(truck.x + sx + fx * 0.4, truck.y, truck.z + sz + fz * 0.4);
  // Place the landing point beyond the deck edge nearest Randy.
  const edges: [number, number, number][] = [
    [randy.x - min[0], -1, 0],
    [max[0] - randy.x, 1, 0],
    [randy.z - min[2], 0, -1],
    [max[2] - randy.z, 0, 1],
  ];
  edges.sort((a, b) => a[0] - b[0]);
  const [gap, ox, oz] = edges[0] as [number, number, number];
  const tx = randy.x + ox * (gap + TOSS_PAST);
  const tz = randy.z + oz * (gap + TOSS_PAST);
  return { spot, truck, yaw, turn, randy, randyYaw, window, toss: new Vector3(tx, ground(tx, tz), tz) };
}

/**
 * Choose the first of four quarter-turn isometric views that leaves every sight point unobstructed, or the view with
 * the fewest blocked points. Test visible layer-zero meshes, including objects without collision geometry.
 */
function clearView(root: Object3D, sights: readonly Vector3[], azimuth: number): number {
  const meshes: Object3D[] = [];
  root.traverseVisible((o) => {
    if ((o as Mesh).isMesh && o.layers.isEnabled(0)) {
      meshes.push(o);
    }
  });
  const ray = new Raycaster();
  ray.far = 80;
  const c = Math.cos(ISO_ELEVATION);
  let best = azimuth;
  let fewest = Infinity;
  for (let k = 0; k < 4 && fewest > 0; k++) {
    const a = azimuth + (k * Math.PI) / 2;
    _toCamera.set(Math.sin(a) * c, Math.sin(ISO_ELEVATION), Math.cos(a) * c);
    let hidden = 0;
    for (const p of sights) {
      ray.set(p, _toCamera);

      if (ray.intersectObjects(meshes, false).length) {
        hidden++;
      }
    }

    if (hidden < fewest) {
      fewest = hidden;
      best = a;
    }
  }

  return best;
}

function remembered(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // If storage is unavailable, completion may not persist to the next visit.
  }
}

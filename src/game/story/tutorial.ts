import { type Mesh, type Object3D, Raycaster, Vector3 } from 'three';
import { TUNING } from '../../config';
import type { Vehicle } from '../../actors/vehicle';
import { type EventOf, Mind, mind, type StateOf } from '../../engine/sim/mind';
import { el } from '../../engine/ui/dom';
import { ISO_ELEVATION } from '../../render/iso-camera';
import { Dialogue, type DialogueLine } from '../../ui/dialogue';
import type { Phone } from '../../ui/phone/phone';
import { Signpost } from '../../ui/signpost';
import { wantsTouch } from '../../ui/touch-controls';
import type { LevelData, RampDef } from '../../world/level-data';
import { type CodyAction, ScriptedOffer } from '../cody/cody-actions';
import type { CamMode, Game } from '../game';
import { type Crossing, type Garage, spotLabel, type SpotRuntime } from '../deck/garage';
import { GameClock } from '../game-clock';
import type { Npc } from '../randy/npcs';
import type { Objective } from './objectives';

/** Remembered once the tutorial's been through its jump, or skipped. */
const DONE_KEY = '30pc.tutorial';
/** The roof chat starts at half past five (game hours), leaving an hour and a half of daylight after it to look for the badge (the clock waits through the chat). */
const START_HOUR = 17.5;
/** At moonrise Randy's gone in a puff of smoke: this long after (s) he rings to say sorry, and this long after the call his text sends Cody back to the pickup. */
const SORRY_AFTER = 3;
const TEXT_AFTER = 3;
/**
 * The pickup's roof spot: pulled out of it, at least MIN_RUN (m) to the roof kicker, ideally
 * RUN_UP. Randy stands in the aisle off its nose, this far ahead (m past the spot's front) and
 * to the driver's side; the badge lands this far past the deck's edge (out in the street: from
 * well in on the roof, a landing much closer in takes a sky-high lob to clear the parapet).
 */
const MIN_RUN = 9;
const RUN_UP = 14;
const RANDY_AHEAD = 1.1;
const RANDY_SIDE = 1.2;
const TOSS_PAST = 12;
/** The chat's camera: on the pair at chest height, this close (iso zoom), after this long to settle (s). */
const TALK_HEIGHT = 1.2;
const TALK_ZOOM = 12;
const TALK_DELAY = 1;
/** Randy's throw: the camera follows the badge out this far (iso zoom), then holds on where it lands this long (s) before going back to the pair. */
const THROW_ZOOM = 24;
const THROW_HOLD = 1.5;
/** Seconds the slime and ghosts take to ooze in at the first moonrise. */
const EMERGE = 3;
/** After the jump: the truck's idling once it's on its wheels and slower than IDLE_SPEED (m/s) for IDLE_FOR (s), and then Randy rings; if it never settles, he rings anyway LANDING_MAX (s) after it went over. */
const IDLE_SPEED = 0.5;
const IDLE_FOR = 2;
const LANDING_MAX = 12;
/** After the jump, the camera on the first phantom's imprint: once the truck's down (or this long, s), this close (iso zoom), the sign this high over it (m), and up this long at most (s). */
const IMPRINT_LAND = 3;
const IMPRINT_ZOOM = 16;
const IMPRINT_SIGN = 2.4;
const IMPRINT_HOLD = 15;
/** The camera looks this far (m) above the imprint, so it sits low on screen with room for the sign over it. */
const IMPRINT_ABOVE = 5;
/** Randy calls at 10pm (game hours), the burner ringing this long (s) before he talks. */
const CALL_HOUR = 22;
const RING = 1.6;
/** Cody talks to Randy this close (m), the basement chat's camera this close (iso zoom). */
const TALK_REACH = 3.6;
const BASEMENT_ZOOM = 10;
/** Into the joyride, seconds before Randy points out the camera keys (keyboards only), and the ghosts (if the truck hasn't swallowed one yet). */
const CAMERA_HINT = 5;
const GHOST_HINT = 14;
/** Randy, when Cody turns up in the basement without tires (the goal stays till he brings some). */
const NO_WHEELS: readonly DialogueLine[] = [
  { who: 'left', say: 'NO WHEELS? GO GET ME SOME.' },
  { who: 'left', say: 'SMASH SOMETHING. THEY FALL OFF.' },
];
/** Randy ringing once the truck's idling after the jump, before the camera goes back to the phantom it left. */
const TELL: readonly DialogueLine[] = [
  { who: 'left', say: 'OH YEAH! I NEED TO TELL YOU...' },
  { who: 'left', say: "THAT SPOT YOU PULLED OUT OF? THE GARAGE THINKS YOU'RE STILL PARKED IN IT." },
  { who: 'left', say: 'TAKE A LOOK.' },
];
/** The camera modes C cycles through. */
const CAMERA_MODES = 3;
/** GhASt as the dial spells it: the h and t small and below the line. */
const GHAST = '<span class="ghast-word">G<small>h</small>AS<small>t</small></span>';
/** Seconds the first phantom lesson stays up; the spook lesson waits on a real scare, or this long if nobody comes by. */
const LESSON = 9;
const SPOOK_WAIT = 45;
/** Seconds after the last text before the phone goes away. */
const DONE_WAIT = 9;
/** The opening's objective markers: back in the pickup when the moon's up (primary), and the badge Randy threw (optional, from when Cody's out till he's back in). */
const TRUCK_MARK = 'tutorial-truck';
const BADGE_MARK = 'tutorial-badge';
/** After his 10pm call: Randy himself, down in the basement (the tires go to him). */
const RANDY_MARK = 'tutorial-randy';

const _fwd = new Vector3();
const _side = new Vector3();
const _toCamera = new Vector3();
const _sign = new Vector3();

/**
 * The tutorial's steps, in story order (roof conversation, first escape, basement visit, then lessons
 * on phantom powers and the daily parking loop), and what each holds while it lasts.
 */
type Steps = {
  /** Not running: before it starts, or skipped. */
  off: object;
  /** The roof chat (once it's started talking). */
  scene: { t: number; talking: boolean };
  /** Out of the pickup, after the badge. */
  out: object;
  /** Seven o'clock: Randy's gone in a puff. */
  gone: { t: number };
  /** His burner call, sorry he had to go. */
  sorry: { t: number; talking: boolean };
  /** Off the phone, his text to come. */
  hangup: { t: number };
  back: object;
  jump: object;
  /** Down off the kicker: the truck settling, and the phantom it left. */
  landing: { t: number; idle: number; imprint: Imprint };
  /** Randy rings about it. */
  tell: { t: number; talking: boolean; imprint: Imprint };
  /** The camera on the imprint, and its sign. */
  imprint: { t: number; shown: boolean; imprint: Imprint };
  /** The joyride, with its lessons as he gets to them. */
  cruise: { t: number; cameras: Set<CamMode> | null; ghast: { hinted: boolean; fed: boolean; burned: boolean } };
  /** Ten o'clock: Randy calls. */
  call: { t: number; talking: boolean };
  basement: object;
  /** The basement chat with Randy: wheels, then the brisket. */
  brisket: object;
  outside: object;
  rules: { t: number };
  spook: { t: number };
  raise: object;
  /** Possessing one; `quiet` when it's a second go, with nothing more to say. */
  possess: { quiet: boolean };
  escape: object;
  rest: object;
  steal: object;
  badge: object;
  park: object;
  tonight: object;
  done: { t: number };
  /** All done. */
  over: object;
};

type Step = keyof Steps;

/** The first phantom's imprint: where it hangs, and what the sign says about it. */
interface Imprint {
  at: Vector3;
  title: string;
  meta: string;
}

/** The tutorial's dialogues, so a step knows which one just finished. */
type Talk = 'script' | 'sorry' | 'tell' | 'call' | 'noWheels' | 'brisket';

/** What the tutorial's steps react to: the game's events, and the ends of its own dialogues and sign. */
type TutorialEvents = {
  entered: { v: Vehicle; possessed: boolean };
  crossing: { crossing: Crossing };
  swallowed: object;
  boosted: object;
  summoned: object;
  camera: { mode: CamMode };
  phantom: { imprint: Imprint };
  spooked: object;
  exited: { spot: SpotRuntime | null };
  nightfall: object;
  sunrise: object;
  /** A dialogue of its own finished. */
  talked: { which: Talk };
  /** The imprint's sign was dismissed. */
  signed: object;
};

/** The story, roof to Randy's lessons: eating brisket doesn't send Cody to sleep till it's over (it does outside the tutorial). */
const STORY: ReadonlySet<Step> = new Set<Step>(['scene', 'out', 'gone', 'sorry', 'hangup', 'back', 'jump', 'landing', 'tell', 'cruise', 'call', 'basement', 'brisket', 'outside', 'rules', 'spook', 'raise']);

/** The steps that start with a text or a goal (the rest are scenes, calls and waits). */
type Texted = Exclude<Step, 'off' | 'scene' | 'out' | 'gone' | 'sorry' | 'hangup' | 'landing' | 'tell' | 'imprint' | 'call' | 'brisket' | 'over'>;

/** The first night's story, before the lessons: a sunrise in it is a wake-up from the dream. */
const NIGHT_STORY: ReadonlySet<Step> = new Set<Step>(['gone', 'sorry', 'hangup', 'back', 'jump', 'landing', 'tell', 'imprint', 'cruise', 'call', 'basement', 'brisket', 'outside']);
/** The phantom lessons: a sunrise in them goes on to the day job. */
const LESSONS: ReadonlySet<Step> = new Set<Step>(['rules', 'spook', 'raise', 'possess', 'escape', 'rest']);

/** Each texted step: the task under the clock (`{action}` becomes that action's key cap), and Randy's text as it starts (null when he's just said it in person). */
const STEPS: Readonly<Record<Texted, { goal: string | null; text: string | null }>> = {
  back: { goal: '{interact} GET BACK IN THE PICKUP', text: "SEVEN O'CLOCK, KID. NO BADGE? NO PROBLEM. GET BACK IN THE TRUCK." },
  jump: { goal: '{forward} UP THE RAMP. OFF THE ROOF.', text: 'NO BADGE, NO GATE. PULL OUT, HANG A {turn}, FLOOR IT UP THAT RAMP.' },
  cruise: {
    goal: 'TAKE IT FOR A SPIN',
    text: "HEH. NO SWIPE OUT, NO EXIT ON THE LOG. TRUCK'S YOURS TONIGHT, KID. ENJOY.",
  },
  basement: { goal: 'FIND TIRES. GIVE THEM TO RANDY.', text: 'BASEMENT. UNDER THE DECK, BY THE STAIRS. AND BRING WHEELS.' },
  outside: { goal: 'GO BACK OUT INTO THE MOONLIGHT', text: null },
  rules: { goal: null, text: "BAM. PHANTOM CODY. AT NIGHT YOU CAN'T STEAL CARS. YOU POSSESS 'EM, AND ONLY INSIDE THE HAUNTED DECK." },
  spook: { goal: 'SPOOK SOMEBODY', text: "PEOPLE SPOOK EASY NOW. SCARE A DRIVER AND THEY'LL BOLT RIGHT INTO THE DECK." },
  raise: { goal: '{summon} RAISE THE DEAD (TILL SUNRISE)', text: "LONG AS IT'S DARK, YOU CAN RAISE THE DEAD. GO ON. THEY OWE YOU. SUN COMES UP, THEY'RE DUST." },
  steal: { goal: '{interact} STEAL A CAR', text: "MORNING. DAY JOB NOW: THE DECK NEEDS CARS TO PHANTOM. STREET'S FULL OF 'EM. TAKE ONE." },
  badge: { goal: 'DRIVE IN THROUGH THE EAST GATE', text: 'BRING IT IN THE EAST GATE. GATE LOGS IT IN. NO BADGE NEEDED FOR THAT PART, HA.' },
  park: { goal: 'PARK IN A FREE SPOT, {interact} GET OUT', text: 'PARK IT UPSTAIRS AND GET OUT. WHAT YOU LOG IN BY DAY, YOU PHANTOM OUT BY NIGHT.' },
  tonight: { goal: 'WAIT FOR NIGHT', text: 'GOOD. COME 7, PHANTOM IT OUT.' },
  possess: { goal: '{interact} POSSESS A CAR IN THE DECK', text: 'ANY CAR PARKED IN THE DECK. POSSESS IT, THEN GET IT OUT. NOT THROUGH THE GATE.' },
  escape: { goal: 'GET IT OUT. NOT THROUGH THE GATE', text: 'NOW GET IT OUT. NOT THE GATE. WALLS BREAK. KICKERS JUMP.' },
  rest: { goal: null, text: "THAT'S ANOTHER ONE. KEEP 'EM COMING TILL SUNRISE." },
  done: {
    goal: null,
    text: "THAT'S THE WHOLE RACKET. THIRTY PHANTOMS AND THE DECK'S OURS. BRISKET OFFER STANDS.",
  },
};

/** Where the opening plays out on the roof. */
interface Stage {
  /** The pickup's spot (pulling out of it, a turn onto the kicker's run-up), where it stands and faces. */
  spot: SpotRuntime;
  truck: Vector3;
  yaw: number;
  /** Which way he turns out of the spot for the kicker. */
  turn: 'LEFT' | 'RIGHT';
  /** Randy in the aisle off its nose with his fire, his yaw, and the window he talks to. */
  randy: Vector3;
  randyYaw: number;
  window: Vector3;
  /** Where Cody's badge lands, down on the street. */
  toss: Vector3;
}

/** Night again before the day job's done: on to the good part. */
const nightJob = (): { at: 'possess'; quiet: boolean } => ({ at: 'possess', quiet: false });

/**
 * Runs the first-game tutorial through dialogue, cutscenes, objectives, and
 * phone messages. Starts on the roof at 5:30 PM. Completing the first jump
 * or skipping the tutorial is remembered; the title screen offers a replay.
 * Its steps are a mind (`steps`): each lists the events it waits on and
 * returns the step that follows, says what it does each frame and as it
 * starts, and holds what it needs while it lasts. The goal under the clock and
 * the markers come from whichever step it's in (goalOf, marksOf), and each
 * move is announced as a `step` game event.
 */
export class Tutorial {
  /** Run it on the next start. */
  private wanted = !remembered(DONE_KEY);
  private active = false;
  private readonly dialogue: Dialogue;
  /** Cody's phone (the game's): Randy texts and rings on it, and the goal line is its. */
  private get phone(): Phone {
    return this.game.phone;
  }
  private readonly sign: Signpost;
  private randy: Npc | null = null;
  private truck: Vehicle | null = null;
  private stage: Stage | null = null;
  /** The camera's target while they talk. */
  private readonly talkFocus = new Vector3();
  /** Following the badge Randy throws: seconds left (till it's landed and been seen), and the camera's target meanwhile. */
  private throwCam: number | null = null;
  private readonly throwFocus = new Vector3();
  /** The camera Cody had before the jump took it over, until he has it back. */
  private cam: CamMode | null = null;
  /** He's picked up the badge Randy threw, and the trigger that says so. */
  private badgeFound = false;
  private badgeGot: (() => void) | null = null;
  private readonly steps = mind<Tutorial, Steps, TutorialEvents>({
    off: {},
    scene: {
      tick: (t, s, dt) => {
        s.t += dt;
        if (t.throwCam !== null) t.followThrow(dt);
        if (s.t > TALK_DELAY && !s.talking && !t.dialogue.open) {
          s.talking = true;
          t.play('script', t.script());
        }
        return null;
      },
      on: {
        talked: (t, _s, { which }) => (which === 'script' ? t.letOut() : null),
        nightfall: (t) => t.moonrise(),
      },
    },
    out: {
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
      tick: (t, s, dt) => {
        if ((s.t += dt) > RING && !s.talking && !t.dialogue.open) {
          s.talking = true;
          t.play('sorry', t.sorry(), () => t.phone.endCall());
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
    jump: {
      enter: (t) => t.arrive('jump'),
      tick: (t) => {
        // off the kicker: the board drops in, in time to count him
        const v = t.truck;
        if (v && t.stage && !v.grounded && v.pos.y > t.stage.truck.y + 0.5) t.game.hud.showLedger(true);
        return null;
      },
      on: {
        crossing: (t, _s, { crossing }) => {
          // off the roof and out: the board drops in and counts him (Cody's still Cody till the brisket)
          if (crossing.kind === 'escaped') t.game.hud.showLedger(true);
          else if (crossing.kind === 'logged-out') t.text('NOT THE GATE, KID. THE GATE SAW THAT. SNEAK IT BACK IN AND GO OFF A KICKER.');
          return null;
        },
        // let it come down and idle; then Randy rings about it, and only then the camera goes back up
        phantom: (_t, _s, { imprint }) => ({ at: 'landing', t: 0, idle: 0, imprint }),
      },
    },
    landing: {
      tick: (t, s, dt) => {
        s.t += dt;
        const v = t.truck;
        s.idle = v && v.grounded && Math.hypot(v.vel.x, v.vel.z) < IDLE_SPEED ? s.idle + dt : 0;
        // he's been texting all along: a call's the last thing Cody expects
        return s.idle > IDLE_FOR || s.t > LANDING_MAX ? { at: 'tell', t: 0, talking: false, imprint: s.imprint } : null;
      },
    },
    tell: {
      enter: (t) => t.phone.call(),
      tick: (t, s, dt) => {
        if ((s.t += dt) > RING && !s.talking && !t.dialogue.open) {
          s.talking = true;
          t.play('tell', TELL, () => t.phone.endCall());
        }
        return null;
      },
      on: { talked: (_t, s, { which }) => (which === 'tell' ? { at: 'imprint', t: 0, shown: false, imprint: s.imprint } : null) },
    },
    imprint: {
      tick: (t, s, dt) => {
        s.t += dt;
        t.showImprint(s);
        return null;
      },
      on: { signed: () => ({ at: 'cruise', t: 0, cameras: null, ghast: { hinted: false, fed: false, burned: false } }) },
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
        // the joyride: ghosts in the tank, then burn it
        swallowed: (t, s) => {
          if (s.ghast.fed) return null;
          s.ghast.fed = true;
          t.text(`FEEL THAT? GHOSTS IN THE TANK. THAT'S ${GHAST}. HOLD {boost} TO BURN IT.`);
          return null;
        },
        boosted: (t, s) => {
          if (!s.ghast.fed || s.ghast.burned) return null;
          s.ghast.burned = true;
          t.text('HA! SOUL POWER.');
          return null;
        },
        camera: (t, s, { mode }) => {
          if (!s.cameras || s.cameras.size >= CAMERA_MODES) return null;
          s.cameras.add(mode);
          if (s.cameras.size >= CAMERA_MODES) t.text('THERE YOU GO. PICK ONE YOU LIKE.');
          return null;
        },
      },
    },
    call: {
      enter: (t) => t.phone.call(),
      tick: (t, s, dt) => {
        if ((s.t += dt) > RING && !s.talking && !t.dialogue.open) {
          s.talking = true;
          t.play('call', t.call(), () => t.phone.endCall());
        }
        return null;
      },
      on: { talked: (_t, _s, { which }) => (which === 'call' ? { at: 'basement' } : null) },
    },
    basement: {
      enter: (t) => t.arrive('basement'),
    },
    brisket: {
      enter: (t) => t.sitDown(),
      on: { talked: (t, _s, { which }) => (which === 'brisket' ? t.standUp() : null) },
    },
    outside: {
      enter: (t) => t.arrive('outside'),
      tick: (t) => {
        const g = t.game;
        if (!g.player.visible || g.garage.inFootprint(g.player.pos) || g.player.pos.y <= -1) return null;
        // out under the moon: bam
        g.cody.release();
        g.transformCody();
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
      // a real scare, or nobody came by
      tick: (_t, s, dt) => ((s.t += dt) > SPOOK_WAIT ? { at: 'raise' } : null),
      on: { spooked: () => ({ at: 'raise' }) },
    },
    raise: {
      enter: (t) => t.arrive('raise'),
      // only a summon that raised something counts: a press can fail while driving or on cooldown
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
          if (crossing.kind === 'escaped') return t.game.clock.day === 1 ? { at: 'rest' } : { at: 'done', t: 0 };
          if (crossing.kind !== 'logged-out' || crossing.vehicle.form !== 'truck') return null;
          t.text('NOT THE GATE, KID. THE GATE SEES EVERYTHING. GRAB ANOTHER ONE.');
          return { at: 'possess', quiet: true };
        },
      },
    },
    rest: {
      enter: (t) => t.arrive('rest'),
    },
    steal: {
      enter: (t) => t.arrive('steal'),
      on: { entered: (_t, _s, { possessed }) => (possessed ? null : { at: 'badge' }), nightfall: nightJob },
    },
    badge: {
      enter: (t) => t.arrive('badge'),
      on: {
        crossing: (t, _s, { crossing }) => {
          if (crossing.kind === 'logged-in') return { at: 'park' };
          if (crossing.kind === 'snuck-in') t.text('NO GATE? CUTE. THE GATE IS HOW IT COUNTS. BACK OUT, COME IN THE EAST GATE.');
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
      tick: (t, s, dt) => {
        if ((s.t += dt) <= DONE_WAIT) return null;
        t.phone.close();
        t.active = false;
        t.game.randyTalk.enabled = true;
        return { at: 'over' };
      },
    },
    over: {},
  });

  private readonly quest: Mind<Tutorial, Steps, TutorialEvents>;

  /** It's running this game (decided on 'start'): a new game, so game/save.ts doesn't put the last one back. */
  get running(): boolean {
    return this.active;
  }

  constructor(
    private readonly game: Game,
    private readonly level: LevelData,
  ) {
    this.dialogue = new Dialogue({ left: 'RANDY ROLSEN', right: 'CODY' }, game.input.focus);
    this.sign = new Signpost(game.hud.root, game.input.focus);
    this.quest = new Mind<Tutorial, Steps, TutorialEvents>(this.steps, this, { at: 'off' }, {
      on: {
        // morning, however far the night got: back to the game's own rules, and the day job
        sunrise: (t, s) => {
          if (NIGHT_STORY.has(s.at)) {
            t.wake();
            return { at: 'steal' };
          }
          return LESSONS.has(s.at) ? { at: 'steal' } : null;
        },
      },
      moved: (t, _from, to) => t.game.events.emit('step', { quest: 'tutorial', step: to.at }),
    });
    this.titleLink();
    game.addOffer(() => this.randyOffer());
    const ev = game.events;
    const send = (event: EventOf<TutorialEvents>): void => {
      if (this.active) this.quest.send(event);
    };
    ev.on('start', () => this.begin());
    ev.on('frame', (dt) => this.frame(dt));
    ev.on('entered', ({ v, possessed }) => send({ type: 'entered', v, possessed }));
    ev.on('crossing', (crossing) => send({ type: 'crossing', crossing }));
    ev.on('swallowed', () => send({ type: 'swallowed' }));
    ev.on('boosted', () => send({ type: 'boosted' }));
    ev.on('summoned', () => send({ type: 'summoned' }));
    ev.on('camera', (mode) => {
      // his pick: the ride's chase cam doesn't get put back over it
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
      // out of the phantom truck: the camera's his again
      this.giveCamera();
      send({ type: 'exited', spot });
    });
    ev.on('nightfall', () => send({ type: 'nightfall' }));
    ev.on('sunrise', () => send({ type: 'sunrise' }));
  }

  /** On the title: skip it the first time, replay it after. Clicking also starts the game. */
  private titleLink(): void {
    const title = document.querySelector<HTMLElement>('.hud-title');
    if (!title) return;
    const link = el('div', 'title-tut', title, this.wanted ? 'SKIP TUTORIAL' : 'REPLAY TUTORIAL');
    link.addEventListener('click', () => {
      this.wanted = !this.wanted;
      if (!this.wanted) remember(DONE_KEY);
    });
  }

  /** Set the scene: half past five, Cody in his pickup on the roof, Randy at the window. */
  private begin(): void {
    const g = this.game;
    this.randy = g.npcs.find('randy');
    this.stage = stageOn(this.level, g.garage, (x, z) => g.world.collision.groundAt(x, z, 2, 0));
    if (!this.wanted || !this.randy || !this.stage) return;
    this.active = true;
    // its own scenes with Randy, till it's done
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
    // Keep Cody in his daytime form until the brisket scene, but allow possession and truck driving.
    g.cody.hold('truck', 'possess');
    g.sleepAfterEating = false;
    g.clock.hours = START_HOUR;
    g.clock.paused = true;
    // parked in his spot, badged in this morning like any car he brought in
    const truck = g.park(st.truck, st.yaw, 'pickup');
    g.garage.checkIn(st.spot, truck);
    g.board(truck, true);
    this.truck = truck;
    g.npcs.place(r, st.randy, st.randyYaw);
    r.rig.phone.visible = false;
    r.send({ type: 'held', face: st.window });
    this.talkFocus.addVectors(st.window, st.randy).multiplyScalar(0.5).setY(st.randy.y + TALK_HEIGHT);
    // a view of the pair and the pickup's nose that none of the roof's towers stands in front of
    _fwd.set(Math.sin(st.yaw), 0, Math.cos(st.yaw));
    _side.set(_fwd.z, 0, -_fwd.x);
    const sights: Vector3[] = [];
    for (const along of [-2.2, 0, 2.2]) {
      for (const across of [-1, 0, 1]) {
        for (const up of [0.6, 1.4]) sights.push(st.truck.clone().addScaledVector(_fwd, along).addScaledVector(_side, across).setY(st.truck.y + up));
      }
    }
    sights.push(st.randy.clone().setY(st.randy.y + 1.4), this.talkFocus);
    g.iso.azimuth = g.iso.azimuthTarget = clearView(g.world.root, sights, g.iso.azimuth);
    g.iso.snapTo(this.talkFocus);
    g.cutscene = { focus: this.talkFocus, zoom: TALK_ZOOM };
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
    if (!this.active) return;
    this.quest.tick(dt);
    this.show();
  }

  /** Arriving at a step with a text: Randy's text for it (unless `say` is off), and the game's switches for it. */
  private arrive(step: Texted, say = true): void {
    const s = STEPS[step];
    if (say && s.text) this.text(s.text);
    // the tire trade waits for the basement chat
    this.game.tires.enabled = step !== 'basement';
    this.game.sleepAfterEating = !STORY.has(step);
    if (step === 'rules') {
      this.wanted = false;
      remember(DONE_KEY);
    }
  }

  /** The goal under the clock in step `s`. */
  private goalOf(s: StateOf<Steps>): string | null {
    switch (s.at) {
      // he went after the badge, and that's what kept him till after 7
      case 'out':
      case 'gone':
      case 'sorry':
      case 'hangup':
        return 'FIND YOUR BADGE';
      case 'cruise':
        return this.cruiseGoal(s);
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

  /** The markers up in step `s`: the badge Randy threw (optional) till Cody's back in the pickup or has it, the pickup itself once the moon's up (primary), and Randy in the basement after his call (primary). */
  private marksOf(s: StateOf<Steps>): Objective[] {
    const marks: Objective[] = [];
    const looking = s.at === 'out' || s.at === 'gone' || s.at === 'sorry' || s.at === 'hangup' || s.at === 'back';
    // (the badge on the ground is a copy, lying right where Randy aimed)
    if (looking && !this.badgeFound && this.stage) marks.push({ id: BADGE_MARK, label: 'YOUR BADGE', kind: 'optional', at: this.stage.toss });
    if (s.at === 'back' && this.truck) marks.push({ id: TRUCK_MARK, label: 'YOUR PICKUP', kind: 'primary', at: this.truck.pos });
    if (s.at === 'basement' && this.randy) marks.push({ id: RANDY_MARK, label: 'RANDY', kind: 'primary', at: this.randy.pos });
    return marks;
  }

  /** The goal under the clock and the markers as the current step has them. */
  private show(): void {
    const s = this.quest.state;
    this.game.objectives.goal = this.goalOf(s);
    this.game.objectives.replace(this, this.marksOf(s));
  }

  private text(msg: string): void {
    this.phone.text(msg.replace('{turn}', this.stage?.turn ?? 'RIGHT'));
  }

  /** Plays one of its dialogues; when it's over, `after`, and the step hears it's done. */
  private play(which: Talk, lines: readonly DialogueLine[], after?: () => void): void {
    this.dialogue.play(lines, () => {
      after?.();
      this.quest.send({ type: 'talked', which });
    });
  }

  /** Back in the pickup before the jump (possessed: at night it turns round him): straight into the chase cam, lined up on the kicker. */
  private boardedBeforeJump(from: Step, e: { v: Vehicle; possessed: boolean }): { at: 'jump' } | null {
    if (!e.possessed) return null;
    const g = this.game;
    // the truck he jumps is whichever car he got into, his pickup or another in the deck
    this.truck = e.v;
    // (sat in the pickup through 7: it turned round him before the moonrise news, same as getting back in)
    if (from === 'out') this.moonrise();
    // got in while Randy's still ringing: he can save it (a call he's on finishes, then hangs up)
    if (from === 'sorry' && !this.dialogue.open) this.phone.endCall();
    this.cam = g.cameraMode;
    g.setCamera('chase');
    g.chase.snapBehind(e.v.yaw);
    g.keepEscaped = true;
    return { at: 'jump' };
  }

  /** Cody's stuck in the pickup and Randy "helps": Randy on the left, Cody on the right. */
  private script(): DialogueLine[] {
    const g = this.game;
    const r = this.randy as Npc;
    const npcs = g.npcs;
    const toss = (this.stage as Stage).toss;
    const coat = (open: boolean, phone = false) => (): void => {
      r.send({ type: 'flash', open });
      r.rig.phone.visible = phone;
    };
    return [
      { who: 'right', say: "COME ON... BADGE WON'T SCAN ME OUT AFTER SEVEN." },
      { who: 'right', say: "I'M GONNA BE STUCK UP HERE ALL NIGHT." },
      {
        who: 'left',
        say: 'BADGE TROUBLE, KID? LEMME SEE IT. I KNOW THESE SCANNERS.',
        cue: () => {
          r.rig.badge.visible = true;
        },
      },
      {
        who: 'left',
        say: "AH MAN. YOU DON'T NEED THIS.",
        cue: () => {
          this.throwCam = npcs.toss(r, toss, { showPath: true }) + THROW_HOLD;
        },
      },
      { who: 'right', say: 'HUH?' },
      // the coat open on his wares: the burner, then the brisket
      {
        who: 'left',
        say: 'BRISKET?',
        cue: () => {
          coat(true)();
          g.waresShown = true;
        },
      },
      { who: 'right', say: 'NO... I NEED MY ID.' },
      { who: 'left', say: 'SUIT YOURSELF.' },
      // and hands him the burner through the window (how he texts him later)
      {
        who: 'left',
        say: "YOU'RE GOING TO NEED THIS.",
        cue: () => {
          coat(true, true)();
          g.handOver('burner');
        },
      },
    ];
  }

  /** The camera on the badge as Randy winds up and throws it, then on where it lands, then back on the pair. */
  private followThrow(dt: number): void {
    const g = this.game;
    const r = this.randy;
    const st = this.stage;
    if (this.throwCam === null || !r || !st) return;
    this.throwCam -= dt;
    // in his hand or in the air; once down, the one on the ground is a copy lying where he aimed
    if (r.toss) r.rig.badge.getWorldPosition(this.throwFocus);
    else this.throwFocus.copy(st.toss);
    g.cutscene = this.throwCam > 0 ? { focus: this.throwFocus, zoom: THROW_ZOOM } : { focus: this.talkFocus, zoom: TALK_ZOOM };
    if (this.throwCam <= 0) this.throwCam = null;
  }

  /** Done talking: Cody gets out, with an hour and a half of daylight left to find his badge. */
  private letOut(): { at: 'out' } {
    const g = this.game;
    const r = this.randy as Npc;
    this.throwCam = null;
    r.send({ type: 'released' });
    r.rig.phone.visible = false;
    g.waresShown = false;
    g.cutscene = null;
    g.clock.paused = false;
    g.alight();
    return { at: 'out' };
  }

  /** 7 o'clock: the slime and ghosts ooze in, and Randy's gone in a puff of smoke, back to his basement. */
  private moonrise(): { at: 'gone'; t: number } {
    const g = this.game;
    const r = this.randy as Npc;
    g.haunt(true, EMERGE);
    g.puff(r.pos);
    g.npcs.place(r, new Vector3(...r.def.pos), r.def.yaw);
    return { at: 'gone', t: 0 };
  }

  /**
   * The first phantom: once the truck's down, the camera goes back up to the roof where the
   * pickup stood, and a signpost on its imprint says what it is and what it's for.
   */
  private showImprint(s: { t: number; shown: boolean; imprint: Imprint }): void {
    const g = this.game;
    const im = s.imprint;
    _sign.copy(im.at).setY(im.at.y + IMPRINT_SIGN);
    if (s.shown) {
      if (!this.sign.open) return;
      this.sign.place(g.toScreen(_sign));
      if (s.t > IMPRINT_HOLD) this.sign.dismiss();
      return;
    }
    if (this.truck && !this.truck.grounded && s.t < IMPRINT_LAND) return;
    this.talkFocus.copy(im.at).setY(im.at.y + IMPRINT_ABOVE);
    const sights = [-2, 0, 2].map((d) => im.at.clone().add(_side.set(d, 1, d * 0.3)));
    g.iso.azimuth = g.iso.azimuthTarget = clearView(g.world.root, sights, g.iso.azimuth);
    g.cutscene = { focus: this.talkFocus, zoom: IMPRINT_ZOOM };
    // the sign says it all: no toasts over it
    g.hud.clearToasts();
    s.t = 0;
    s.shown = true;
    this.sign.show(im.title, im.meta, `FILL ALL ${TUNING.garage.spots} SPOTS WITH PHANTOMS.`, () => {
      g.cutscene = null;
      this.quest.send({ type: 'signed' });
    });
    this.sign.place(null);
  }

  /** In the basement, Cody can talk to Randy when he's close. The game shows and performs it like any other offer. */
  private randyOffer(): CodyAction | null {
    const g = this.game;
    const r = this.randy;
    if (!this.quest.in('basement') || !r || this.dialogue.open || !g.player.visible || g.npcs.talkable(g.player.pos, TALK_REACH) !== r) return null;
    return new ScriptedOffer({ label: 'TALK TO RANDY', start: () => this.meet(r) });
  }

  /** Cody talks to Randy in the basement: without tires Randy sends him back out; with them, the brisket scene. */
  private meet(r: Npc): void {
    if (this.game.inventory.count('tire') === 0) {
      r.send({ type: 'held', face: null });
      this.play('noWheels', NO_WHEELS, () => r.send({ type: 'released' }));
      return;
    }
    this.quest.go({ at: 'brisket' });
  }

  /** The basement chat starts: Randy turns to Cody, and the camera closes in on the pair. */
  private sitDown(): void {
    const g = this.game;
    const r = this.randy;
    if (!r) return;
    r.send({ type: 'held', face: null });
    this.talkFocus.addVectors(r.pos, g.player.pos).multiplyScalar(0.5).setY(r.pos.y + TALK_HEIGHT);
    g.cutscene = { focus: this.talkFocus, zoom: BASEMENT_ZOOM };
    this.play('brisket', this.brisket(r));
  }

  /** The brisket's eaten: Randy back to his fire, and Cody out into the moonlight. */
  private standUp(): { at: 'outside' } {
    this.randy?.send({ type: 'released' });
    this.game.cutscene = null;
    return { at: 'outside' };
  }

  /** The basement: wheels (if he brought the right kind), then the brisket, at last. */
  private brisket(r: Npc): DialogueLine[] {
    const g = this.game;
    const coat = (open: boolean) => (): void => {
      r.send({ type: 'flash', open });
    };
    const lines: DialogueLine[] = [];
    if (g.inventory.count('tire') > 0) lines.push({ who: 'left', say: 'OHHH. NICE WHEELS.', cue: () => void g.tires.give(r, g.player.pos) });
    lines.push(
      { who: 'left', say: 'SIT. WARM UP. BRISKET?', cue: coat(true) },
      { who: 'right', say: '...FINE. ONE BITE.', cue: coat(false) },
      { who: 'right', say: "WOW. THAT'S REALLY GOOD." },
      { who: 'right', say: "I'D DESCRIBE IT AS... POSITIVELY TRANSFORMATIVE." },
      { who: 'left', say: 'HEH. GO GET SOME AIR, KID. MOON LOOKS GOOD TONIGHT.' },
    );
    return lines;
  }

  /** The night's over (however far he got): back to the game's own rules. */
  private wake(): void {
    const g = this.game;
    if (g.cody.holdForm) {
      g.cody.release();
      g.transformCody();
    }
    g.keepEscaped = false;
    g.hud.showLedger(true);
    this.giveCamera();
  }

  /** The joyride's task right now: burning the GhASt he's got, trying the cameras, or just driving. */
  private cruiseGoal(s: Steps['cruise']): string | null {
    if (s.ghast.fed && !s.ghast.burned) return `{boost} BURN THE ${GHAST}`;
    if (s.cameras && s.cameras.size < CAMERA_MODES) return `{camera} TRY THE CAMERAS (${s.cameras.size}/${CAMERA_MODES})`;
    return STEPS.cruise.goal;
  }

  /** The camera Cody had before the jump, back to him (unless he's picked one since). */
  private giveCamera(): void {
    if (this.cam === null) return;
    this.game.setCamera(this.cam);
    this.cam = null;
  }

  /** Just after he vanished: Randy on the burner, sorry he had to go. */
  private sorry(): DialogueLine[] {
    return [
      { who: 'left', say: "IT'S RANDY. SORRY, I HAD TO GO." },
      { who: 'left', say: "I'LL TEXT YOU." },
      { who: 'right', say: '...OK?' },
    ];
  }

  /** 10pm: Randy on the burner. */
  private call(): DialogueLine[] {
    return [
      { who: 'left', say: "KID. IT'S RANDY. NICE JUMP." },
      { who: 'left', say: 'MEET ME IN THE BASEMENT. AND BRING WHEELS.' },
      { who: 'right', say: 'UH... OK.' },
    ];
  }
}

/**
 * The opening's places: the roof kicker nearest the exit gate (over it, not through it), and the
 * free roof spot that pulls out onto its run-up, a turn and RUN_UP (m) or so from it. Randy stands
 * in the aisle off the pickup's nose on the driver's side (the side Cody gets out on), turned so
 * his fire's clear of the car and the window's in sight; the badge lands on the street past the
 * deck edge nearest him. `ground` is the street's height.
 */
export function stageOn(level: LevelData, garage: Garage, ground: (x: number, z: number) => number): Stage | null {
  const exit = level.gates.find((g) => g.kind === 'exit');
  const { min, max } = level.deck;
  const ex = exit ? exit.hinge[0] : max[0];
  const ez = exit ? exit.hinge[2] : (min[2] + max[2]) / 2;
  // the roof's kickers are the highest ones
  const kickers = level.ramps.filter((r) => r.kicker);
  const roof = Math.max(...kickers.map((r) => r.low));
  let kicker: RampDef | null = null;
  let best = Infinity;
  for (const r of kickers) {
    if (r.low < roof - 0.5) continue;
    const d = Math.hypot((r.min[0] + r.max[0]) / 2 - ex, (r.min[2] + r.max[2]) / 2 - ez);
    if (d < best) {
      best = d;
      kicker = r;
    }
  }
  if (!kicker) return null;
  const k = kicker;
  // it launches along its axis from the low edge; the run-up lies across its width
  const ax = k.axis === 'x' ? 0 : 2;
  const across = ax === 0 ? 2 : 0;
  const low = k.dir > 0 ? k.min[ax] : k.max[ax];
  let spot: SpotRuntime | null = null;
  best = Infinity;
  for (const s of garage.spots) {
    if (Math.abs(s.center.y - k.low) > 0.6 || !garage.isFree(s)) continue;
    // pulled out: just past the spot's front, and that has to be in the kicker's lane
    const reach = Math.max(...s.def.size) / 2 + 1.5;
    const out = [s.center.x + Math.sin(s.def.yaw) * reach, s.center.z + Math.cos(s.def.yaw) * reach];
    const side = out[across === 0 ? 0 : 1] as number;
    if (side < k.min[across] - 1 || side > k.max[across] + 1) continue;
    const run = (low - (out[ax === 0 ? 0 : 1] as number)) * k.dir;
    if (run < MIN_RUN) continue;
    // Cody gets out on the driver's side: a car parked there would be the nearer one to get back into
    const door = new Vector3(s.center.x - Math.cos(s.def.yaw) * 2.6, s.center.y, s.center.z + Math.sin(s.def.yaw) * 2.6);
    const crowded = garage.spots.some((o) => o !== s && o.occupant && o.center.distanceTo(door) < 1.5);
    const score = Math.abs(run - RUN_UP) + (crowded ? 100 : 0);
    if (score < best) {
      best = score;
      spot = s;
    }
  }
  if (!spot) return null;
  const yaw = spot.def.yaw;
  const truck = spot.center.clone();
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  // the side Cody gets out on, as CodyRide.exit has it
  const sx = -Math.cos(yaw);
  const sz = Math.sin(yaw);
  const launch = ax === 0 ? [k.dir, 0] : [0, k.dir];
  // Vehicle.drive turns right toward (-cos(yaw), sin(yaw)), the same vector as (sx, sz).
  const turn = sx * (launch[0] as number) + sz * (launch[1] as number) > 0 ? 'RIGHT' : 'LEFT';
  const ahead = Math.max(...spot.def.size) / 2 + RANDY_AHEAD;
  const randy = new Vector3(truck.x + fx * ahead + sx * RANDY_SIDE, truck.y, truck.z + fz * ahead + sz * RANDY_SIDE);
  // facing out along the aisle, a little back toward the car: the fire's in the aisle, the window's over his shoulder
  const randyYaw = Math.atan2(sx * 0.87 - fx * 0.5, sz * 0.87 - fz * 0.5);
  const window = new Vector3(truck.x + sx + fx * 0.4, truck.y, truck.z + sz + fz * 0.4);
  // over the nearest edge of the deck
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
 * Of the four iso views from `azimuth` round, the first that sees all of `sights` (the roof's
 * towers, clocks and lamps stand in front of some), else the one that sees most. Rays go against
 * what's drawn, so lamps and other things with no collision count too.
 */
function clearView(root: Object3D, sights: readonly Vector3[], azimuth: number): number {
  const meshes: Object3D[] = [];
  root.traverseVisible((o) => {
    if ((o as Mesh).isMesh && o.layers.isEnabled(0)) meshes.push(o);
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
      if (ray.intersectObjects(meshes, false).length) hidden++;
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
    // storage blocked: the tutorial runs again next visit
  }
}

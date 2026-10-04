import { type Mesh, type Object3D, Raycaster, Vector3 } from 'three';
import { TUNING } from '../../config';
import type { Vehicle } from '../../actors/vehicle';
import { ISO_ELEVATION } from '../../render/iso-camera';
import { Burner } from '../../ui/burner';
import { Dialogue, type DialogueLine } from '../../ui/dialogue';
import { Signpost } from '../../ui/signpost';
import { el } from '../../ui/dom';
import { wantsTouch } from '../../ui/touch-controls';
import type { LevelData, RampDef } from '../../world/level-data';
import { type CodyAction, ScriptedOffer } from '../cody/cody-actions';
import type { CamMode, Game } from '../game';
import { type Garage, spotLabel, type SpotRuntime } from '../deck/garage';
import { GameClock } from '../game-clock';
import type { Npc } from '../randy/npcs';

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
 * Tutorial states, in story order: roof conversation, first escape,
 * basement visit, then lessons on phantom powers and the daily parking loop.
 */
type Step =
  | 'scene'
  | 'out'
  | 'gone'
  | 'sorry'
  | 'hangup'
  | 'back'
  | 'jump'
  | 'landing'
  | 'tell'
  | 'imprint'
  | 'cruise'
  | 'call'
  | 'basement'
  | 'brisket'
  | 'outside'
  | 'rules'
  | 'spook'
  | 'raise'
  | 'possess'
  | 'escape'
  | 'rest'
  | 'steal'
  | 'badge'
  | 'park'
  | 'tonight'
  | 'done';

/** The story, roof to Randy's lessons: eating brisket doesn't send Cody to sleep till it's over (it does outside the tutorial). */
const STORY: ReadonlySet<Step> = new Set<Step>(['scene', 'out', 'gone', 'sorry', 'hangup', 'back', 'jump', 'landing', 'tell', 'cruise', 'call', 'basement', 'brisket', 'outside', 'rules', 'spook', 'raise']);

/** The steps that start with a text or a goal (the rest are scenes, calls and waits). */
type Texted = Exclude<Step, 'scene' | 'out' | 'gone' | 'sorry' | 'hangup' | 'landing' | 'tell' | 'imprint' | 'call' | 'brisket'>;

/** Before he's back in the pickup and off the roof: getting in now (or sitting in it at 7) means the jump. */
const BEFORE_JUMP: ReadonlySet<Step> = new Set<Step>(['out', 'gone', 'sorry', 'hangup', 'back']);

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

/**
 * Runs the first-game tutorial through dialogue, cutscenes, objectives, and
 * phone messages. Starts on the roof at 5:30 PM. Completing the first jump
 * or skipping the tutorial is remembered; the title screen offers a replay.
 */
export class Tutorial {
  private readonly burner: Burner;
  /** Run it on the next start. */
  private wanted = !remembered(DONE_KEY);
  private active = false;
  private step: Step = 'scene';

  /** It's running this game (decided on 'start'): a new game, so game/save.ts doesn't put the last one back. */
  get running(): boolean {
    return this.active;
  }
  private readonly dialogue: Dialogue;
  private readonly sign: Signpost;
  /** The first phantom's imprint: where it hangs, and what the sign says about it. */
  private imprint: { at: Vector3; title: string; meta: string } | null = null;
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
  /** Seconds in the current step. */
  private t = 0;
  /** After the jump: seconds the truck's been idling. */
  private idle = 0;
  /** The joyride's GhASt lesson: ghosts pointed out, the first one swallowed, the first burn. */
  private ghast = { hinted: false, fed: false, burned: false };
  /** The joyride's camera lesson (keyboards only): the modes he's tried, once Randy's mentioned them. */
  private cameras: Set<CamMode> | null = null;
  /** Calls off the badge's marker trigger (it goes once he picks the badge up). */
  private badgeGot: (() => void) | null = null;

  constructor(
    private readonly game: Game,
    private readonly level: LevelData,
  ) {
    this.dialogue = new Dialogue({ left: 'RANDY ROLSEN', right: 'CODY' }, game.input.focus);
    this.burner = new Burner(game.hud.root);
    this.burner.onBuzz = (what) => game.events.emit('phone', what);
    this.sign = new Signpost(game.hud.root, game.input.focus);
    this.titleLink();
    game.addOffer(() => this.randyOffer());
    const ev = game.events;
    ev.on('start', () => this.begin());
    ev.on('frame', (dt) => this.frame(dt));
    ev.on('entered', ({ v, possessed }) => {
      if (!possessed) {
        if (this.step === 'steal') this.go('badge');
      } else if (BEFORE_JUMP.has(this.step)) {
        // (sat in the pickup through 7: it turned round him before the moonrise news, same as getting back in)
        if (this.step === 'out') this.moonrise();
        // got in while Randy's still ringing: he can save it (a call he's on finishes, then hangs up)
        if (this.step === 'sorry' && !this.dialogue.open) this.burner.endCall();
        this.clearMarks();
        // already lined up on the kicker: straight into the chase cam behind it
        this.cam = game.cameraMode;
        game.setCamera('chase');
        game.chase.snapBehind(v.yaw);
        game.keepEscaped = true;
        this.go('jump');
      } else if (this.step === 'possess') this.go('escape');
    });
    ev.on('crossing', (c) => {
      const s = this.step;
      // off the roof and out: the board drops in and counts him (Cody's still Cody till the brisket)
      if (s === 'jump' && c.kind === 'escaped') this.game.hud.showLedger(true);
      else if (s === 'jump' && c.kind === 'logged-out') this.text("NOT THE GATE, KID. THE GATE SAW THAT. SNEAK IT BACK IN AND GO OFF A KICKER.");
      else if (s === 'escape' && c.kind === 'escaped') this.go(this.game.clock.day === 1 ? 'rest' : 'done');
      else if (s === 'escape' && c.kind === 'logged-out' && c.vehicle.form === 'truck') {
        this.text('NOT THE GATE, KID. THE GATE SEES EVERYTHING. GRAB ANOTHER ONE.');
        this.step = 'possess';
        this.burner.objective(STEPS.possess.goal);
      } else if (s === 'badge' && c.kind === 'logged-in') this.go('park');
      else if (s === 'badge' && c.kind === 'snuck-in') this.text('NO GATE? CUTE. THE GATE IS HOW IT COUNTS. BACK OUT, COME IN THE EAST GATE.');
    });
    // the joyride: ghosts in the tank, then burn it
    ev.on('swallowed', () => {
      if (this.step !== 'cruise' || this.ghast.fed) return;
      this.ghast.fed = true;
      this.text(`FEEL THAT? GHOSTS IN THE TANK. THAT'S ${GHAST}. HOLD {boost} TO BURN IT.`);
      this.burner.objective(this.cruiseGoal());
    });
    ev.on('boosted', () => {
      if (this.step !== 'cruise' || !this.ghast.fed || this.ghast.burned) return;
      this.ghast.burned = true;
      this.text('HA! SOUL POWER.');
      this.burner.objective(this.cruiseGoal());
    });
    // Advance only after a successful summon. A key press may fail while driving or on cooldown.
    ev.on('summoned', () => {
      if (this.step === 'raise') this.go('possess');
    });
    ev.on('camera', (mode) => {
      // his pick: the ride's chase cam doesn't get put back over it
      this.cam = null;
      if (this.step !== 'cruise' || !this.cameras || this.cameras.size >= CAMERA_MODES) return;
      this.cameras.add(mode);
      if (this.cameras.size >= CAMERA_MODES) this.text('THERE YOU GO. PICK ONE YOU LIKE.');
      this.burner.objective(this.cruiseGoal());
    });
    // the imprint the escape leaves: once he's down, show him
    ev.on('phantom', ({ at, spot, n, hours, day }) => {
      if (this.step !== 'jump') return;
      this.imprint = {
        at: at.clone(),
        title: n === 1 ? '1ST PHANTOM' : `PHANTOM #${n}`,
        meta: `${spot ? `${spotLabel(spot)} \u2022 ` : ''}${GameClock.format(hours)}, NIGHT ${day}`,
      };
      // let it come down and idle; then Randy rings about it, and only then the camera goes back up
      this.step = 'landing';
      this.t = 0;
      this.idle = 0;
      // the jump's done: no goal under the clock
      this.burner.objective(null);
    });
    ev.on('spooked', () => {
      if (this.step === 'spook') this.go('raise');
    });
    ev.on('exited', ({ spot }) => {
      // out of the phantom truck: the camera's his again
      this.giveCamera();
      if (this.step === 'park' && spot) this.go('tonight');
    });
    ev.on('nightfall', () => {
      if (!this.active) return;
      const s = this.step;
      if (s === 'scene' || s === 'out') {
        this.moonrise();
        this.step = 'gone';
        this.t = 0;
      }
      // night came before the day job was done: on to the good part
      else if (s === 'steal' || s === 'badge' || s === 'park' || s === 'tonight') this.go('possess');
    });
    ev.on('sunrise', () => {
      if (!this.active) return;
      const s = this.step;
      if (s === 'gone' || s === 'sorry' || s === 'hangup' || s === 'back' || s === 'jump' || s === 'landing' || s === 'tell' || s === 'imprint' || s === 'cruise' || s === 'call' || s === 'basement' || s === 'brisket' || s === 'outside') {
        this.wake();
        this.go('steal');
      } else if (s === 'rules' || s === 'spook' || s === 'raise' || s === 'possess' || s === 'escape' || s === 'rest') this.go('steal');
    });
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
    const r = this.randy;
    const st = this.stage;
    const { randy, cody } = g.portraits;
    this.dialogue.setPortrait('left', randy);
    this.dialogue.setPortrait('right', cody);
    this.burner.setAvatar(randy);
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
    g.board(truck);
    this.truck = truck;
    g.npcs.place(r, st.randy, st.randyYaw);
    r.rig.phone.visible = false;
    r.hear({ type: 'held', face: st.window });
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
    this.step = 'scene';
    this.t = 0;
    this.ghast = { hinted: false, fed: false, burned: false };
    this.cameras = null;
    this.throwCam = null;
    this.clearMarks();
    this.badgeGot = g.triggers.on({ got: 'badge' }, () => {
      g.objectives.remove(BADGE_MARK);
      this.badgeGot = null;
    });
  }

  private go(step: Texted): void {
    this.step = step;
    this.t = 0;
    if (step !== 'back') this.clearMarks();
    const s = STEPS[step];
    if (s.text) this.text(s.text);
    this.burner.objective(s.goal);
    // the tire trade waits for the basement chat
    this.game.tires.enabled = step !== 'basement';
    this.game.sleepAfterEating = !STORY.has(step);
    if (step === 'rules') {
      this.wanted = false;
      remember(DONE_KEY);
    }
  }

  private text(msg: string): void {
    this.burner.text(msg.replace('{turn}', this.stage?.turn ?? 'RIGHT'));
  }

  private frame(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    const g = this.game;
    this.burner.setTime(GameClock.format(g.clock.hours));
    // nothing to press while a conversation or the sign is up (the game's own prompts come back after)
    if (this.step === 'scene' && this.throwCam !== null) this.followThrow(dt);
    if (this.step === 'scene' && this.t > TALK_DELAY && !this.dialogue.open) {
      this.dialogue.play(this.script(), () => this.letOut());
    } else if (this.step === 'gone' && this.t > SORRY_AFTER) {
      this.step = 'sorry';
      this.t = 0;
      this.burner.call();
    } else if (this.step === 'sorry' && this.t > RING && !this.dialogue.open) {
      this.dialogue.play(this.sorry(), () => {
        this.burner.endCall();
        // (unless he's already back in the pickup)
        if (this.step !== 'sorry') return;
        this.step = 'hangup';
        this.t = 0;
      });
    } else if (this.step === 'hangup' && this.t > TEXT_AFTER) {
      this.goBack();
    } else if (this.step === 'jump' && this.truck && !this.truck.grounded && this.truck.pos.y > (this.stage as Stage).truck.y + 0.5) {
      // off the kicker: the board drops in, in time to count him
      g.hud.showLedger(true);
    } else if (this.step === 'landing') {
      const v = this.truck;
      this.idle = v && v.grounded && Math.hypot(v.vel.x, v.vel.z) < IDLE_SPEED ? this.idle + dt : 0;
      if (this.idle > IDLE_FOR || this.t > LANDING_MAX) {
        // he's been texting all along: a call's the last thing Cody expects
        this.step = 'tell';
        this.t = 0;
        this.burner.call();
      }
    } else if (this.step === 'tell' && this.t > RING && !this.dialogue.open) {
      this.dialogue.play(TELL, () => {
        this.burner.endCall();
        this.step = 'imprint';
        this.t = 0;
      });
    } else if (this.step === 'imprint') {
      this.showImprint();
    } else if (this.step === 'cruise' && !this.cameras && this.t > CAMERA_HINT && !wantsTouch()) {
      this.cameras = new Set([g.cameraMode]);
      this.text("{camera} SWITCHES THE CAMERA. TRY 'EM ALL.");
      this.burner.objective(this.cruiseGoal());
    } else if (this.step === 'cruise' && !this.ghast.hinted && !this.ghast.fed && this.t > GHOST_HINT) {
      this.ghast.hinted = true;
      this.text("SEE THEM GHOSTS? DRIVE RIGHT THROUGH 'EM.");
    } else if (this.step === 'cruise' && !g.clock.isDay && g.clock.hours >= CALL_HOUR) {
      this.step = 'call';
      this.t = 0;
      this.burner.call();
      this.burner.objective(null);
    } else if (this.step === 'call' && this.t > RING && !this.dialogue.open) {
      this.dialogue.play(this.call(), () => {
        this.burner.endCall();
        this.go('basement');
        const r = this.randy;
        if (r) this.game.objectives.add({ id: RANDY_MARK, label: 'RANDY', kind: 'primary', at: r.pos });
      });
    } else if (this.step === 'outside' && g.player.visible && !g.garage.inFootprint(g.player.pos) && g.player.pos.y > -1) {
      // out under the moon: bam
      g.cody.release();
      g.transformCody();
      g.hud.toast('BAM.', 'PHANTOM CODY', '', 2.6);
      this.dialogue.setPortrait('right', g.portraits.codyNight);
      this.go('rules');
    } else if ((this.step === 'rules' && this.t > LESSON) || (this.step === 'spook' && this.t > SPOOK_WAIT)) {
      this.go(this.step === 'rules' ? 'spook' : 'raise');
    } else if (this.step === 'done' && this.t > DONE_WAIT) {
      this.burner.close();
      this.active = false;
    }
  }

  /** Cody's stuck in the pickup and Randy "helps": Randy on the left, Cody on the right. */
  private script(): DialogueLine[] {
    const g = this.game;
    const r = this.randy as Npc;
    const npcs = g.npcs;
    const toss = (this.stage as Stage).toss;
    const coat = (open: boolean, phone = false) => (): void => {
      r.hear({ type: 'flash', open });
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
  private letOut(): void {
    const g = this.game;
    const r = this.randy as Npc;
    this.throwCam = null;
    r.hear({ type: 'released' });
    r.rig.phone.visible = false;
    g.waresShown = false;
    g.cutscene = null;
    g.clock.paused = false;
    g.alight();
    // (no "PARKED" toast for a car that never moved)
    g.hud.clearToasts();
    // he goes after the badge, and that's what keeps him till after 7
    this.burner.objective('FIND YOUR BADGE');
    // (the badge on the ground is a copy, lying right where Randy aimed)
    if (this.badgeGot && this.stage) g.objectives.add({ id: BADGE_MARK, label: 'YOUR BADGE', kind: 'optional', at: this.stage.toss });
    this.step = 'out';
    this.t = 0;
  }

  /** 7 o'clock: the slime and ghosts ooze in, and Randy's gone in a puff of smoke, back to his basement. */
  private moonrise(): void {
    const g = this.game;
    const r = this.randy as Npc;
    g.haunt(true, EMERGE);
    // gone in a puff of smoke, back to his basement
    g.puff(r.pos);
    g.npcs.place(r, new Vector3(...r.def.pos), r.def.yaw);
  }

  /**
   * The first phantom: once the truck's down, the camera goes back up to the roof where the
   * pickup stood, and a signpost on its imprint says what it is and what it's for.
   */
  private showImprint(): void {
    const g = this.game;
    const im = this.imprint as NonNullable<Tutorial['imprint']>;
    _sign.copy(im.at).setY(im.at.y + IMPRINT_SIGN);
    if (this.sign.open) {
      this.sign.place(g.toScreen(_sign));
      if (this.t > IMPRINT_HOLD) this.sign.dismiss();
      return;
    }
    if (this.truck && !this.truck.grounded && this.t < IMPRINT_LAND) return;
    this.talkFocus.copy(im.at).setY(im.at.y + IMPRINT_ABOVE);
    const sights = [-2, 0, 2].map((d) => im.at.clone().add(_side.set(d, 1, d * 0.3)));
    g.iso.azimuth = g.iso.azimuthTarget = clearView(g.world.root, sights, g.iso.azimuth);
    g.cutscene = { focus: this.talkFocus, zoom: IMPRINT_ZOOM };
    // the sign says it all: no toasts over it
    g.hud.clearToasts();
    this.t = 0;
    this.sign.show(
      im.title,
      im.meta,
      `FILL ALL ${TUNING.garage.spots} SPOTS WITH PHANTOMS.`,
      () => {
        g.cutscene = null;
        this.go('cruise');
      },
    );
    this.sign.place(null);
  }

  /** In the basement: walk up to Randy and talk (F). No tires, no brisket: he sends Cody back out for some. */
  /** In the basement, Cody can talk to Randy when he's close. The game shows and performs it like any other offer. */
  private randyOffer(): CodyAction | null {
    const g = this.game;
    const r = this.randy;
    if (this.step !== 'basement' || !r || this.dialogue.open || !g.player.visible || g.npcs.talkable(g.player.pos, TALK_REACH) !== r) return null;
    return new ScriptedOffer({ label: 'TALK TO RANDY', start: () => this.meet(r) });
  }

  /** Cody talks to Randy in the basement: without tires Randy sends him back out; with them, the brisket scene. */
  private meet(r: Npc): void {
    const g = this.game;
    if (g.inventory.count('tire') === 0) {
      r.hear({ type: 'held', face: null });
      this.dialogue.play(NO_WHEELS, () => {
        r.hear({ type: 'released' });
      });
      return;
    }
    this.step = 'brisket';
    g.objectives.remove(RANDY_MARK);
    r.hear({ type: 'held', face: null });
    this.talkFocus.addVectors(r.pos, g.player.pos).multiplyScalar(0.5).setY(r.pos.y + TALK_HEIGHT);
    g.cutscene = { focus: this.talkFocus, zoom: BASEMENT_ZOOM };
    this.dialogue.play(this.brisket(r), () => {
      r.hear({ type: 'released' });
      g.cutscene = null;
      this.go('outside');
    });
  }

  /** The basement: wheels (if he brought the right kind), then the brisket, at last. */
  private brisket(r: Npc): DialogueLine[] {
    const g = this.game;
    const coat = (open: boolean) => (): void => {
      r.hear({ type: 'flash', open });
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
  private cruiseGoal(): string | null {
    if (this.ghast.fed && !this.ghast.burned) return `{boost} BURN THE ${GHAST}`;
    if (this.cameras && this.cameras.size < CAMERA_MODES) return `{camera} TRY THE CAMERAS (${this.cameras.size}/${CAMERA_MODES})`;
    return STEPS.cruise.goal;
  }

  /** The camera Cody had before the jump, back to him (unless he's picked one since). */
  private giveCamera(): void {
    if (this.cam === null) return;
    this.game.setCamera(this.cam);
    this.cam = null;
  }

  /** The tutorial's markers off (and the badge's trigger with them). */
  private clearMarks(): void {
    this.game.objectives.remove(TRUCK_MARK);
    this.game.objectives.remove(BADGE_MARK);
    this.game.objectives.remove(RANDY_MARK);
    this.badgeGot?.();
    this.badgeGot = null;
  }

  /** Randy's text after the call: back in the pickup, the primary objective now. */
  private goBack(): void {
    this.go('back');
    if (this.truck) this.game.objectives.add({ id: TRUCK_MARK, label: 'YOUR PICKUP', kind: 'primary', at: this.truck.pos });
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
  // the side Cody gets out on, as Game.exit has it
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

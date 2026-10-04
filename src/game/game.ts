import {
  Color,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Scene,
  Vector3,
} from 'three';
import type { AssetRegistry } from '../assets/asset-registry';
import type { Obstacle } from '../actors/autopilot';
import { Avoidance, parkedBlocks, PERSON_RADIUS } from '../actors/avoidance';
import { Player } from '../actors/player';
import { Traffic } from '../actors/traffic';
import { type DriveEvents, type DriveInput, Vehicle } from '../actors/vehicle';
import { type CarKind, VEHICLE_BREEDS } from '../actors/vehicle-breeds';
import { TUNING } from '../config';
import { Input } from '../engine/input/input';
import { Emitter } from '../engine/core/events';
import { clamp, lerp, smoothstep, TAU, type V3 } from '../engine/core/math';
import { Rng } from '../engine/core/rng';
import { urlChoice, urlFlag, urlParam } from '../engine/core/url-flags';
import { reloadIfPending } from '../dev/reload-prompt';
import { Bats } from '../fx/bats';
import { PURPLE, SLIME, WHITE } from '../fx/colors';
import { CubeParticles } from '../fx/cube-particles';
import { Exhaust } from '../fx/exhaust';
import { Ghosts } from '../fx/ghosts';
import { Honks } from '../fx/honks';
import { NavArrow } from '../fx/nav-arrow';
import { NavDebug } from '../fx/nav-debug';
import { SpriteFx } from '../fx/sprite-fx';
import { DayNight } from '../render/day-night';
import { GameRenderer } from '../render/game-renderer';
import { ChaseCamera, type ChaseKind } from '../render/chase-camera';
import { Cutaway } from '../render/cutaway';
import { IsoCamera } from '../render/iso-camera';
import { FX_LAYER } from '../render/layers';
import { LightPool } from '../render/light-pool';
import { MaterialLibrary, softInk, withCutaway } from '../render/materials';
import { PALETTE } from '../render/palette';
import { SunLight } from '../render/sun-light';
import { helpRows, Hud } from '../ui/hud';
import { Help, MapApp, type PhantomReport, Phantoms, Photos, Tasks } from '../ui/phone/apps';
import { Messages } from '../ui/phone/messages';
import { Phone } from '../ui/phone/phone';
import { wantsTouch } from '../ui/touch-controls';
import { type BreakablePiece, buildWorld, type BuiltWorld } from '../world/build-world';
import type { Solid } from '../engine/physics/collision';
import type { PropKind } from '../world/props';
import type { LevelData, ZoneDef } from '../world/level-data';
import { Elevators } from '../world/elevators';
import { NAV, NavGrid, NavPlanner, type NavProfile, type NavQuery } from '../world/nav-grid';
import { BloodSim } from '../world/blood';
import { Casualties } from './town/casualties';
import { CameraController, type CamMode } from './camera-controller';
import { CallElevator, type CodyAction, type CodyCandidate, Eat, GetOut, GiveTires, InteractWithVehicle, PickFloor, type Play, RANK, RockOver, Summon, TalkToRandy, TalkToValet } from './cody/cody-actions';
import { CodyState, FRIGHTENING } from './cody/cody-state';
import { CLAIMS, type ClaimKind } from './rules/claim-kinds';
import { Doing, resolveFully } from '../engine/sim/action';
import { Claims } from '../engine/sim/claims';
import { bestOffers } from '../engine/sim/offers';
import { Phases } from '../engine/sim/phase';
import { Space } from '../engine/sim/space';
import { EYE_HEIGHT, gameReactions, type Perception, react, type Reaction, type Thing } from './rules/reactions';
import { LEVEL } from './rules/reach';
import { WorldConditions } from './rules/world-conditions';
import { createGameDebug } from './debug';
import { playEffects } from './effects';
import { Skeletons } from './town/skeletons';
import { carContacts } from './driving/collisions';
import { Crowd } from './town/crowd';
import { Detours } from './driving/detours';
import { GameClock, type Phase } from './game-clock';
import { Fleet } from './driving/fleet';
import { type Crossing, Garage, inSpot, spotLabel, type SpotRuntime } from './deck/garage';
import { Inventory, type ItemActionId } from './items/inventory';
import { ITEM_BREEDS, type ItemKind, isItemKind } from './items/item-breeds';
import { Junk } from './items/junk';
import { Money } from './items/money';
import { NPC_NAMES, Npcs } from './randy/npcs';
import { makePortraits, type Portraits } from './story/portraits';
import { RouteGuide } from './route-guide';
import { Shop } from './randy/shop';
import { RandyTalk } from './randy/talk';
import { TireTrade } from './randy/tire-trade';
import { Wares } from './randy/wares';
import { Objectives } from './story/objectives';
import { type ItemDeed, Triggers } from './story/triggers';
import { TransformSequence, type FxKit } from './deck/transform-sequence';
import { ValetTalk } from './valets/talk';
import type { DriveWorld } from './driving/drive-actions';
import { Drivers } from './driving/drivers';
import { Refuge } from './driving/refuge';
import { Bodies } from './rules/bodies';
import { type ValetFrame, ValetService } from './valets/valet';
import { Visitors } from './driving/visitors';
import { type Control, KEYS, STICK } from './controls';

export type { CamMode, CamView } from './camera-controller';

const CONCRETE = new Color('#8f889c');
const METAL = new Color('#5a5266');
const BONE = new Color('#efe6ff');
const DIRT = new Color('#3a2a22');
/** Spectral truck exhaust, and the hotter plume while it burns GhASt. */
const EXHAUST = new Color(0.35, 1.3, 0.15);
const BOOST_FLAME = new Color(0.9, 1.6, 1.4);
/** The truck's GhASt intake, in its body's frame: up front over the cab. */
const INTAKE: V3 = [0, 2.6, 1.4];
/** Cody's outfit swap at moonrise / sunrise. */
const OUTFIT_PUFF = new Color(0.6, 0.3, 1.4);
/** Black smoke and embers (glowing, so past 1) off Randy's fire when a tire goes in. */
const TIRE_SMOKE = new Color('#221c28');
const EMBER = new Color(2.4, 0.9, 0.2);
// a knocked-over lamp's sparks (glowing, so brighter than its light color)
const _spark = new Color();
const SPARK_SIZE: [number, number] = [0.05, 0.12];
const SPARK_LIFE: [number, number] = [0.3, 0.7];
const _v = new Vector3();
const _w = new Vector3();
const _s = new Vector3();
const _up = new Vector3();
/** What the iso view shows, for fitting the sun's shadow box to it. */
const _shadowPts: Vector3[] = [];
// ambient drip splashes reuse these rather than allocating per drop
const _splat = new Vector3();
const _splatSize: [number, number] = [0, 0];
const SPLAT_LIFE: [number, number] = [0.25, 0.5];
const _prev = new Vector3();
/** Where an AI-driven car was before this step, for its gate crossings. */
const _drivePrev = new Vector3();
const _at = new Vector3();
/** Where two cars met, hardest this frame. */
const _met = new Vector3();
const _tint = new Color();
const NONE: readonly Vector3[] = [];

/** Cody can get into a car or truck at most this far above or below it (how near: VehicleBreed.enterReach). */
const ENTER_HEIGHT = 1.8;
/** Cody steps out this far past the side of the car (m). */
const DOOR_GAP = 1;
/**
 * A prop smashed to bits (a hedge, a bus shelter): pieces of its debris per cubic metre it filled,
 * within `count`, their size, life (s), and how fast they fly out and up (m/s); the hit's shake.
 */
const SHATTER = { perM3: 3, count: [12, 36] as [number, number], size: [0.1, 0.32] as [number, number], life: 2.2, out: 5, up: [2, 6] as [number, number] };
/** A truck flattens a car outside the deck above this speed (m/s); the hit jolts the truck's body. */
const CRUSH_SPEED = 4;
/** A driver pulling round only knocks another driven car loose (its driver out) with a bump this hard (m/s); softer is a shove. */
const NUDGE_LOOSEN = 2.5;
/** A car slower than this (m/s) in a deck spot is standing in it: the spot isn't free. */
const STANDING = 0.5;
const CRUSH_KICK = 2.5;
/** An escaped truck rolls on this long (s) before it dissolves. */
const ESCAPE_ROLL = 2.5;
/**
 * Dozing off after a big meal: the picture dims to DOZE.dim of itself over
 * `down` seconds, the clock jumps to the next nightfall or sunrise while it's
 * dark, and it comes back up over `up`. The toast stays `toast` seconds.
 */
const DOZE = { down: 1.4, hold: 0.6, up: 1.6, dim: 0.04, toast: 3 };
/** Seconds a picked-up money (or car part) toast stays, and a longer one (Randy's brisket, a find with a note to read). */
const MONEY_TOAST = 1.1;
const TRADE_TOAST = 2.6;
/** How long a refusal such as "THE DEAD NEED A MOMENT" stays up, in seconds. */
const FAIL_TOAST = 1.4;
/** The controls the prompt shows, in order, when they offer something. */
const PROMPT_CONTROLS: readonly Control[] = ['hop', 'interact', 'pay'];
/** The controls that perform Cody's offers when pressed. */
const ACT_CONTROLS: readonly Control[] = ['interact', 'pay', 'summon', 'hop'];
/** Randy's wares are up while Cody's within this of him (m, on his level) and his coat's open. */
/** People on foot keep this far from Randy and from the middle of his trash can fire (m). */
const NPC_ROOM = 0.4;
const FIRE_ROOM = 0.45;

type Mode = 'title' | 'play';
/** What happens in play, for the tutorial (and anything else that follows along). */
export type GameEvents = {
  start: null;
  /** A play frame finished; the payload is dt. */
  frame: number;
  /** Cody got in: stole, took or (at night, in the deck) possessed a car. */
  entered: { v: Vehicle; possessed: boolean };
  /** Cody got out; `spot` is the deck spot it parked in, if any. */
  exited: { v: Vehicle; spot: SpotRuntime | null };
  /** A driver took fright at phantom Cody (or the monster truck), once each time a fright starts; near the deck they may run for it. */
  spooked: { car: Vehicle };
  /** Cody got, used or gave away an item (game.triggers is the easier way to wait on one). */
  item: ItemDeed;
  /** The player picked a camera mode with C. */
  camera: CamMode;
  /** The monster truck sucked in ghosts at its intake (`at`): how many, and the GhASt tank after (0..1). */
  swallowed: { n: number; tank: number; at: Vector3 };
  /** Cody started burning GhASt. */
  boosted: null;
  /** Emitted after a successful summon, with the number of skeletons raised. */
  summoned: { n: number };
  /** A truck got out unseen and left its phantom imprint: where it hangs and which way it faces (its spot, if it went back to one), which number it is, and when. */
  phantom: { at: Vector3; yaw: number; spot: SpotRuntime | null; n: number; hours: number; day: number };
  /**
   * A driver held up behind something leaned on the horn (for the horn sound): the car, where
   * it was (a copy, at road level), and how angry they are (0 calm to 1 fuming: angrier honks
   * can sound longer or harsher). Once a honk; they honk again after TUNING.traffic.impatience
   * `again` seconds, sooner the angrier.
   */
  honk: { car: Vehicle; at: Vector3; anger: number };
  /**
   * A vehicle hit something (for the crash sounds): another car, a wall (anything solid, the
   * ground too while it tumbles), or the ground coming down from the air. `dv` is how hard (m/s:
   * the speed it changed by, or fell at; against another car, the harder of what it took and
   * what it dealt). `took` is how hard `v` itself was hit. Contact that grinds on comes every frame.
   */
  impact: { v: Vehicle; at: Vector3; dv: number; took: number; against: 'car' | 'wall' | 'ground' };
  /**
   * Street furniture went: knocked over by a vehicle, smashed to bits (a hedge, a bus shelter), or
   * a falling lamp hitting the ground; `by` is the vehicle that did it, when one did.
   */
  prop: { kind: PropKind; at: Vector3; how: 'knocked' | 'shattered' | 'landed'; by: Vehicle | null };
  /** A monster truck (`by`) broke through a parapet. */
  smashed: { at: Vector3; by: Vehicle };
  /** A monster truck (`by`) flattened a car. */
  crushed: { car: Vehicle; by: Vehicle };
  /** A tire went into Randy's fire and it roared up. */
  stoked: { at: Vector3 };
  /** A puff of smoke (game.puff): someone vanishing in one, or turning up. */
  puff: { at: Vector3 };
  /** Cody picked up money: cash or a wallet off the ground, or cash out of a glovebox. */
  money: { kind: 'cash' | 'wallet' | 'glovebox'; amount: number };
  /** Cody's outfit swap is starting (moonrise, sunrise, or the tutorial's): what he's turning into, and where he is. */
  outfit: { form: Phase; at: Vector3 };
  /** Someone on foot took fright and ran (or a driver bailed out), from where they stood. */
  fright: { at: Vector3 };
  /** Randy's burner: ringing, the call over, a text landing. */
  phone: 'ring' | 'hangup' | 'text';
  crossing: Crossing;
  nightfall: null;
  sunrise: null;
  /** A quest moved on to another step (the tutorial is quest 'tutorial'): for whatever follows along. */
  step: { quest: string; step: string };
  /** One of Cody's actions happened: the action itself, for whatever waits on one (a quest step, an NPC's mind). */
  performed: { action: CodyAction };
  /** One of Cody's actions couldn't happen, and why. */
  failed: { action: CodyAction; reason: string };
};

/** A cutscene takes the camera to `focus` (iso view, zoom `zoom`) and the controls from the player. */
export interface Cutscene {
  focus: Vector3;
  zoom: number;
}

/** Owns the scene, the loop and the day/night game rules. */
export class Game {
  readonly scene = new Scene();
  readonly iso = new IsoCamera();
  readonly chase = new ChaseCamera();
  readonly gfx: GameRenderer;
  readonly input = new Input(KEYS, STICK);
  readonly mats = new MaterialLibrary();
  readonly world: BuiltWorld;
  /** Pathfinding over the collision world, shared by every agent that plans a route. */
  readonly nav: NavGrid;
  /** All route requests (valets, pedestrians, the guidance arrow) queue here. */
  readonly planner: NavPlanner;
  private readonly guide: RouteGuide;
  private readonly navDebug: NavDebug | null = urlFlag('nav') ? new NavDebug() : null;
  readonly clock = new GameClock();
  readonly garage: Garage;
  readonly player: Player;
  readonly vehicles: Vehicle[];
  private readonly fleet: Fleet;
  readonly hud: Hud;
  private readonly dayNight: DayNight;
  private readonly lights: SunLight;
  private readonly pool: LightPool;
  private readonly traffic: Traffic;
  private readonly slime: CubeParticles;
  private readonly debris: CubeParticles;
  private readonly sprites: SpriteFx;
  private readonly valet: ValetService;
  private readonly crowd: Crowd;
  /** Townsfolk driving in to park in the lots, and back out to the traffic. */
  private readonly visitors: Visitors;
  /** Drivers phantom Cody frightens near the deck, running for it (and leaving him cars to possess). */
  private readonly refuge: Refuge;
  private readonly driveWorld: DriveWorld;
  private readonly drivers: Drivers;
  /** Drivers fed up with waiting behind something in their lane, pulling round it. */
  private readonly detours: Detours;
  /** "HONK!" over a honking car's roof. */
  private readonly honks = new Honks();
  /** Dark puffs from some cars' tailpipes as they pull away. */
  private readonly exhaust: Exhaust;
  /** Phantom Cody on foot, or the monster truck, this frame: what frightens people (null by day). */
  /** Who's where this frame, for people on foot to steer around. */
  private readonly avoid = new Avoidance();
  private readonly blood: BloodSim;
  private readonly casualties: Casualties;
  /** Phantom Cody's risen skeletons, hunting townsfolk by night. */
  private readonly skeletons: Skeletons;
  /** Traffic cars knocked loose, and where from: their drivers bail once they stop. */
  private readonly shaken = new Map<Vehicle, Vector3>();
  readonly money: Money;
  /** What Cody's carrying: car parts picked up after smashes, Randy's brisket. */
  readonly inventory = new Inventory();
  /** What the HUD last showed: the inventory's version, and who was by to give things to. */
  private shownInventory = '';
  /** Script triggers on items: has, got, used, gave (see triggers.ts). */
  readonly triggers = new Triggers(this.inventory);
  /** What the objective markers and the minimap point at (scripts set them; see objectives.ts). */
  readonly objectives = new Objectives();
  /** Car parts knocked off in smashes, lying about. */
  private readonly junk: Junk;
  /** Eating brisket makes Cody doze off till the next nightfall or sunrise. The tutorial switches it off for its own brisket. */
  sleepAfterEating = true;
  /** Seconds into a doze, or -1. */
  private doze = -1;
  /** GhASt in the monster truck's tank, 0..1: ghosts it swallowed, burned for boosts. Gone at sunrise. */
  ghast = 0;
  private boosting = false;
  /** Burning GhASt this frame (boost held in the monster truck, with some in the tank). */
  get burning(): boolean {
    return this.boosting;
  }
  /** What Randy sells out of his coat, and how much of it is left. */
  readonly wares = new Wares();
  /** A scene (the tutorial's coat flash) has his wares up, Cody near or not. */
  waresShown = false;
  /** Cody's at Randy's open coat (the shop encounter): only then can he buy. */
  private shopOpen = false;
  /** Randy takes tires for his fire and pays in brisket (the tutorial can run it, or switch it off). */
  readonly tires: TireTrade;
  private readonly shop: Shop;
  /** Talking to Randy at his fire (off while the tutorial runs). */
  readonly randyTalk: RandyTalk;
  /** Cody's phone: Randy's burner, with its apps. */
  readonly phone: Phone;
  /** Randy Rolsen and anyone else hanging about to be talked to (the tutorial finds them here). */
  readonly npcs: Npcs;
  /** The elevators' cabs and doors (the deck's, beside the stair tower). */
  readonly elevators: Elevators;
  /** Cody calling a cab and picking floors. */
  /** The game as Cody's actions see it. */
  private readonly play: Play;
  /** Runs Cody's actions. The keys and the item menu hand it the same objects. */
  private readonly doing = new Doing<Play, Play>({
    lost: () => false,
    end: () => undefined,
    performed: (action) => this.events.emit('performed', { action }),
    failed: (action, reason) => {
      if (reason) this.hud.toast(reason, '', 'warn', FAIL_TOAST);
      this.events.emit('failed', { action, reason });
    },
  });
  /** Offers that scripts add for a while, such as the tutorial's talk with Randy. */
  private readonly offerSources = new Set<() => CodyAction | null>();
  /** Who the cabs carry: Cody, while he's on foot (a list kept, so the per-frame call doesn't allocate). */
  private readonly riders: readonly Vector3[];
  readonly events = new Emitter<GameEvents>();
  /** While set, the camera is the cutscene's and the controls are muted. */
  cutscene: Cutscene | null = null;
  private portraitSet: Portraits | null = null;
  /** Cody's form, abilities, and presence. Scripts can hold his form and grant extra abilities here. */
  readonly cody: CodyState;
  /** What the time of day means for each rule (deck awake, valets on shift, parking, daylight). */
  readonly conditions: WorldConditions;
  /** Who holds what: driver's seats, spots on the way to being parked in, the deck's room for diversions. */
  readonly claims = new Claims<ClaimKind>(CLAIMS);
  /** The owner of the driver's seat Cody holds. It ends when he gets out. */
  private readonly codySeat = { name: 'Cody at the wheel' };
  /** Where everything that perceives or is perceived is, indexed once at the start of each frame. */
  private readonly space = new Space<Thing>(8, LEVEL.person);
  private readonly things: Thing[] = [];
  private readonly reactions: readonly Reaction[];
  /** This frame's space and things, and line of sight through the collision world, floors included. */
  private readonly perception: Perception = {
    space: this.space,
    things: this.things,
    sees: (a, b) => !this.world.collision.segmentBlocked(eyeOf(a), eyeOf(b), true),
  };
  readonly phases = new Phases();
  /** An escaped truck stays Cody's to drive (the tutorial's first ride) instead of rolling to a stop and vanishing. */
  keepEscaped = false;
  /** Trucks already counted as phantoms: a kept one going out again isn't another. */
  private readonly counted = new WeakSet<Vehicle>();
  private readonly ghosts: Ghosts;
  private readonly bats: Bats;
  private readonly arrow = new NavArrow();
  private readonly rng = new Rng(777);
  private readonly fx: FxKit;
  private readonly deckCenter: Vector3;

  private mode: Mode = 'title';
  private readonly cameras = new CameraController({
    snapBehind: (yaw) => this.chase.snapBehind(yaw),
    releasePointer: () => this.input.releasePointer(),
    setView: (view) => this.hud.setCamera(view),
    showMode: (mode, hint) => this.hud.showCamera(mode, hint),
    changed: (mode) => this.events.emit('camera', mode),
  }, wantsTouch());
  readonly debug: ReturnType<typeof createGameDebug>;
  private driving: Vehicle | null = null;
  private transform: TransformSequence | null = null;
  private time = 0;
  private last = 0;
  private flash = 0;
  private readonly flashColor = new Color();
  private readonly cutaway = new Cutaway();
  private exhaustTimer = 0;
  private escapedTimer = -1;
  private codyFx = -1;
  private readonly fpsAcc = { t: 0, n: 0 };
  /** Headless simulation (tests): advance the game without drawing it. */
  /** Drawing frames (`?render=0` starts without, for headless tests: no shaders to compile). */
  private rendering = urlParam('render') !== '0';
  private won = false;
  private readonly talk: ValetTalk;
  private readonly valetFrame: ValetFrame;
  /** The exit gate's zone: routes that should badge in through the entry gate go around it. */
  private readonly exitBlocks: ZoneDef[];
  private readonly entryQuery: NavQuery;
  // per-frame lists, refilled in place rather than reallocated
  /** Everyone and everything taking up room this frame (filled in sense()), and where those in traffic's way and in the AI drivers' way are. */
  private readonly bodies = new Bodies();
  private readonly trafficObstacles: Vector3[] = [];
  private readonly valetObstacles: Obstacle[] = [];
  private readonly movers: Vector3[] = [];
  private readonly blockers: { pos: Vector3; r: number }[] = [];
  /** Background transformations (sunrise reverting trucks to cars). */
  private readonly morphs: TransformSequence[] = [];
  /** The car Cody last got out of: what a valet takes when Cody talks to him on foot. */
  private lastCar: Vehicle | null = null;

  /** The dialogue portraits, rendered on first use (a few offscreen renders: ask before a conversation, not during one). */
  get portraits(): Portraits {
    return (this.portraitSet ??= makePortraits(this.gfx.renderer, () => this.assets.character()));
  }

  constructor(
    container: HTMLElement,
    level: LevelData,
    private readonly assets: AssetRegistry,
  ) {
    this.gfx = new GameRenderer(container, this.scene, this.iso, this.chase);
    this.input.attachPointer(this.gfx.renderer.domElement, () => this.chaseActive);
    this.iso.camera.layers.enable(FX_LAYER);
    this.chase.camera.layers.enable(FX_LAYER);

    this.lights = new SunLight(this.scene, urlChoice('q', ['low', 'high']) === 'high');

    this.world = buildWorld(level, this.mats);
    this.scene.add(this.world.root);
    this.elevators = new Elevators(level.elevators, this.world.collision, this.mats);
    this.scene.add(this.elevators.root);
    this.nav = NavGrid.build(this.world.collision, level);
    this.nav.elevators = this.elevators;
    this.world.interiors.attach(this.elevators);
    // Headless tests step the frames themselves (?manual): there a plan finishes by the next frame
    // however busy the machine is, so a run doesn't depend on its speed.
    this.planner = urlFlag('manual') ? new NavPlanner(this.nav, Infinity) : new NavPlanner(this.nav);
    this.guide = new RouteGuide(this.planner);
    console.info(`[nav] ${this.nav.nx}x${this.nav.nz} cells in ${this.nav.buildMs.toFixed(0)} ms`);
    if (this.navDebug) this.scene.add(this.navDebug.root);
    this.pool = new LightPool(this.world.emitters, 6);
    this.scene.add(this.pool.root);

    this.dayNight = new DayNight({
      scene: this.scene,
      gfx: this.gfx,
      mats: this.mats,
      hemi: this.lights.hemi,
      sun: this.lights.sun,
      pool: this.pool,
      decalLevel: (lamps, slime) => {
        this.world.lampDecals.color.setScalar(lamps);
        this.world.puddleDecals.color.setScalar(0.35 + slime * 0.65);
      },
    });

    this.garage = new Garage(level.spots, level.deck, this.world.gates, () => VEHICLE_BREEDS.truck.model(assets, ''));
    this.scene.add(this.garage.root);
    this.traffic = new Traffic(level.paths);
    this.fleet = new Fleet(this.scene, assets, this.garage, this.traffic, this.rng);
    this.vehicles = this.fleet.vehicles;
    const d = level.deck;
    this.deckCenter = new Vector3((d.min[0] + d.max[0]) / 2, 0, (d.min[2] + d.max[2]) / 2);

    this.player = new Player(assets.character());
    this.scene.add(this.player.root);
    this.player.place(new Vector3(...level.playerSpawn), Math.PI);
    this.riders = [this.player.pos];
    this.cody = new CodyState(this.player);
    this.conditions = new WorldConditions(this.clock);

    this.slime = new CubeParticles(softInk(withCutaway(new MeshBasicMaterial({ toneMapped: false }))), 600);
    this.debris = new CubeParticles(withCutaway(new MeshStandardMaterial({ roughness: 0.9 })), 300, 34);
    this.sprites = new SpriteFx(120);
    this.exhaust = new Exhaust(this.sprites);
    this.exitBlocks = level.gates.filter((g) => g.kind === 'exit').map((g) => ({ min: g.min, max: g.max }));
    this.entryQuery = { blocks: this.exitBlocks };
    // Every AI driver's job at the wheel runs on one runner, driving through the game the same way.
    this.driveWorld = {
      claims: this.claims,
      planner: this.planner,
      nav: this.nav,
      garage: this.garage,
      fleet: this.fleet,
      entryOnly: this.exitBlocks,
      obstacles: () => this.valetObstacles,
      roadAhead: (car, meters, step) => this.traffic.roadAhead(car, meters, step),
      onRoad: (car) => this.traffic.onRoad(car),
      rejoin: (car, from) => this.traffic.rejoin(car, from),
      steer: (car, input, dt) => {
        const prev = _drivePrev.copy(car.pos);
        this.drove(car, car.drive(dt, input, this.world.collision), NUDGE_LOOSEN);
        return this.garage.track(car, prev)?.kind === 'logged-in';
      },
      place: (car, at, yaw, dt) => car.place(at.x, at.y, at.z, yaw, 0, dt, this.world.collision),
      alive: (car) => this.fleet.vehicles.includes(car),
      bail: (car, from) => this.crowd.bail(car, from),
      wrecked: (car, from) => this.shaken.set(car, from.clone()),
      parked: (_car, s) => this.hud.toast('SPOOKED INTO THE DECK', spotLabel(s), 'purple', 1.6),
    };
    this.drivers = new Drivers(this.driveWorld);
    this.valet = new ValetService(level.valets, this.planner, this.nav, this.garage, this.drivers);
    this.scene.add(this.valet.root);
    this.valet.walkBlocks = () => parkedBlocks(this.vehicles);
    this.money = new Money(this.scene, this.nav, this.rng);
    this.money.scatter();
    this.junk = new Junk(this.scene, this.nav, this.rng);
    // Randy only ever throws Cody's badge: it lies where it lands, sauced, till he picks it up
    this.npcs = new Npcs(level.npcs, this.scene, {
      landed: (item, floor) => this.junk.lay('badge', item, floor),
      ground: (x, z, below) => this.world.collision.groundAt(x, z, below, 0),
      burned: (at) => {
        _at.copy(at).setY(at.y + 1);
        this.sprites.spray(_at, 7, 0.7, [1.2, 2.6], TIRE_SMOKE, 0.35, 1.5, [1.4, 2.4], 'puff', 0.85);
        this.debris.burst(_at, 14, 2.5, [0.03, 0.07], [0.6, 1.3], EMBER, 2.2, at.y);
        this.events.emit('stoked', { at: at.clone() });
      },
      // the brisket was his the moment he handed the tires over; the toast waits for the show
      fed: (n) => this.hud.toast(`+${n} BRISKET`, n > 1 ? 'NOW THAT IS A FIRE' : 'NOW WE ARE COOKING', 'purple', TRADE_TOAST),
    });
    this.shop = new Shop(this.npcs);
    this.tires = new TireTrade(this.npcs, this.inventory, {
      gave: (n, to) => this.deed({ how: 'gave', kind: 'tire', n, to: to.def.id }),
      paid: (n) => this.gain('brisket', n),
    });
    // people cars hit: ragdolls, and the blood they leave
    this.blood = new BloodSim(this.world.collision);
    this.scene.add(this.blood.root);
    this.casualties = new Casualties(this.world.collision, this.blood);
    this.crowd = new Crowd(this.scene, this.planner, this.nav, this.rng, (at, kind, from) => this.money.drop(at, kind, from), this.casualties);
    this.reactions = gameReactions({ crowd: this.crowd, drivers: { frighten: (v, from) => this.frightenDriver(v, from) } });
    this.crowd.onFright = (at) => this.events.emit('fright', { at: at.clone() });
    // skeletons: dirt as they climb out, bones as they fall apart, a ghost from everyone they kill
    this.skeletons = new Skeletons(this.world.collision, this.nav, this.planner, this.crowd);
    this.scene.add(this.skeletons.root);
    this.skeletons.onRise = (at) => {
      this.debris.burst(_at.copy(at).setY(at.y + 0.2), 14, 5, [0.1, 0.25], [0.8, 1.5], DIRT, 0.9, at.y);
      this.slime.burst(at, 8, 3, [0.08, 0.16], [0.5, 0.9], SLIME, 0.6, at.y);
    };
    this.skeletons.onCrumble = (at) => {
      this.debris.burst(_at.copy(at).setY(at.y + 0.9), 18, 4, [0.08, 0.22], [1.5, 2.5], BONE, 0.5, at.y);
    };
    this.skeletons.onKill = (at) => {
      this.sprites.spray(_at.copy(at).setY(at.y + 0.6), 3, 2, [1.6, 2.6], WHITE, 1.2, 2.4, 1.4, 'ghost', 0.8);
      this.ghosts.rise(at);
    };
    // they park in the lots, never in the deck
    const keepOut = [{ min: level.deck.min, max: level.deck.max }];
    this.visitors = new Visitors(level.bays, this.planner, this.fleet, this.traffic, this.drivers, this.rng, keepOut, (car) => this.crowd.arrive(car));
    // frightened drivers run for the deck through its entry gate (or, in a level without one, its middle)
    const gate = level.gates.find((g) => g.kind === 'entry');
    const entry = gate ? new Vector3((gate.min[0] + gate.max[0]) / 2, gate.min[1], (gate.min[2] + gate.max[2]) / 2) : this.deckCenter.clone();
    this.garage.bookedBy = (s) => this.claims.holder('spot', s);
    // a car standing still in a spot holds it too, parked or not (Cody sitting in it at the wheel)
    this.garage.standingIn = (spot) => this.vehicles.find((v) => !v.gone && Math.abs(v.speed) < STANDING && inSpot(spot, v.pos)) ?? null;
    this.refuge = new Refuge(this.drivers, this.driveWorld, entry);
    this.detours = new Detours(this.planner, this.nav, this.world.collision, this.fleet, this.traffic, (car, ev) => this.drove(car, ev, NUDGE_LOOSEN));
    this.ghosts = new Ghosts(level.ghostZones, 28);
    this.bats = new Bats(new Vector3(this.deckCenter.x, 0, this.deckCenter.z), 16);
    this.scene.add(this.slime.mesh, this.debris.mesh, this.sprites.root, this.ghosts.root, this.bats.root, this.arrow.root, this.honks.root);
    this.fx = {
      scene: this.scene,
      slime: this.slime,
      sprites: this.sprites,
      shake: (t) => this.shake(t),
      flash: (a, c) => this.doFlash(a, c),
    };
    const drips = this.world.slime;
    drips.onSplat = () => {
      _splatSize[0] = drips.splatSize * 0.25;
      _splatSize[1] = drips.splatSize * 0.5;
      this.slime.burst(_splat.copy(drips.splat).setY(drips.splat.y + 0.05), 4, 1.6, _splatSize, SPLAT_LIFE, SLIME, 0.5, drips.splat.y);
    };
    this.world.gates.onSnapped = (g, kind) => this.events.emit('prop', { kind, at: g.center.clone(), how: 'knocked', by: null });
    const props = this.world.props;
    props.onLanded = () => {
      const p = props.landed;
      _spark.copy(props.landedColor).multiplyScalar(2.5);
      this.slime.burst(p, 16, 6, SPARK_SIZE, SPARK_LIFE, _spark, 0.8, this.world.collision.groundAt(p.x, p.z, p.y + 0.5, 0));
      if (props.landedKind) this.events.emit('prop', { kind: props.landedKind, at: p.clone(), how: 'landed', by: null });
    };
    // whoever smashed it, it flies apart from all through the room it filled
    props.onBroken = () => {
      const lo = props.brokenMin;
      const hi = props.brokenMax;
      const colors = props.brokenKind?.debris ?? [METAL];
      const by = this.vehicles.find((v) => v === props.brokenBy) ?? null;
      if (props.brokenKind) this.events.emit('prop', { kind: props.brokenKind, at: new Vector3().lerpVectors(lo, hi, 0.5), how: 'shattered', by });
      const n = clamp(Math.round((hi.x - lo.x) * (hi.y - lo.y) * (hi.z - lo.z) * SHATTER.perM3), ...SHATTER.count);
      const floor = this.world.collision.groundAt((lo.x + hi.x) / 2, (lo.z + hi.z) / 2, lo.y + 0.5, 0);
      for (let i = 0; i < n; i++) {
        _v.set(lerp(lo.x, hi.x, Math.random()), lerp(lo.y, hi.y, Math.random()), lerp(lo.z, hi.z, Math.random()));
        const a = Math.random() * TAU;
        const out = Math.random() * SHATTER.out;
        _w.set(Math.cos(a) * out, lerp(SHATTER.up[0], SHATTER.up[1], Math.random()), Math.sin(a) * out);
        const size = lerp(SHATTER.size[0], SHATTER.size[1], Math.random());
        this.debris.spawn(_v, _w, size, SHATTER.life, colors[i % colors.length] as Color, floor);
      }
    };

    playEffects(this.events, {
      ride: () => this.driving,
      shake: (t) => this.shake(t),
      toast: (title, sub, tone, seconds) => this.hud.toast(title, sub, tone, seconds),
      slime: this.slime,
      debris: this.debris,
      sprites: this.sprites,
    });

    for (const p of level.parked) {
      // one already sitting in a deck spot was badged in like any other
      const v = this.fleet.spawnCar('parked', new Vector3(...p.pos), p.yaw);
      const s = this.garage.spotAt(v.pos);
      if (s && this.garage.isFree(s)) this.garage.checkIn(s, v);
    }
    // the cars in the lots belong to people in town, who come back for them
    this.visitors.adopt();
    for (let i = 0; i < TUNING.traffic.dayCars; i++) this.fleet.spawnTraffic(this.view.target, 0);

    this.hud = new Hud(container, this.input.focus);
    // what the status displays show, read each frame
    this.hud.bind({
      mode: () => (this.mode === 'title' ? 'title' : this.driving || this.transform ? 'drive' : 'foot'),
      summon: () => this.mode === 'play' && this.onFoot && this.cody.can('summon'),
      hours: () => this.clock.hours,
      phase: () => this.clock.phase,
      day: () => this.clock.day,
      cash: () => this.money.cash,
      ledger: () => ({ logged: this.garage.logged, actual: this.garage.actual(this.vehicles), phantom: this.garage.phantomOccupancy(this.vehicles), max: TUNING.garage.spots }),
      // tumbling in a crash isn't flying: no AIRBORNE badge for it
      dash: () => {
        const v = this.driving;
        if (v) return { speed: v.speed, form: v.form, label: v.breed.label, airborne: !v.grounded && !v.crashing };
        return this.transform ? { speed: 0, form: 'truck', label: VEHICLE_BREEDS.truck.label, airborne: false } : null;
      },
      // the GhASt dial (and the touch BOOST button) while he's driving the monster truck
      ghast: () => (this.driving?.form === 'truck' ? { fill: this.ghast, burning: this.boosting } : null),
    });
    // Cody's phone, Randy's burner, and its apps; it rings, hangs up and buzzes as the game's 'phone' event
    this.phone = new Phone(this.hud.root, this.input.focus, { time: () => GameClock.format(this.clock.hours) }, new Messages(), [
      new Tasks({ goal: () => this.phone.goalText, aim: () => `FILL ALL ${TUNING.garage.spots} SPOTS WITH PHANTOMS.`, marks: () => this.objectives.list }),
      new Phantoms(() => this.phantomReport()),
      new MapApp(),
      new Photos(),
      new Help(helpRows),
    ]);
    this.phone.onBuzz = (what) => this.events.emit('phone', what);
    this.hud.initMap(level);
    this.hud.onStart(() => this.start());
    this.hud.onItemAction = (kind, id) => {
      if (!isItemKind(kind)) return;
      const offer = this.itemOffers(kind).find((o) => o.id === id);
      if (offer) this.doing.do(this.play, offer.action);
    };
    this.hud.onBuy = (slot, n) => this.buy(slot, n);
    this.hud.setCamera(this.cameras.view);
    this.play = this.makePlay();
    this.talk = new ValetTalk(this.hud, this.garage, this.valet, this.rng, this.input.focus, {
      me: () => (this.driving ?? this.player).pos,
      onShift: () => this.conditions.valetsOnShift(),
      carToTake: () => this.carForValet(),
      handOff: (car) => {
        if (this.driving === car) this.exit();
        if (this.lastCar === car) this.lastCar = null;
      },
      cash: () => this.money.cash,
      pay: (amount) => this.money.spend(amount),
    });
    this.randyTalk = new RandyTalk(this.input.focus, this.npcs, {
      tires: () => this.inventory.count('tire'),
      give: (to) => 'done' in this.doing.do(this.play, new GiveTires({ to, name: NPC_NAMES[to.def.id] })),
    });
    this.valetFrame = {
      day: true,
      avoid: this.avoid,
      parked: (_v, s, valet) => this.talk.parked(s, valet),
    };

    // attract mode: the deck at night, slowly orbiting
    this.clock.hours = 21.5;
    this.clock.paused = true;
    this.player.setForm('night');
    this.iso.zoom = this.iso.zoomTarget = 74;
    this.iso.snapTo(new Vector3(this.deckCenter.x, 6, this.deckCenter.z));
    this.debug = createGameDebug(this, {
      driving: () => this.driving,
      mode: () => this.mode,
      render: (on) => { this.rendering = on; },
      navDebug: this.navDebug,
      refuge: this.refuge,
      roadAt: (car, meters) => this.traffic.roadAt(car, meters),
      frighten: (car, from) => this.frightenDriver(car, from),
    });
    (window as unknown as { __game: Game }).__game = this;
  }

  run(): void {
    const loop = (now: number): void => {
      const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : 0.016);
      this.last = now;
      this.frame(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** The chase camera is on screen this frame. */
  private get chaseActive(): boolean {
    return this.cameras.view === 'chase';
  }

  private get view(): IsoCamera | ChaseCamera {
    return this.chaseActive ? this.chase : this.iso;
  }

  /** What Cody is driving, or the car turning into a truck around him. */
  private get ride(): Vehicle | null {
    return this.driving ?? this.transform?.vehicle ?? null;
  }

  /** Scripted camera changes leave the player's saved preference intact. */
  setCamera(mode: CamMode): void {
    this.cameras.set(mode);
    this.syncView();
  }

  private cycleCamera(): void {
    this.cameras.cycle();
    this.syncView();
  }

  /** Synchronize at frame start so mid-frame changes use a freshly positioned camera. */
  private syncView(): void {
    this.cameras.sync(this.mode === 'play', this.cutscene !== null, this.ride, this.player.yaw);
  }

  get cameraMode(): CamMode {
    return this.cameras.mode;
  }

  /**
   * Cody gets in `v` as if he'd walked up to it and pressed F (scripted scenes), out of whatever
   * he was driving first. `own`: it's his own car, with nothing in the glovebox for him to find.
   */
  board(v: Vehicle, own = false): void {
    if (this.driving === v) return;
    if (this.driving) this.exit(true);
    if (own) this.money.empty(v);
    this.enter(v);
  }

  /** A parked civilian car (scripted scenes): `kind` picks one, else the usual mix. */
  park(pos: Vector3, yaw: number, kind?: CarKind): Vehicle {
    return this.fleet.spawnCar('parked', pos, yaw, kind);
  }

  /** Cody gets out of whatever he's driving, if anything (scripted: quietly, no PARKED toast). */
  alight(): void {
    if (this.driving) this.exit(true);
  }

  /** Cody's outfit change, now, to suit the time of day. */
  transformCody(): void {
    this.codyFx = 0;
  }

  /** Ghosts and slime: cleared out (the tutorial's first evening), or oozing back in over `seconds`. */
  haunt(on: boolean, seconds = 0): void {
    this.ghosts.fade(on, seconds);
    if (on && seconds > 0) this.world.slime.emerge(seconds);
    else this.world.slime.setPresence(on ? 1 : 0);
  }

  private shake(t: number): void {
    this.view.addTrauma(t);
  }

  /** Advance one frame (also used by headless tests). */
  frame(dt: number): void {
    this.time += dt;
    Vehicle.advance(dt);
    this.syncView();
    if (this.mode === 'title') this.updateTitle(dt);
    else this.updatePlay(dt);
    this.updateShared(dt);
    this.phases.enter('present');
    this.hud.update();
    this.phone.update();
    this.gfx.chaseView = this.chaseActive;
    if (this.rendering) this.gfx.render(this.time);
    this.input.endFrame();
    this.fpsAcc.t += dt;
    this.fpsAcc.n++;
    if (this.fpsAcc.t > 0.5) {
      this.hud.setFps(this.fpsAcc.n / this.fpsAcc.t, `${this.world.stats.meshes} meshes ${Math.round(this.world.stats.triangles / 1000)}k tris`);
      this.fpsAcc.t = 0;
      this.fpsAcc.n = 0;
    }
  }

  start(): void {
    this.phone.setAvatar(this.portraits.randy);
    if (this.mode === 'play') return;
    this.mode = 'play';
    this.clock.paused = false;
    this.clock.hours = TUNING.clock.startHour;
    this.player.setForm('day');
    this.iso.zoomTarget = TUNING.camera.zoom;
    this.iso.azimuthTarget = Math.round((this.iso.azimuth - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 4;
    this.chase.snapBehind(this.player.yaw);
    this.announceDay();
    this.events.emit('start', null);
  }

  /** The day's title card. */
  announceDay(): void {
    this.hud.toast(`DAY ${this.clock.day}`, 'STEAL CARS. BADGE THEM IN. PARK THEM IN THE DECK.', '', 3.2);
  }

  /**
   * Put back a phantom from a save (game/save.ts). A car parked in its spot again gives way, and
   * that car's badge-in stays on the log as the phantom's; any other phantom is one more entry
   * nobody scanned out. Either way the phantom occupancy goes up by one, as it did in play.
   */
  restorePhantom(spotId: number | null, at: Vector3, yaw: number): void {
    const spot = spotId !== null ? (this.garage.spots[spotId] ?? null) : null;
    const home = spot && !spot.phantom ? spot : null;
    const car = home?.occupant ?? null;
    if (car) this.fleet.remove(car);
    else this.garage.logged++;
    this.garage.addPhantom(at, yaw, home);
  }

  // ---------------------------------------------------------------- title

  private updateTitle(dt: number): void {
    this.iso.azimuthTarget += dt * 0.12;
    this.iso.update(dt, _v.set(this.deckCenter.x, 7, this.deckCenter.z), null, 2);
    this.traffic.update(dt, this.vehicles, NONE);
    // nobody honks or pulls round under the title
    this.traffic.honks.length = 0;
    this.traffic.fedUp.length = 0;
    this.cutaway.off();
    // after the orbit nudge, so it can't undo start()'s camera snap
    if (this.input.wasPressed('start')) this.start();
  }

  // ---------------------------------------------------------------- play

  /** Whether Cody is on his feet: not driving, and not inside a car that's turning into the truck. */
  private get onFoot(): boolean {
    return !this.driving && !this.transform;
  }

  /** Indexes everything that perceives or is perceived, where it stands at the start of the frame. */
  private sense(): void {
    const things = this.things;
    things.length = 0;
    const seen = this.cody.presence(this.driving, !!this.transform);
    if (seen?.kind === 'phantom') things.push({ kind: 'phantom', pos: seen.at });
    else if (seen?.kind === 'phantomTruck' && this.driving) things.push({ kind: 'phantomTruck', pos: seen.at, vehicle: this.driving });
    for (const pos of this.skeletons.threats) things.push({ kind: 'skeleton', pos });
    for (const person of this.crowd.living()) things.push({ kind: 'townsperson', pos: person.walker.pos, person });
    for (const vehicle of this.vehicles) {
      const driven = vehicle.role === 'traffic' || !!this.drivers.of(vehicle) || this.detours.has(vehicle);
      if (driven && !vehicle.crashing) things.push({ kind: 'driver', pos: vehicle.pos, vehicle });
    }
    this.space.rebuild(things);
    this.senseBodies();
  }

  /** Who and what takes up room this frame, each system adding its own. */
  private senseBodies(): void {
    const b = this.bodies;
    b.clear();
    this.crowd.addBodies(b);
    this.valet.addBodies(b);
    for (const n of this.npcs.list) {
      b.add({ kind: 'still', pos: n.pos, r: NPC_ROOM });
      if (n.fire) b.add({ kind: 'still', pos: n.fire.root.position, r: FIRE_ROOM });
    }
    // walkers steer round skeletons (cars don't brake for them: knocking them flying is the point)
    for (const pos of this.skeletons.threats) b.add({ kind: 'skeleton', pos, r: PERSON_RADIUS });
    if (this.onFoot && this.player.visible) b.add({ kind: 'cody', pos: this.player.pos, vel: this.player.vel, r: TUNING.player.radius });
    for (const v of this.vehicles) if (!v.gone) b.add({ kind: 'car', pos: v.pos, vel: v.vel, r: v.params.radius, vehicle: v });
  }

  /** A driver sees phantom Cody or the phantom truck at `from` this frame: one doing a job at the wheel, one pulling round, or one in traffic. */
  private frightenDriver(v: Vehicle, from: Vector3): void {
    if (this.drivers.sees(v, from)) return;
    if (this.detours.has(v)) this.detours.frighten(v, from);
    else this.traffic.frighten(v, from);
  }

  private updatePlay(dt: number): void {
    const inp = this.input;
    inp.muted = !!this.cutscene;
    this.clock.rate = inp.isDown('fastForward') ? TUNING.clock.fastForward : 1;
    if (inp.wasPressed('nextPhase')) this.clock.skipToNextPhase();
    const ev = this.clock.update(dt);
    if (ev.nightfall) this.onNightfall();
    if (ev.sunrise) this.onSunrise();
    if (inp.wasPressed('camera')) this.cycleCamera();
    if (!this.chaseActive) {
      if (inp.wasPressed('rotateLeft')) this.iso.rotate(-1);
      if (inp.wasPressed('rotateRight')) this.iso.rotate(1);
    }
    if (inp.wasPressed('phone')) this.phone.toggle();
    if (inp.wasPressed('help')) this.phone.toggle('help');
    if (inp.wasPressed('reload')) reloadIfPending();
    const wheel = inp.consumeWheel();
    if (wheel) this.view.zoomBy(wheel);
    // read every frame so movement made in the iso view can't jump the chase camera later
    const [mx, my] = inp.consumeMouse();

    // Sense: index where everything is before anything moves this frame.
    this.phases.enter('sense');
    this.claims.newFrame();
    this.sense();
    // Act: the systems below still decide and move in one pass; later stages split them.
    this.phases.enter('act');

    // the cabs move first, carrying Cody if he's standing in one
    this.elevators.update(dt, this.driving || this.transform ? NONE : this.riders);
    if (this.transform) {
      this.transform.update(dt);
      if (this.transform.done) {
        const v = this.transform.vehicle;
        v.role = 'player';
        this.driving = v;
        this.transform = null;
      }
    } else if (this.driving) {
      this.updateDriving(dt);
    } else {
      this.updateOnFoot(dt);
    }

    this.updateMorphs(dt);
    this.updateCodyFx(dt);
    // Phantom Cody and the phantom truck frighten pedestrians and drivers. The reactions table
    // decides who takes fright; pedestrians flee, and drivers accelerate or abandon their cars if blocked.
    const seen = this.cody.presence(this.driving, !!this.transform);
    const ghost = seen && FRIGHTENING.has(seen.kind) ? seen.at : null;
    react(this.perception, this.reactions);
    // traffic brakes for Cody and for people under way or down in the road
    const obstacles = this.bodies.points((b) => b.kind === 'cody' || b.kind === 'down' || (b.kind === 'person' && b.moving), this.trafficObstacles);
    this.traffic.update(dt, this.vehicles, obstacles);
    for (const v of this.traffic.abandoned.splice(0)) {
      this.crowd.bail(v, ghost ?? v.pos);
      this.fleet.abandon(v);
    }
    // A frightened driver whose road leads toward the fright may turn off for the deck, if it's just ahead.
    for (const { car } of this.traffic.scared.splice(0)) this.events.emit('spooked', { car });
    for (const { car, from } of this.traffic.cornered.splice(0)) this.refuge.take(car, from);
    // held up behind something going nowhere: they honk, then pull round it
    for (const v of this.traffic.honks.splice(0)) this.honk(v);
    for (const j of this.traffic.fedUp.splice(0)) this.detours.take(j);
    this.fillAvoidance();
    this.crowd.update(dt, {
      near: this.view.target,
      day: this.conditions.daylight(),
      driving: this.driving,
      vehicles: this.vehicles,
      avoid: this.avoid,
      visitors: this.visitors,
    });
    // skeletons keep near Cody (on foot, or in whatever he's driving); daylight finishes them
    if (this.conditions.daylight() && this.skeletons.count) this.skeletons.crumbleAll();
    this.skeletons.update(dt, this.driving ? this.driving.pos : this.player.pos, this.vehicles);
    this.collectMoney(dt);
    // what whoever Cody's talking to says, over their head
    const me = (this.driving ?? this.player).pos;
    const said = this.talk.update(dt, me) ?? this.randyTalk.update(dt, me);
    const head = said && this.toScreen(said.at);
    this.hud.setBubble(said && head ? { ...head, who: said.who, line: said.line, choices: said.choices } : null);
    this.fleet.update(dt, this.dayNight.nightness);
    this.fleet.maintain(dt, this.view.target, this.conditions.daylight());

    // focus, cutaway, camera
    const focusV = this.ride;
    const cut = this.cutscene;
    const focus = cut ? cut.focus : focusV ? focusV.pos : this.player.pos;
    // the iso rig keeps tracking under the chase camera, so switching back with C doesn't swoop
    const lead = focusV && !cut ? _w.set(clamp(focusV.vel.x * 0.35, -7, 7), 0, clamp(focusV.vel.z * 0.35, -7, 7)) : null;
    if (cut) this.iso.zoomTarget = cut.zoom;
    this.iso.update(dt, focus, lead, cut ? 2.5 : focusV ? 5 : 6);
    if (this.chaseActive) {
      const kind: ChaseKind = focusV ? focusV.form : 'foot';
      const subject = { kind, pos: focus, vel: focusV ? focusV.vel : this.player.vel, yaw: focusV ? focusV.yaw : null };
      this.chase.look(mx, my);
      this.chase.update(dt, subject, inp.axis('rotateLeft', 'rotateRight'), this.world.collision);
    }
    // a chase camera pulled in close goes through Cody rather than staring at his back
    this.player.seenFrom(this.chaseActive && !focusV ? this.chase.camera.position : null, dt);
    // the ghost pass draws a faded Cody and the phantom trucks over the sky band
    this.gfx.ghost.enabled = this.player.faded || this.garage.phantoms > 0;
    if (this.chaseActive) this.cutaway.off();
    else this.cutaway.update(dt, focus, focusV, this.iso, this.world.collision, this.world.sight);
    this.updateNav(dt);
    this.updateObjectives();

    if (!this.won && this.garage.phantoms >= TUNING.garage.spots) {
      this.won = true;
      this.hud.showVictory();
    }
    this.events.emit('frame', dt);
  }

  /** Who's where for people on foot to steer around: the bodies, each as walkers dodge it. */
  private fillAvoidance(): void {
    const a = this.avoid;
    a.clear();
    this.bodies.each((b) => {
      if (b.kind === 'person') a.person(b.pos, b.vel, b.dodges, b.owner);
      else if (b.kind === 'cody') a.mover(b.pos, b.vel, b.r);
      else if (b.kind === 'car' && b.vehicle) a.vehicle(b.vehicle);
      else a.still(b.pos, b.r);
    });
  }

  /** Money Cody walks or drives over is his; car parts he walks over go in his inventory. */
  private collectMoney(dt: number): void {
    const M = TUNING.money;
    const me = this.driving ? this.driving.pos : this.transform ? null : this.player.pos;
    for (const got of this.money.update(dt, me, this.driving ? M.reachCar : M.reachFoot)) this.events.emit('money', { kind: got.kind, amount: got.amount });
    const onFoot = this.driving || this.transform ? null : this.player.pos;
    for (const kind of this.junk.update(dt, onFoot)) {
      this.gain(kind, 1);
      this.gotToast(kind);
    }
    this.updateShop(onFoot && this.mode === 'play' && !this.cutscene ? onFoot : null);
    // The HUD's item list shows what Cody could do with each item now, and redraws when that or his items change.
    const items = this.inventory.list().map(([kind, count]) => ({ kind, count, offers: this.itemOffers(kind) }));
    const shown = `${this.inventory.version}:${items.map(({ offers }) => offers.map(({ label }) => label).join(',')).join(';')}`;
    if (shown !== this.shownInventory) {
      this.shownInventory = shown;
      this.hud.setInventory(
        items.map(({ kind, count, offers }) => ({
          kind,
          name: ITEM_BREEDS[kind].name,
          icon: ITEM_BREEDS[kind].icon,
          count,
          note: ITEM_BREEDS[kind].note,
          actions: offers.map(({ id, label }) => ({ id, label })),
        })),
      );
    }
  }

  /** Cody at Randy's wares (the shop encounter), or a scene showing them: the wares menu is up. */
  private updateShop(cody: Vector3 | null): void {
    this.shopOpen = this.shop.update(cody) !== null;
    // a scene showing his wares (the tutorial's coat flash) shows them whatever else is going on, but only the shop sells
    const show = this.shopOpen || this.waresShown;
    this.hud.setWares(show ? { title: "RANDY'S WARES", slots: this.wares.view(this.money.cash, this.shopOpen) } : null);
  }

  /** Randy hands Cody one `kind` out of his coat for nothing (the burner, in the tutorial): out of his wares, into the inventory. False if he has none. */
  handOver(kind: ItemKind): boolean {
    const s = this.wares.slotOf(kind);
    if (!s) return false;
    s.count--;
    this.gain(kind, 1);
    this.gotToast(kind);
    return true;
  }

  /** The toast for one `kind` come by: its name, and its line if it has one. */
  private gotToast(kind: ItemKind): void {
    const { name, note } = ITEM_BREEDS[kind];
    this.hud.toast(`+ ${name}`, note ?? '', '', note ? TRADE_TOAST : MONEY_TOAST);
  }

  /** Cody buys `n` from a slot of Randy's wares: as many as there are, and as he can pay for. */
  private buy(slot: string, n: number): void {
    const one = this.shopOpen ? this.wares.slots.find((s) => s.id === slot) : undefined;
    if (!one) return;
    const price = this.wares.price(one.kind);
    // Free items such as the burner are always affordable. Dividing by a zero price would make cash NaN.
    const afford = price > 0 ? Math.floor(this.money.cash / price) : n;
    const got = this.wares.take(slot, n, afford);
    if (!got || !this.money.spend(got.cost)) return;
    this.gain(got.kind, got.n);
    this.hud.toast(`+${got.n} ${ITEM_BREEDS[got.kind].name}`, `-$${got.cost}`, '', MONEY_TOAST);
  }

  /** Cody comes by `n` of an item (picked up, or handed it). */
  private gain(kind: ItemKind, n: number): void {
    this.inventory.add(kind, n);
    this.deed({ how: 'got', kind, n });
  }

  /** Something Cody did with an item: for the triggers and anyone listening. */
  private deed(d: ItemDeed): void {
    this.events.emit('item', d);
    this.triggers.deed(d);
  }

  private updateOnFoot(dt: number): void {
    const blockers = this.blockers;
    let n = 0;
    for (const v of this.vehicles) {
      if (v.gone) continue;
      const b = (blockers[n++] ??= { pos: v.pos, r: 0 });
      b.pos = v.pos;
      b.r = v.params.length * 0.42;
    }
    // Randy and his trash can fire stand in Cody's way wherever the tutorial puts them
    for (const npc of this.npcs.list) {
      const b = (blockers[n++] ??= { pos: npc.pos, r: 0 });
      b.pos = npc.pos;
      b.r = NPC_ROOM;
      if (!npc.fire) continue;
      const f = (blockers[n++] ??= { pos: npc.fire.root.position, r: 0 });
      f.pos = npc.fire.root.position;
      f.r = FIRE_ROOM;
    }
    blockers.length = n;
    this.player.update(dt, this.input, this.view, this.world.collision, blockers);
    this.interact();
  }

  /** Adds a script's offer, such as the tutorial's talk with Randy. The returned function removes it. */
  addOffer(source: () => CodyAction | null): () => void {
    this.offerSources.add(source);
    return () => this.offerSources.delete(source);
  }

  /**
   * Cody's offers this frame. The prompt shows the best offer for each key, and pressing a key
   * performs the offer the prompt showed. A key with nothing to offer shows the reason, if any.
   * Keys a focus layer takes never reach here: the layer gets them instead.
   */
  private interact(): void {
    const { offers, refusals } = bestOffers(this.play, this.codyCandidates());
    // A conversation, sign or menu that has a key right now owns it, so the prompt doesn't offer it.
    const shown = PROMPT_CONTROLS.flatMap((control) => {
      const offer = offers.get(control);
      return offer?.label && !this.input.focus.owns(control) ? [offer] : [];
    });
    const [first] = shown;
    this.hud.setPrompt(first ? shown.map(({ control, label }) => `{${control}} ${label}`).join(' &nbsp;') : null, first?.control);
    for (const control of ACT_CONTROLS) {
      if (!this.input.wasPressed(control)) continue;
      const offer = offers.get(control);
      const reason = refusals.get(control);
      if (offer) this.doing.do(this.play, offer.action);
      else if (reason) this.hud.toast(reason, '', 'warn', FAIL_TOAST);
    }
  }

  /** Everything Cody might do with a key right now, before resolving. Nearest vehicles come first. */
  private codyCandidates(): CodyCandidate[] {
    if (this.mode !== 'play' || this.talk.active || this.randyTalk.active || this.cutscene || this.transform) return [];
    const out: CodyCandidate[] = [];
    const v = this.driving;
    if (v) {
      const { handOverSpeed, talkReach } = TUNING.valet;
      const valet = v.form === 'car' && v.grounded && Math.abs(v.speed) < handOverSpeed ? this.valet.talkable(v.pos, talkReach.car, this.conditions.valetsOnShift()) : null;
      if (valet) out.push({ control: 'interact', rank: RANK.valet, action: new TalkToValet({ valet }) });
      out.push({ control: 'interact', rank: RANK.getOut, action: new GetOut({ car: v }) });
      if (v.crashing && v.resting) out.push({ control: 'hop', rank: RANK.getOut, action: new RockOver() });
      return out;
    }
    const p = this.player.pos;
    for (const source of this.offerSources) {
      const action = source();
      if (action) out.push({ control: 'interact', rank: RANK.script, action });
    }
    const valet = this.valet.talkable(p, TUNING.valet.talkReach.foot, this.conditions.valetsOnShift());
    if (valet) out.push({ control: 'interact', rank: RANK.valet, action: new TalkToValet({ valet }) });
    const randy = this.randyTalk.talkable(p);
    if (randy) out.push({ control: 'interact', rank: RANK.randy, action: new TalkToRandy({ randy }) });
    const cab = this.elevators.cabAt(p);
    const landing = cab ? null : this.elevators.landingAt(p, TUNING.elevator.callReach);
    if (cab) {
      out.push({ control: 'interact', rank: RANK.elevator, action: new PickFloor({ cab, dir: 1 }) });
      out.push({ control: 'pay', rank: RANK.elevator, action: new PickFloor({ cab, dir: -1 }) });
    } else if (landing && !landing.elevator.openAt(landing.stop)) {
      out.push({ control: 'interact', rank: RANK.elevator, action: new CallElevator({ elevator: landing.elevator, stop: landing.stop }) });
    }
    for (const car of this.vehiclesInReach(p)) out.push({ control: 'interact', rank: RANK.vehicle, action: new InteractWithVehicle({ car }) });
    out.push({ control: 'summon', rank: 0, action: new Summon() });
    return out;
  }

  /** Vehicles Cody could get into from `p`, nearest first. */
  private vehiclesInReach(p: Vector3): Vehicle[] {
    const near = this.vehicles.filter(
      (v) => (v.role === 'traffic' || v.role === 'parked' || v.role === 'valet' || v.role === 'visitor') && Math.abs(v.pos.y - p.y) < ENTER_HEIGHT && v.pos.distanceTo(p) < v.breed.enterReach,
    );
    return near.sort((a, b) => a.pos.distanceTo(p) - b.pos.distanceTo(p));
  }

  /** What Cody could do with one kind of item right now, resolved: EAT, or GIVE TO RANDY. */
  private itemOffers(kind: ItemKind): { id: ItemActionId; action: CodyAction; label: string }[] {
    const candidates: [ItemActionId, CodyAction][] = [];
    if (kind === 'brisket') candidates.push(['eat', new Eat()]);
    const taker = kind === 'tire' && this.mode === 'play' ? this.play.tireTaker() : null;
    if (taker) candidates.push(['give', new GiveTires({ to: taker, name: NPC_NAMES[taker.def.id] })]);
    return candidates.flatMap(([id, action]) => {
      const resolved = resolveFully(this.play, action);
      return 'fail' in resolved ? [] : [{ id, action: resolved, label: resolved.label(this.play) }];
    });
  }

  /** The game as Cody's actions see it: what they may ask and what they may do. */
  private makePlay(): Play {
    return {
      cody: this.cody,
      conditions: this.conditions,
      ride: () => this.driving,
      possessable: (car) => this.possessable(car),
      enter: (car) => this.enter(car),
      exit: () => this.exit(),
      escaping: () => this.escapedTimer >= 0,
      inFreeSpot: (car) => {
        const spot = this.garage.spotAt(car.pos);
        return !!spot && this.garage.isFree(spot, car);
      },
      talkToValet: (valet) => this.talk.start(valet),
      talkToRandy: (randy) => this.randyTalk.start(randy),
      summon: () => this.summon(),
      canEat: () => this.canEat,
      eat: () => this.eat(),
      tireTaker: () => (this.onFoot ? this.tires.taker(this.player.pos) : null),
      giveTires: (to) => this.tires.give(to, this.player.pos) > 0,
    };
  }

  /**
   * Whether entering this car will possess it. Requires the possession ability and a car
   * inside the deck at night. Shared by the interaction prompt and enter().
   */
  private possessable(v: Vehicle): boolean {
    return v.form === 'car' && v.insideDeck && this.conditions.deckAwake() && this.cody.can('possess');
  }

  /** Summon skeletons at Cody's position and return the number raised. */
  summon(): number {
    if (!this.cody.can('summon') || this.driving || this.transform) return 0;
    const n = this.skeletons.summon(this.player.pos, this.player.yaw);
    if (n > 0) {
      this.shake(0.15);
      this.events.emit('summoned', { n });
    }
    return n;
  }

  private enter(v: Vehicle): void {
    // Cody takes the wheel from whoever had it. A driver running for the deck loses the seat, and stops.
    this.claims.take('driverSeat', this.cody, v, { owner: this.codySeat, preempt: true });
    this.player.visible = false;
    this.iso.zoomTarget = Math.max(this.iso.zoomTarget, TUNING.camera.driveZoom);
    this.hud.setPrompt(null);
    if (v.role === 'valet') {
      this.valet.carjacked(v);
      this.hud.toast('HEY!', "THAT'S A GUEST'S CAR", 'warn', 1.8);
    }
    if (v.role === 'parked' || v.role === 'traffic' || v.role === 'valet' || v.role === 'visitor') v.markRest();
    if (v.role === 'traffic' || v.role === 'visitor') {
      // the driver gets out and runs for it (at night it's a frightened driver's car, possessed on its way into the deck)
      this.crowd.bail(v, this.player.pos);
      if (this.conditions.parking()) this.hud.toast('STOLEN!', 'GET IT TO THE HAUNTED DECK');
    }
    // phantom Cody possesses a car in the deck (and the tutorial's Cody, after moonrise, his own): it turns into the truck
    if (this.possessable(v)) {
      this.transform = new TransformSequence(v, 'truck', () => VEHICLE_BREEDS.truck.model(this.assets, v.color), this.fx);
      this.hud.toast(this.cody.phantom ? 'PHANTOM CODY!' : 'POSSESSED!', 'GET IT OUT. NOT THROUGH THE GATE.', '', 2.6);
      this.events.emit('entered', { v, possessed: true });
      return;
    }
    const found = this.money.glovebox(v);
    if (found) this.events.emit('money', { kind: 'glovebox', amount: found });
    v.role = 'player';
    this.driving = v;
    // on a bike he's out in the open: Cody himself rides it
    if (v.rig.rider) this.player.mount(v.rig.rider.saddle);
    this.events.emit('entered', { v, possessed: false });
  }

  private updateDriving(dt: number): void {
    const v = this.driving as Vehicle;
    if (v.rig.rider) this.player.ride(dt);
    const inp = this.input;
    const di: DriveInput = {
      throttle: inp.axis('back', 'forward'),
      steer: inp.axis('left', 'right'),
      hop: inp.wasPressed('hop'),
      drift: inp.isDown('drift'),
    };
    if (this.escapedTimer >= 0) di.throttle = Math.max(di.throttle, 0);
    this.ghastIntake(v, di, dt);
    const prev = _prev.copy(v.pos);
    const ev = v.drive(dt, di, this.world.collision);
    if (ev.hopped) this.slime.burst(v.pos, 10, 4, [0.12, 0.25], [0.6, 1], SLIME, 0.6, v.pos.y);
    this.drove(v, ev);

    const c = this.garage.track(v, prev);
    if (c) this.onCrossing(c);

    // spectral exhaust: twice as thick, and roaring, while it burns GhASt
    if (v.form === 'truck') {
      this.exhaustTimer -= dt;
      if (this.exhaustTimer <= 0 && (di.throttle !== 0 || this.boosting)) {
        this.exhaustTimer = this.boosting ? 0.025 : 0.05;
        for (const s of [-1, 1]) {
          v.rig.body.localToWorld(_v.set(s * 1.0, 4.3, -0.95));
          if (this.boosting) this.sprites.emit(_v, _w.set((Math.random() - 0.5) * 0.8, 5, (Math.random() - 0.5) * 0.8), BOOST_FLAME, 0.9, 3.4, 0.7, 'puff', 0.8);
          else this.sprites.emit(_v, _w.set((Math.random() - 0.5) * 0.6, 2.5, (Math.random() - 0.5) * 0.6), EXHAUST, 0.6, 2.4, 0.9, 'puff', 0.6);
        }
      }
    }

    this.interact();
    if (this.escapedTimer >= 0) {
      this.escapedTimer -= dt;
      if (this.escapedTimer < 0 && v.grounded) this.vanish(v);
    }
  }

  // ---------------------------------------------------------------- valets

  /** The car a valet would take: the one Cody is in, or the one he just got out of. */
  private carForValet(): Vehicle | null {
    if (this.driving) return this.driving.form === 'car' ? this.driving : null;
    const c = this.lastCar;
    if (!c || c.role !== 'parked' || c.insideDeck || !this.vehicles.includes(c)) return null;
    return c.pos.distanceTo(this.player.pos) < TUNING.valet.carReach ? c : null;
  }

  /** CSS-pixel screen position of a world point, or null when it's behind the camera. */
  toScreen(p: Vector3): { x: number; y: number } | null {
    // where the curved iso view draws it (render/curvature.ts)
    this.gfx.bend(_v.copy(p)).project(this.view.camera);
    if (_v.z >= 1) return null;
    const r = this.gfx.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((_v.x + 1) / 2) * r.width, y: r.top + ((1 - _v.y) / 2) * r.height };
  }

  /**
   * `v` against every other car: impulses with spin, crashes when hard enough (see collisions.ts).
   * A visitor's car it moves is knocked loose (its driver gets out) only by a hit that changes
   * its speed by `loosen` (m/s) or more.
   */
  private vehicleContacts(v: Vehicle, loosen = 0): void {
    let dealt = 0;
    const dv = carContacts(
      v,
      this.vehicles,
      (o) => this.crushes(v, o),
      (o, odv) => {
        // a traffic car moved at all is loose (it's tumbling), whatever the threshold
        if (o.role === 'traffic' || odv >= loosen) this.knocked(o, v);
        // a hard hit knocks bits off both of them, out from where they met
        _at.lerpVectors(v.pos, o.pos, 0.5);
        this.junk.hit(o, _at, odv);
        this.junk.hit(v, _at, odv);
        if (odv > dealt) {
          dealt = odv;
          _met.copy(_at);
        }
      },
    );
    // one bang for the sound: the harder of what it took and what it dealt
    if (dv > 0 || dealt > 0) this.events.emit('impact', { v, at: dealt > 0 ? _met.clone() : v.pos.clone(), dv: Math.max(dv, dealt), took: dv, against: 'car' });
  }

  /** A monster truck at speed flattens a car outside the deck instead of bumping it. */
  private crushes(v: Vehicle, o: Vehicle): boolean {
    if (v.form !== 'truck' || o.form !== 'car' || o.insideDeck || Math.abs(v.speed) <= CRUSH_SPEED) return false;
    this.crush(o, v);
    return true;
  }

  /** A traffic car knocked off its lane: left where it ends up, and its driver gets out and runs once it stops. */
  private knocked(o: Vehicle, by: Vehicle): void {
    if (o.role !== 'traffic' && o.role !== 'visitor') return;
    o.role = 'parked';
    this.fleet.abandon(o);
    this.shaken.set(o, by.pos.clone());
  }

  /** Crashing cars nobody stepped this frame tumble on their own (valets' too), and knock into others. */
  private updateWrecks(dt: number): void {
    for (const v of this.vehicles) {
      if (!v.crashing || v.role === 'player' || v.gone || v.steppedThisFrame) continue;
      this.drove(v, v.drive(dt, null, this.world.collision));
    }
    for (const [o, from] of this.shaken) {
      if (!o.resting) continue;
      this.shaken.delete(o);
      if (this.mode === 'play' && this.fleet.vehicles.includes(o)) this.crowd.bail(o, from);
    }
  }

  /**
   * What one step of a vehicle did, whoever is driving (Cody, an AI driver, or nobody: a wreck):
   * the props it knocked over and the parapets it broke, its bangs, and its contacts with other
   * cars (a car it nudges is knocked loose only past `loosen`; a wreck at rest pushes nothing).
   */
  private drove(v: Vehicle, ev: DriveEvents, loosen = 0): void {
    for (const s of ev.smashed) {
      if (s.knockdown) this.knockProp(s, v);
      else this.smash(s.id, v);
    }
    if (ev.impact > 0) this.events.emit('impact', { v, at: v.pos.clone(), dv: ev.impact, took: ev.impact, against: 'wall' });
    if (ev.landed > 0) this.events.emit('impact', { v, at: v.pos.clone(), dv: ev.landed, took: ev.landed, against: 'ground' });
    if (!(v.crashing && v.resting)) this.vehicleContacts(v, loosen);
  }

  /** Cody gets out; `quiet` (a scene got him out) skips the PARKED toast. */
  private exit(quiet = false): void {
    const v = this.driving as Vehicle;
    this.driving = null;
    this.claims.release(this.codySeat);
    this.boosting = false;
    // An escaped vehicle's roll ends with the drive, so the next vehicle Cody takes is not affected.
    this.escapedTimer = -1;
    this.iso.zoomTarget = Math.min(this.iso.zoomTarget, TUNING.camera.zoom);
    this.hud.setPrompt(null);
    v.vel.set(0, 0, 0);
    v.speed = 0;
    v.role = 'parked';
    let parkedIn: SpotRuntime | null = null;
    if (v.insideDeck) {
      const s = this.garage.spotAt(v.pos);
      if (s && this.garage.isFree(s, v)) {
        const flip = Math.cos(v.yaw - s.def.yaw) < 0;
        v.place(s.center.x, s.center.y, s.center.z, s.def.yaw + (flip ? Math.PI : 0), 0, 0, null);
        this.garage.occupy(s, v);
        if (!quiet) this.hud.toast('PARKED', spotLabel(s), 'purple', 1.6);
        parkedIn = s;
      } else {
        this.garage.release(v);
      }
    }
    v.markRest();
    this.lastCar = v;
    // step out on the driver's side, then let collision sort it out
    const side = v.params.radius + DOOR_GAP;
    _v.set(v.pos.x - Math.cos(v.yaw) * side, v.pos.y, v.pos.z + Math.sin(v.yaw) * side);
    const p: V3 = [_v.x, _v.y, _v.z];
    this.world.collision.resolveCircle(p, TUNING.player.radius, TUNING.player.height, TUNING.player.stepUp);
    _v.set(p[0], this.world.collision.groundAt(p[0], p[2], v.pos.y + 0.5, 1), p[2]);
    this.player.dismount(this.scene);
    this.player.place(_v, v.yaw);
    this.player.visible = true;
    this.events.emit('exited', { v, spot: parkedIn });
  }

  private onCrossing(c: Crossing): void {
    this.events.emit('crossing', c);
    const v = c.vehicle;
    switch (c.kind) {
      case 'logged-in':
        this.hud.toast('BEEP', 'BADGE SCANNED. ENTRY LOGGED.', 'purple', 1.4);
        break;
      case 'logged-out':
        if (v.form === 'truck') this.hud.toast('BADGE SCANNED', 'EXIT LOGGED. THE GARAGE SAW YOU. NO PHANTOM.', 'warn', 2.6);
        else this.hud.toast('BEEP', 'BADGE SCANNED. EXIT LOGGED.', 'purple', 1.4);
        this.garage.release(v);
        v.homeSpot = null;
        break;
      case 'snuck-in':
        this.hud.toast('SNUCK IN', 'NO BADGE, NO RECORD', 'warn', 1.8);
        break;
      case 'escaped': {
        if (this.counted.has(v)) break;
        this.counted.add(v);
        const spot = v.homeSpot !== null ? (this.garage.spots[v.homeSpot] ?? null) : null;
        this.garage.release(v);
        const home = spot && this.garage.isFree(spot) ? spot : null;
        const imprint = this.garage.addPhantom(v.restPos, v.restYaw, home);
        this.events.emit('phantom', { at: imprint.position.clone(), yaw: imprint.rotation.y, spot: home, n: this.garage.phantoms, hours: this.clock.hours, day: this.clock.day });
        v.homeSpot = null;
        this.hud.toast(`PHANTOM CODY #${this.garage.phantoms}`, 'OOPS! YOU FORGOT TO BADGE OUT!', '', 2.8);
        this.doFlash(0.35, '#9dff3a');
        this.shake(0.3);
        if (!this.keepEscaped) this.escapedTimer = ESCAPE_ROLL;
        break;
      }
    }
  }

  private vanish(v: Vehicle): void {
    // the escaped truck dissolves into the night and Cody is left on foot
    const at = _at.copy(v.pos).setY(v.pos.y + 1.5);
    this.slime.burst(at, 50, 9, [0.15, 0.45], [1, 2], SLIME, 1, v.pos.y);
    this.sprites.spray(at, 8, 5, [3, 6], WHITE, 1.5, 3, 1.6, 'ghost', 0.9);
    this.exit();
    v.role = 'vanishing';
    v.timer = 0;
  }

  private smash(solidId: number, v: Vehicle): void {
    const piece = this.world.breakables.find((b) => b.solid.id === solidId);
    if (!piece || piece.broken) return;
    piece.broken = true;
    piece.group.visible = false;
    const c = piece.center;
    for (let i = 0; i < 26; i++) {
      _v.set(c.x + (Math.random() - 0.5) * 3, c.y, c.z + (Math.random() - 0.5) * 3);
      _w.set(v.vel.x * 0.5 + (Math.random() - 0.5) * 8, 3 + Math.random() * 6, v.vel.z * 0.5 + (Math.random() - 0.5) * 8);
      this.debris.spawn(_v, _w, 0.25 + Math.random() * 0.45, 2.5, CONCRETE, this.world.collision.groundAt(_v.x, _v.z, c.y - 0.5, 0));
    }
    this.slime.burst(c, 24, 7, [0.12, 0.3], [1, 2], SLIME, 0.8, c.y - 0.6);
    this.events.emit('smashed', { at: c.clone(), by: v });
  }

  /**
   * Ran into a lamp, a fence panel, a bench or (in the truck) a street tree: it goes over the way
   * the car was heading, kicked off toward the side it was struck on (so a lamp doesn't come down
   * on the car), and the car loses some speed. A hedge or a bus shelter the truck hits flies apart
   * instead (props.onBroken).
   */
  private knockProp(s: Solid, v: Vehicle): void {
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    const side = ((s.min[0] + s.max[0]) / 2 - v.pos.x) * -fz + ((s.min[2] + s.max[2]) / 2 - v.pos.z) * fx;
    const kick = (side === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(side)) * Math.hypot(v.vel.x, v.vel.z) * 0.8;
    const kind = this.world.props.knock(s.id, v.vel.x - fz * kick, v.vel.z + fx * kick, v);
    if (!kind) return;
    const k = kind.keep ?? v.breed.knockKeep;
    v.vel.x *= k;
    v.vel.z *= k;
    // one that shatters has gone to bits already (props.onBroken)
    if (kind.shatter) return;
    _v.set((s.min[0] + s.max[0]) / 2, v.pos.y + 1, (s.min[2] + s.max[2]) / 2);
    const colors = kind.debris ?? [METAL];
    for (const c of colors) this.debris.burst(_v, Math.ceil(6 / colors.length), 5, [0.08, 0.2], [0.8, 1.4], c, 0.6, v.pos.y);
    this.events.emit('prop', { kind, at: _v.clone(), how: 'knocked', by: v });
  }

  private crush(o: Vehicle, by: Vehicle): void {
    o.role = 'crushed';
    o.timer = 0;
    this.events.emit('crushed', { car: o, by });
    this.junk.crushed(o);
    this.slime.burst(o.pos, 30, 8, [0.15, 0.35], [1, 2], SLIME, 0.7, o.pos.y);
    this.debris.burst(_at.copy(o.pos).setY(o.pos.y + 0.8), 10, 6, [0.15, 0.3], [1, 2], _tint.set(o.color), 0.6, o.pos.y);
    by.kick(-CRUSH_KICK);
  }

  // ---------------------------------------------------------------- phases

  private onNightfall(): void {
    this.hud.toast('THE MOON IS UP', this.cody.holdForm ? 'THE DECK WAKES UP' : 'PHANTOM CODY RISES', '', 3.2);
    this.doFlash(0.6, '#b46bff');
    this.shake(0.3);
    if (!this.cody.holdForm) this.codyFx = 0;
    // driving at moonrise: the car turns into the monster truck round him (in the tutorial, Cody himself stays Cody)
    const v = this.driving;
    if (v && v.form === 'car' && !this.transform) {
      this.driving = null;
      // off the bike's saddle (its rig is about to go), and inside the truck, out of sight
      if (v.rig.rider) {
        this.player.dismount(this.scene);
        this.player.visible = false;
      }
      this.transform = new TransformSequence(v, 'truck', () => VEHICLE_BREEDS.truck.model(this.assets, v.color), this.fx);
      this.events.emit('entered', { v, possessed: true });
    }
    this.events.emit('nightfall', null);
  }

  private onSunrise(): void {
    this.hud.toast(`DAY ${this.clock.day}`, 'SUN UP. BACK TO WORK.', 'warn', 3);
    // the souls slip away at dawn
    this.ghast = 0;
    this.money.scatter();
    if (!this.cody.holdForm) this.codyFx = 0;
    for (const b of this.world.breakables) {
      b.broken = false;
      b.solid.enabled = true;
      b.group.visible = true;
    }
    this.world.props.repair();
    this.skeletons.crumbleAll();
    // monster trucks fall back asleep as cars
    for (const v of this.vehicles) {
      if (v.form !== 'truck' || v.role === 'vanishing' || v.role === 'transforming') continue;
      if (v === this.driving) this.exit();
      this.morphs.push(new TransformSequence(v, 'car', () => VEHICLE_BREEDS[v.kind].model(this.assets, v.color), this.fx));
    }
    // last, so listeners see the repaired deck (and can switch off what isn't built yet)
    this.events.emit('sunrise', null);
  }

  private updateMorphs(dt: number): void {
    // finished ones drop out in place, keeping the rest in order
    let n = 0;
    for (const m of this.morphs) {
      m.update(dt);
      if (m.done) m.vehicle.role = 'parked';
      else this.morphs[n++] = m;
    }
    this.morphs.length = n;
  }

  /** Cody's outfit swap at moonrise / sunrise. */
  private updateCodyFx(dt: number): void {
    if (this.codyFx < 0) return;
    const before = this.codyFx;
    // where Cody is: on foot, or inside whatever he's in
    const p = (this.ride ?? this.player).pos;
    if (before === 0) this.events.emit('outfit', { form: this.clock.phase, at: p.clone() });
    this.codyFx += dt;
    if (before < 0.6) {
      _v.set(p.x + (Math.random() - 0.5) * 1.5, p.y + Math.random() * 2, p.z + (Math.random() - 0.5) * 1.5);
      this.sprites.emit(_v, _w.set(0, 2, 0), OUTFIT_PUFF, 0.4, 1.6, 0.8, 'puff', 0.8);
    }
    if (before < 0.6 && this.codyFx >= 0.6) {
      this.player.setForm(this.clock.phase);
      const at = _at.copy(p).setY(p.y + 1);
      this.slime.burst(at, 30, 6, [0.1, 0.3], [0.8, 1.6], this.clock.isDay ? PURPLE : SLIME, 1, p.y);
      this.sprites.spray(at, 5, 3, [2, 4], WHITE, 1, 2.2, 1.4, 'ghost', 0.9);
      this.shake(0.25);
    }
    if (this.codyFx > 1) this.codyFx = -1;
  }

  // ---------------------------------------------------------------- shared

  private updateShared(dt: number): void {
    const nightness = this.dayNight.nightness;
    this.planner.update();
    if (this.mode === 'play') {
      // the AI drivers keep clear of the cars as well
      const obstacles = this.bodies.obstacles((b) => b.kind === 'car' || b.kind === 'cody' || b.kind === 'down' || (b.kind === 'person' && b.moving), this.valetObstacles);
      this.valetFrame.day = this.conditions.valetsOnShift();
      this.valet.update(dt, this.valetFrame);
      this.visitors.update(dt, this.view.target);
      this.drivers.update(dt);
      this.detours.update(dt, obstacles);
      // a car crashed pulling round: its driver gets out and runs once it stops
      for (const v of this.detours.stranded.splice(0)) this.shaken.set(v, v.pos.clone());
    }
    const movers = this.movers;
    movers.length = 0;
    for (const v of this.vehicles) if (v.role !== 'parked') movers.push(v.pos);
    this.world.gates.update(dt, movers, this.vehicles);
    this.world.clocks.update(this.clock.hours);
    this.garage.update(dt, !!this.driving && this.driving.form === 'car' && this.conditions.parking(), nightness);
    const focus = this.view.target;
    this.dayNight.apply(this.clock.hours, (focus.x - focus.z) * 0.002 + this.iso.azimuth * 0.3);
    this.updateWrecks(dt);
    this.casualties.update(dt, this.vehicles);
    this.blood.update(dt);
    this.world.slime.update(dt, focus);
    this.world.props.update(dt, this.vehicles, this.world.collision);
    this.npcs.update(dt, this.mode === 'play' && this.onFoot ? this.player.pos : null);
    this.world.interiors.update(this.mode === 'play' && this.onFoot ? this.player.pos : null);
    this.slime.update(dt);
    this.debris.update(dt);
    this.exhaust.update(dt, this.vehicles, nightness);
    this.sprites.update(dt);
    this.honks.update(dt);
    this.ghosts.update(dt, nightness);
    this.bats.update(dt, nightness);
    this.pool.update(focus);

    // top-down, the shadow box fits what the view shows; the chase view sees too far for that
    if (this.chaseActive) this.lights.follow(this.chase.shadowFocus(_s), this.dayNight.sunDir);
    else this.lights.cover(this.iso.shadowCorners(_shadowPts), this.dayNight.sunDir, this.iso.screenUp(_s));

    this.dozing(dt);
    this.flash = Math.max(0, this.flash - dt * 1.8);
    this.gfx.grade.uniforms.flash!.value = this.flash * this.flash;
    (this.gfx.grade.uniforms.flashColor!.value as Color).copy(this.flashColor);
  }

  /** How the haunting's going, for the phone's Phantoms app. */
  private phantomReport(): PhantomReport {
    const haunted = this.garage.spots.filter((s) => s.phantom);
    return {
      onBoard: this.garage.phantomOccupancy(this.vehicles),
      spots: TUNING.garage.spots,
      escapes: this.garage.phantoms,
      logged: this.garage.logged,
      inDeck: this.garage.actual(this.vehicles),
      where: haunted.map(spotLabel),
    };
  }

  /** Objective markers over their targets (none under a cutscene), and the minimap around Cody, in the dash or the phone. */
  private updateObjectives(): void {
    const me = this.ride ?? this.player;
    const list = this.objectives.list;
    this.hud.setObjectives(this.cutscene ? [] : list, this.view.camera, (p) => this.toScreen(p), me.pos);
    const up = this.view.screenUp(_up);
    this.hud.setMap({
      x: me.pos.x,
      z: me.pos.z,
      yaw: me.yaw,
      upX: up.x,
      upZ: up.z,
      driving: this.ride !== null,
      marks: list.map((o) => ({ x: o.at.x, z: o.at.z, kind: o.kind })),
    }, this.phone.showing('map') ? this.phone.body('map') : null);
  }

  /** The arrow over Cody's ride points along a planned route to the current objective. */
  private updateNav(dt: number): void {
    const v = this.driving;
    let goal: Vector3 | null = null;
    let key = '';
    let profile: NavProfile = NAV.car;
    let query: NavQuery | undefined;
    if (v && this.conditions.parking() && v.form === 'car') {
      // by day: a free spot, entering through the badge gate
      const s = this.garage.nearestFree(v.pos, null);
      if (s) {
        goal = s.center;
        key = `spot${s.def.id}`;
        if (!v.insideDeck) query = this.entryQuery;
      }
      this.arrow.setColor(PALETTE.slime);
    } else if (v && v.form === 'truck' && v.insideDeck && this.escapedTimer < 0) {
      // at night: the nearest unbroken parapet, preferring this floor
      const floor = this.garage.floorOf(v.pos.y);
      let best: BreakablePiece | null = null;
      let bd = Infinity;
      for (const b of this.world.breakables) {
        if (b.broken) continue;
        const d = b.center.distanceToSquared(v.pos) + (this.garage.floorOf(b.center.y) === floor ? 0 : 1e6);
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      if (best) {
        goal = this.insideOf(best, _s);
        key = `brk${best.solid.id}`;
        profile = NAV.truck;
      }
      this.arrow.setColor(PALETTE.purpleHot);
    }
    let target: Vector3 | null = null;
    if (v && goal) target = this.guide.update(dt, v.pos, goal, key, profile, query);
    else this.guide.reset();
    this.arrow.update(dt, v ? v.pos : null, v?.rig.height ?? 2, target);
  }

  /** A point on the deck floor a few metres in from a parapet: where to aim the truck. */
  private insideOf(b: BreakablePiece, out: Vector3): Vector3 {
    const { min, max } = b.solid;
    const alongX = max[0] - min[0] > max[2] - min[2];
    out.set(b.center.x, min[1], b.center.z);
    if (alongX) out.z += Math.sign(this.deckCenter.z - out.z) * 3;
    else out.x += Math.sign(this.deckCenter.x - out.x) * 3;
    return out;
  }

  /**
   * The monster truck at night: ghosts near its intake get sucked in and fill
   * the GhASt tank; holding boost burns it (into `di`).
   */
  private ghastIntake(v: Vehicle, di: DriveInput, dt: number): void {
    const G = TUNING.ghast;
    if (v.form !== 'truck') {
      this.boosting = false;
      return;
    }
    v.rig.body.localToWorld(_at.set(...INTAKE));
    const n = this.ghosts.suck(_at, G.reach, dt);
    if (n > 0) {
      this.ghast = Math.min(1, this.ghast + n * G.perGhost);
      this.events.emit('swallowed', { n, tank: this.ghast, at: _at.clone() });
    }
    const was = this.boosting;
    this.boosting = this.input.isDown('boost') && this.ghast > 0 && !v.crashing;
    if (!this.boosting) return;
    if (!was) this.events.emit('boosted', null);
    di.boost = 1;
    this.ghast = Math.max(0, this.ghast - G.burn * dt);
  }

  /** A driver leans on the horn: the 'honk' event (the sound's cue), the word over the roof, a flash of the headlights. */
  private honk(car: Vehicle): void {
    const anger = this.traffic.angerOf(car);
    this.events.emit('honk', { car, at: car.pos.clone(), anger });
    this.honks.pop(_at.copy(car.pos).setY(car.pos.y + car.rig.height + 0.2), anger);
    this.fleet.flash(car);
  }

  /** A puff of smoke at `at` (someone's feet): for a character vanishing, or appearing, in one. */
  puff(at: Vector3): void {
    this.events.emit('puff', { at: at.clone() });
  }

  /** Cody can eat only on foot, outside cutscenes, and when he is not already dozing. */
  private get canEat(): boolean {
    return !this.driving && !this.transform && !this.cutscene && this.doze < 0;
  }

  /** Cody eats a brisket from his items. True if he did. */
  private eat(): boolean {
    if (!this.canEat || !this.inventory.take('brisket', 1)) return false;
    this.deed({ how: 'used', kind: 'brisket', action: 'eat' });
    if (this.sleepAfterEating && this.doze < 0) {
      this.hud.toast('BRISKET', 'YOU ATE SO MUCH YOU FELT SLEEPY...', 'purple', DOZE.toast);
      this.doze = 0;
    }
    return true;
  }

  /** A doze under way: dim the picture after the day-night grade, skip the clock at the darkest, brighten again. */
  private dozing(dt: number): void {
    if (this.doze < 0) return;
    const was = this.doze;
    this.doze += dt;
    const { down, hold, up, dim } = DOZE;
    if (was < down + hold && this.doze >= down + hold) this.clock.skipToNextPhase();
    const k = this.doze < down ? this.doze / down : this.doze < down + hold ? 1 : 1 - (this.doze - down - hold) / up;
    const exposure = this.gfx.grade.uniforms.exposure as { value: number };
    exposure.value *= 1 - (1 - dim) * smoothstep(0, 1, Math.max(0, k));
    if (this.doze >= down + hold + up) this.doze = -1;
  }

  private doFlash(a: number, color = '#9dff3a'): void {
    this.flash = Math.max(this.flash, a);
    this.flashColor.set(color);
  }
}

/** The point a thing sees from, or is seen at: its position raised to its eye height. */
function eyeOf(thing: Thing): [number, number, number] {
  return [thing.pos.x, thing.pos.y + EYE_HEIGHT[thing.kind], thing.pos.z];
}

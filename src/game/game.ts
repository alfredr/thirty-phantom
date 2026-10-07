import { Color, MeshBasicMaterial, MeshStandardMaterial, Scene, Vector3 } from 'three';

import { Avoidance, parkedBlocks, PERSON_RADIUS } from '@/actors/avoidance';
import { type Npc, Npcs } from '@/actors/npcs/npcs';
import { Player } from '@/actors/player';
import { Skeletons } from '@/actors/skeletons/skeletons';
import type { Obstacle } from '@/actors/vehicles/autopilot';
import { type CarKind, VEHICLE_BREEDS } from '@/actors/vehicles/breeds';
import { Traffic } from '@/actors/vehicles/traffic';
import { type DriveInput, Vehicle } from '@/actors/vehicles/vehicle';
import type { AssetRegistry } from '@/assets/asset-registry';
import { TUNING } from '@/config';
import { reloadIfPending } from '@/dev/reload-prompt';
import { Emitter } from '@/engine/core/events';
import { clamp } from '@/engine/core/math';
import { Rng } from '@/engine/core/rng';
import { urlChoice, urlFlag, urlParam } from '@/engine/core/url-flags';
import { Input } from '@/engine/input/input';
import { Claims } from '@/engine/sim/claims';
import { Leases } from '@/engine/sim/leases';
import { Space } from '@/engine/sim/space';
import { Bats } from '@/fx/bats';
import { PURPLE, SLIME, WHITE } from '@/fx/colors';
import { CubeParticles } from '@/fx/cube-particles';
import { Exhaust } from '@/fx/exhaust';
import { Fade } from '@/fx/fade';
import { Ghosts } from '@/fx/ghosts';
import { Honks } from '@/fx/honks';
import { NavArrow } from '@/fx/nav-arrow';
import { NavDebug } from '@/fx/nav-debug';
import { SpriteFx } from '@/fx/sprite-fx';
import { Shop } from '@/game/items/shop';
import { ChaseCamera, type ChaseKind } from '@/render/chase-camera';
import { Cutaway } from '@/render/cutaway';
import { DayNight } from '@/render/day-night';
import { GameRenderer } from '@/render/game-renderer';
import { IsoCamera } from '@/render/iso-camera';
import { FX_LAYER } from '@/render/layers';
import { LightPool } from '@/render/light-pool';
import { MaterialLibrary, softInk, withCutaway } from '@/render/materials';
import { PALETTE } from '@/render/palette';
import { SunLight } from '@/render/sun-light';
import { helpRows, Hud } from '@/ui/hud';
import { Help, MapApp, type PhantomReport, Phantoms, Photos, Tasks } from '@/ui/phone/apps';
import { Calls } from '@/ui/phone/calls';
import { Messages } from '@/ui/phone/messages';
import { Phone } from '@/ui/phone/phone';
import { wantsTouch } from '@/ui/touch-controls';
import { BloodSim } from '@/world/blood';
import { type BreakablePiece, buildWorld, type BuiltWorld } from '@/world/build-world';
import { Elevators } from '@/world/elevators';
import type { LevelData, ZoneDef } from '@/world/level-data';
import { NAV, NavGrid, NavPlanner, type NavProfile, type NavQuery } from '@/world/nav-grid';

import { CameraController, type CamMode } from './camera-controller';
import type { CodyAction, Play } from './cody/cody-actions';
import { CodyRide, type RideEvents, type VehicleAccess } from './cody/cody-ride';
import { CodyState, FRIGHTENING } from './cody/cody-state';
import { GhostFuel } from './cody/ghost-fuel';
import { Interactions } from './cody/interactions';
import { KEYS, STICK } from './controls';
import { createGameDebug } from './debug';
import { type Crossing, Garage, inSpot, spotLabel, type SpotRuntime } from './deck/garage';
import { TransformSequence, type FxKit } from './deck/transform-sequence';
import { Detours } from './driving/detours';
import type { DriveWorld } from './driving/drive-actions';
import { Drivers } from './driving/drivers';
import { Fleet } from './driving/fleet';
import { type ImpactEvents, VehicleImpacts } from './driving/impacts';
import { Refuge } from './driving/refuge';
import { openPose, type Pose, StuckWatch } from './driving/reset';
import { Visitors } from './driving/visitors';
import { playEffects } from './effects';
import { GameClock, type Phase } from './game-clock';
import { Inventory } from './items/inventory';
import { ITEM_BREEDS, type ItemKind } from './items/item-breeds';
import { Junk } from './items/junk';
import { dropKeys } from './items/key-drops';
import { Money } from './items/money';
import { Trades } from './items/trades';
import { RandyTalk } from './randy/talk';
import { RouteGuide } from './route-guide';
import { Bodies } from './rules/bodies';
import { CLAIMS, type ClaimKind } from './rules/claim-kinds';
import { LEVEL } from './rules/reach';
import { EYE_HEIGHT, gameReactions, type Perception, react, type Reaction, type Thing } from './rules/reactions';
import { WorldConditions } from './rules/world-conditions';
import type { Said } from './story/conversation';
import { Objectives } from './story/objectives';
import { makePortraits, type Portraits } from './story/portraits';
import { Haunting, Quests, tireMarks } from './story/quests';
import { type ItemDeed, Triggers } from './story/triggers';
import { Casualties } from './town/casualties';
import { Crowd } from './town/crowd';
import { ValetTalk } from './valets/talk';
import { type ValetFrame, ValetService } from './valets/valet';

export type { CamMode, CamView } from './camera-controller';

const BONE = new Color('#efe6ff');
const DIRT = new Color('#3a2a22');
/** Particle color for Cody’s form-change animation. */
const OUTFIT_PUFF = new Color(0.6, 0.3, 1.4);
/** Tire-fire smoke and emissive ember colors; ember channels exceed one for glow. */
const TIRE_SMOKE = new Color('#221c28');
const EMBER = new Color(2.4, 0.9, 0.2);
const _v = new Vector3();
const _w = new Vector3();
const _s = new Vector3();
const _up = new Vector3();
/** Reusable isometric view corners used to fit the shadow bounds. */
const _shadowPts: Vector3[] = [];
// Reuse splash parameters to avoid allocations per ambient drip.
const _splat = new Vector3();
const _splatSize: [number, number] = [0, 0];
const SPLAT_LIFE: [number, number] = [0.25, 0.5];
const _prev = new Vector3();
/** Previous AI vehicle position used for gate-crossing detection. */
const _drivePrev = new Vector3();
const _at = new Vector3();
const NONE: readonly Vector3[] = [];

/**
 * Velocity-change threshold in m/s for AI contact to dislodge a visitor car. Displaced traffic cars are always released
 * from their lane.
 */
const NUDGE_LOOSEN = 2.5;
/** Maximum speed in m/s for a physically present vehicle to block a parking spot. */
const STANDING = 0.5;
/**
 * Phase-skip fade timing in seconds and minimum exposure multiplier. Advance the clock after dimming and holding, then
 * restore exposure.
 */
const PHASE_SKIP = { down: 1.4, hold: 0.6, up: 1.6, dim: 0.04, toast: 3 };
const SCRIPT_FADE = { down: 0.45, hold: 0.25, up: 0.6, dim: 0.02 };
/** Pickup and extended trade notification durations, in seconds. */
const MONEY_TOAST = 1.1;
const TRADE_TOAST = 2.6;
/** How long a refusal such as "THE DEAD NEED A MOMENT" stays up, in seconds. */
const FAIL_TOAST = 1.4;
/** Obstacle radii for Randy and his fire, in meters. */
const NPC_ROOM = 0.4;
const FIRE_ROOM = 0.45;

type Mode = 'title' | 'play';
/** Events shared by gameplay, tutorial, audio, and visual effects. */
export type GameEvents = RideEvents &
  ImpactEvents & {
    keysFound: { plate: string };
    start: null;
    /** The play update completed; payload is elapsed seconds. Shared simulation and rendering follow afterward. */
    frame: number;
    /** Report a new traffic-driver fright response to phantom Cody or the truck. */
    spooked: { car: Vehicle };
    /** Report an inventory deed. Use game.triggers for accumulated item milestones. */
    item: ItemDeed;
    /** Report a player-selected camera mode. */
    camera: CamMode;
    /** Report collected ghosts, the resulting normalized GhASt fill, and the world-space intake position. */
    swallowed: { n: number; tank: number; at: Vector3 };
    /** Report the start of GhASt burning. */
    boosted: null;
    /** Emitted after a successful summon, with the number of skeletons raised. */
    summoned: { n: number };
    /**
     * Report a new phantom imprint after an unlogged exit, including placement, optional home spot, total count, and
     * game time.
     */
    phantom: { at: Vector3; yaw: number; spot: SpotRuntime | null; n: number; hours: number; day: number };
    /** Report a horn event with a copied car position and normalized impatience for audio and visual intensity. */
    honk: { car: Vehicle; at: Vector3; anger: number };
    /** Report a tire entering Randy’s fire. */
    stoked: { at: Vector3 };
    sfx: { name: ScriptSound; at: Vector3 };
    /** Request smoke at a character’s ground position through game.puff. */
    puff: { at: Vector3 };
    /** Report collected cash, wallet contents, or glovebox money in dollars. */
    money: { kind: 'cash' | 'wallet' | 'glovebox'; amount: number };
    /** Report the start of Cody’s form-change effect with the target phase and position. */
    outfit: { form: Phase; at: Vector3 };
    /** Report a new pedestrian fright response, including a driver leaving a vehicle. */
    fright: { at: Vector3 };
    /** Phone notification events for ringing, hangup, and incoming text. */
    phone: 'ring' | 'hangup' | 'text';
    crossing: Crossing;
    nightfall: null;
    sunrise: null;
    /** Report a quest transition; the tutorial uses the tutorial quest ID. */
    step: { quest: string; step: string };
    /** Report a performed Cody action to interested systems. */
    performed: { action: CodyAction };
    /** Report an action failure and its reason. */
    failed: { action: CodyAction; reason: string };
    reset: { v: Vehicle };
  };

export type ScriptSound = 'keys-clink' | 'gas-glug' | 'fire-flare' | 'engine-cough' | 'engine-roar';

/** Override the isometric camera target and zoom while muting player controls. */
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
  /** Shared navigation grid built from level and collision data. */
  readonly nav: NavGrid;
  /** Shared queue for actor and guidance route requests. */
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
  /** Visitor arrivals, parking ownership, and departures to traffic. */
  private readonly visitors: Visitors;
  /** Frightened traffic drivers diverting into the deck. */
  private readonly refuge: Refuge;
  private readonly driveWorld: DriveWorld;
  private readonly drivers: Drivers;
  /** Traffic detours around lane obstructions. */
  private readonly detours: Detours;
  /** World-space horn captions. */
  private readonly honks = new Honks();
  /** Civilian smoke and spectral truck exhaust. */
  private readonly exhaust: Exhaust;

  /** Current obstacle data used by pedestrian steering. */
  private readonly avoid = new Avoidance();
  private readonly blood: BloodSim;
  private readonly casualties: Casualties;
  /** Summoned skeleton population and hunting behavior. */
  private readonly skeletons: Skeletons;
  private readonly impacts: VehicleImpacts;
  readonly money: Money;
  /** Cody’s carried item counts. */
  readonly inventory = new Inventory();
  /** Inventory milestone callbacks; see story/triggers.ts. */
  readonly triggers = new Triggers(this.inventory);
  /** Task text and marker sources; see story/objectives.ts. */
  readonly objectives = new Objectives();
  /** Temporary debris and persistent world pickups. */
  private readonly junk: Junk;
  private readonly stuck = new StuckWatch();
  /** Enable a time skip after eating brisket. Tutorial story steps temporarily disable it. */
  skipAfterEating = true;
  private readonly phaseFade = new Fade(PHASE_SKIP, () => this.clock.skipToNextPhase());
  /** Normalized GhASt fuel, filled by ghosts and consumed by boosting. Cleared at sunrise. */
  private readonly fuel = new GhostFuel();
  get ghast(): number {
    return this.fuel.fill;
  }
  set ghast(value: number) {
    this.fuel.fill = value;
  }
  /** Whether the current truck update is burning GhASt. */
  get burning(): boolean {
    return this.fuel.burning;
  }
  /** Force shop stock to display during a scripted scene without enabling purchases. */
  waresShown: Npc | null = null;
  /** NPC exchanges, also callable directly by tutorial scenes. */
  readonly trades: Trades;
  private readonly shop: Shop;
  /** Ordinary Randy conversation, disabled while the tutorial controls him. */
  readonly randyTalk: RandyTalk;
  /** Persisted quest progress, excluding the tutorial. */
  readonly quests: Quests;
  private readonly haunting: Haunting;
  /** Shared phone UI and installed apps. */
  readonly phone: Phone;
  /** NPC instances available for conversations and scripted scenes. */
  readonly npcs: Npcs;
  /** Elevator cab movement and door control. */
  readonly elevators: Elevators;
  private readonly interactions: Interactions;
  /** Reusable list of on-foot passenger position references for elevator movement. */
  private readonly riders: readonly Vector3[];
  readonly events = new Emitter<GameEvents>();
  readonly cameraShots = new Leases<Cutscene>();
  private portraitSet: Portraits | null = null;
  /** Cody's form, abilities, and presence. Scripts can hold his form and grant extra abilities here. */
  readonly cody: CodyState;
  /** Time-dependent game rules with script overrides. */
  readonly conditions: WorldConditions;
  /** Reservations for driver seats, parking spots, diversions, and skeleton quarry. */
  readonly claims = new Claims<ClaimKind>(CLAIMS);
  /** Perception index rebuilt during frame sensing. */
  private readonly space = new Space<Thing>(8, LEVEL.person);
  private readonly things: Thing[] = [];
  private readonly reactions: readonly Reaction[];
  /** Current indexed actors and line-of-sight checks against solids and floors. */
  private readonly perception: Perception = {
    space: this.space,
    things: this.things,
    sees: (a, b) => !this.world.collision.segmentBlocked(eyeOf(a), eyeOf(b), true),
  };
  /** Keep an escaped vehicle under player control instead of starting its disappearance sequence. */
  keepEscaped = false;
  doorLock: string | null = null;
  bubble: Said | null = null;
  autopilot: ((v: Vehicle, dt: number) => DriveInput) | null = null;
  private readonly scriptFade = new Fade(SCRIPT_FADE, () => this.whileDark?.());
  private whileDark: (() => void) | null = null;
  /** Vehicles already counted as phantoms, preventing repeat escapes from scoring again. */
  private readonly counted = new WeakSet<Vehicle>();
  private readonly ghosts: Ghosts;
  private readonly bats: Bats;
  private readonly arrow = new NavArrow();
  private readonly rng = new Rng(777);
  private readonly fx: FxKit;
  private readonly deckCenter: Vector3;

  private mode: Mode = 'title';
  private readonly cameras = new CameraController(
    {
      snapBehind: (yaw) => this.chase.snapBehind(yaw),
      releasePointer: () => this.input.releasePointer(),
      setView: (view) => this.hud.setCamera(view),
      showMode: (mode, hint) => this.hud.showCamera(mode, hint),
      changed: (mode) => this.events.emit('camera', mode),
    },
    wantsTouch(),
  );
  readonly debug: ReturnType<typeof createGameDebug>;
  private readonly codyRide: CodyRide;
  private time = 0;
  private last = 0;
  private flash = 0;
  private readonly flashColor = new Color();
  private readonly cutaway = new Cutaway();
  private codyFx = -1;
  private readonly fpsAcc = { t: 0, n: 0 };

  /** Enable frame rendering. ?render=0 allows simulation tests to skip rendering and shader compilation. */
  private rendering = urlParam('render') !== '0';
  private readonly talk: ValetTalk;
  private readonly valetFrame: ValetFrame;
  /** Exit-gate regions blocked by routes that require a logged entry. */
  private readonly exitBlocks: ZoneDef[];
  private readonly entryQuery: NavQuery;

  /** Bodies registered during sensing and reusable obstacle lists for traffic, drivers, and player movement. */
  private readonly bodies = new Bodies();
  private readonly trafficObstacles: Vector3[] = [];
  private readonly valetObstacles: Obstacle[] = [];
  private readonly movers: Vector3[] = [];
  private readonly blockers: { pos: Vector3; r: number }[] = [];
  /** Vehicle transformations running outside Cody’s active ride, including sunrise reversions. */
  private readonly morphs: TransformSequence[] = [];

  /**
   * Lazily render and cache dialogue portraits. Request them before a conversation to avoid rendering work mid-
   * dialogue.
   */
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
    // Manual tests use an unlimited planner budget so route completion does not depend on machine speed.

    this.planner = urlFlag('manual') ? new NavPlanner(this.nav, Infinity) : new NavPlanner(this.nav);
    this.guide = new RouteGuide(this.planner);
    console.info(`[nav] ${this.nav.nx}x${this.nav.nz} cells in ${this.nav.buildMs.toFixed(0)} ms`);

    if (this.navDebug) {
      this.scene.add(this.navDebug.root);
    }

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
    // Expose shared movement, collision, and garage operations to AI driving jobs.
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
        this.impacts.afterDrive(car, car.drive(dt, input, this.world.collision), NUDGE_LOOSEN);
        return this.garage.track(car, prev)?.kind === 'logged-in';
      },
      place: (car, at, yaw, dt) => car.place(at.x, at.y, at.z, yaw, 0, dt, this.world.collision),
      alive: (car) => this.fleet.vehicles.includes(car),
      bail: (car, from) => this.crowd.bail(car, from),
      wrecked: (car, from) => this.impacts.deferBail(car, from),
      parked: (_car, s) => this.hud.toast('SPOOKED INTO THE DECK', spotLabel(s), 'purple', 1.6),
    };
    this.drivers = new Drivers(this.driveWorld);
    this.valet = new ValetService(level.valets, this.planner, this.nav, this.garage, this.drivers, this.claims);
    this.scene.add(this.valet.root);
    this.valet.walkBlocks = () => parkedBlocks(this.vehicles);
    this.money = new Money(this.scene, this.nav, this.rng);
    this.money.scatter();
    this.junk = new Junk(this.scene, this.nav, this.rng);
    // Register thrown props as persistent collectibles.
    this.npcs = new Npcs(level.npcs, this.scene, {
      sprites: this.sprites,
      nav: this.nav,
      planner: this.planner,
      walkBlocks: () => parkedBlocks(this.vehicles),
      landed: (kind, item, floor) => this.junk.lay(kind, item, floor),
      ground: (x, z, below) => this.world.collision.groundAt(x, z, below, 0),
      burned: (at) => {
        _at.copy(at).setY(at.y + 1);
        this.sprites.spray(_at, 7, 0.7, [1.2, 2.6], TIRE_SMOKE, 0.35, 1.5, [1.4, 2.4], 'puff', 0.85);
        this.debris.burst(_at, 14, 2.5, [0.03, 0.07], [0.6, 1.3], EMBER, 2.2, at.y);
        this.events.emit('stoked', { at: at.clone() });
      },
      // Award brisket at handover, but delay its notification until feeding completes.
      fed: ({ kind, n }) =>
        this.hud.toast(
          `+${n} ${ITEM_BREEDS[kind].name}`,
          n > 1 ? 'NOW THAT IS A FIRE' : 'NOW WE ARE COOKING',
          'purple',
          TRADE_TOAST,
        ),
    });
    this.shop = new Shop(this.npcs, this.inventory, this.money, (deed) => this.deed(deed));
    this.trades = new Trades(this.npcs, this.inventory, (deed) => this.deed(deed));

    this.blood = new BloodSim(this.world.collision);
    this.scene.add(this.blood.root);
    this.casualties = new Casualties(this.world.collision, this.blood);
    this.crowd = new Crowd(
      this.scene,
      this.planner,
      this.nav,
      this.rng,
      (at, kind, from) => this.money.drop(at, kind, from),
      this.casualties,
    );
    this.reactions = gameReactions({
      crowd: this.crowd,
      drivers: { frighten: (v, from) => this.frightenDriver(v, from) },
    });
    this.crowd.onFright = (at) => this.events.emit('fright', { at: at.clone() });
    this.crowd.onKeysDropped = (keys, at) =>
      dropKeys(
        keys,
        at,
        this.world.collision.groundAt(at.x, at.z, at.y + 0.5, 0),
        this.junk,
        this.inventory.keys,
        (plate) => this.events.emit('keysFound', { plate }),
      );
    // Connect skeleton rise, removal, and kill callbacks to world effects.
    this.skeletons = new Skeletons(this.world.collision, this.nav, this.planner, this.crowd, this.claims);
    this.scene.add(this.skeletons.root);

    this.skeletons.onRise = (at) => {
      this.debris.burst(_at.copy(at).setY(at.y + 0.2), 14, 5, [0.1, 0.25], [0.8, 1.5], DIRT, 0.9, at.y);
      this.slime.burst(at, 8, 3, [0.08, 0.16], [0.5, 0.9], SLIME, 0.6, at.y);
    };

    this.skeletons.onCrumble = (at) => {
      this.debris.burst(_at.copy(at).setY(at.y + 0.9), 18, 4, [0.08, 0.22], [1.5, 2.5], BONE, 0.5, at.y);
    };

    this.skeletons.onKill = (at) => this.deathGhost(at);
    this.crowd.onGhost = (at) => this.deathGhost(at);

    // Exclude the deck from ordinary visitor parking routes.
    const keepOut = [{ min: level.deck.min, max: level.deck.max }];
    this.visitors = new Visitors(
      level.bays,
      this.planner,
      this.fleet,
      this.traffic,
      this.drivers,
      this.rng,
      keepOut,
      (car) => this.crowd.arrive(car),
    );
    // Use the entry gate as the diversion target, falling back to the deck center.
    const gate = level.gates.find((g) => g.kind === 'entry');
    const entry = gate
      ? new Vector3((gate.min[0] + gate.max[0]) / 2, gate.min[1], (gate.min[2] + gate.max[2]) / 2)
      : this.deckCenter.clone();
    this.garage.bookedBy = (s) => this.claims.holder('spot', s);
    // Treat a stationary vehicle as occupying its spot even before its driver exits.
    this.garage.standingIn = (spot) =>
      this.vehicles.find((v) => !v.gone && Math.abs(v.speed) < STANDING && inSpot(spot, v.pos)) ?? null;
    this.refuge = new Refuge(this.drivers, this.driveWorld, entry);
    this.detours = new Detours(
      this.planner,
      this.nav,
      this.world.collision,
      this.fleet,
      this.traffic,
      (car, ev) => this.impacts.afterDrive(car, ev, NUDGE_LOOSEN),
      this.claims,
    );
    this.ghosts = new Ghosts(level.ghostZones, TUNING.ghosts.ambient);
    this.bats = new Bats(new Vector3(this.deckCenter.x, 0, this.deckCenter.z), 16);
    this.scene.add(
      this.slime.mesh,
      this.debris.mesh,
      this.sprites.root,
      this.ghosts.root,
      this.bats.root,
      this.arrow.root,
      this.honks.root,
    );
    this.fx = {
      scene: this.scene,
      slime: this.slime,
      sprites: this.sprites,
      shake: (t) => this.shake(t),
      flash: (a, c) => this.doFlash(a, c),
    };
    this.codyRide = new CodyRide({
      keys: this.inventory.keys,
      player: this.player,
      cody: this.cody,
      conditions: this.conditions,
      claims: this.claims,
      garage: this.garage,
      collision: this.world.collision,
      scene: this.scene,
      money: this.money,
      vehicles: this.vehicles,
      events: this.events,
      carjacked: (car) => this.valet.carjacked(car),
      bail: (car) => this.crowd.bail(car, this.player.pos),
      transform: (car) =>
        new TransformSequence(car, 'truck', () => VEHICLE_BREEDS.truck.model(this.assets, car.color), this.fx),
      onFoot: (dt) => this.updateOnFoot(dt),
      drive: (car, dt) => this.updateDriving(car, dt),
    });
    this.impacts = new VehicleImpacts(this.world, this.fleet, this.garage, this.junk, this.events, {
      bail: (car, from) => this.crowd.bail(car, from),
      fell: (car) => {
        if (car === this.driving) {
          this.codyRide.exit();
        }
      },
    });
    const drips = this.world.slime;
    drips.onSplat = () => {
      _splatSize[0] = drips.splatSize * 0.25;
      _splatSize[1] = drips.splatSize * 0.5;
      this.slime.burst(
        _splat.copy(drips.splat).setY(drips.splat.y + 0.05),
        4,
        1.6,
        _splatSize,
        SPLAT_LIFE,
        SLIME,
        0.5,
        drips.splat.y,
      );
    };

    this.world.gates.onSnapped = (g, kind) =>
      this.events.emit('prop', { kind, at: g.center.clone(), how: 'knocked', by: null });
    playEffects(this.events, {
      ride: () => this.driving,
      shake: (t) => this.shake(t),
      flash: (a, color) => this.doFlash(a, color),
      toast: (title, sub, tone, seconds) => this.hud.toast(title, sub, tone, seconds),
      slime: this.slime,
      debris: this.debris,
      sprites: this.sprites,
      groundAt: (x, z, y) => this.world.collision.groundAt(x, z, y, 0),
    });

    for (const p of level.parked) {
      // Count initial cars in available deck spots as logged entries.
      const v = this.fleet.spawnCar('parked', new Vector3(...p.pos), p.yaw);
      const s = this.garage.spotAt(v.pos);
      if (s && this.garage.isFree(s, v)) {
        this.garage.checkIn(s, v);
      }
    }

    // Associate initial lot cars with future returning pedestrians.
    this.visitors.adopt();

    for (let i = 0; i < TUNING.traffic.dayCars; i++) {
      this.fleet.spawnTraffic(this.view.target, 0);
    }

    this.hud = new Hud(container, this.input.focus);
    // Supply live getters for HUD state.
    this.hud.bind({
      mode: () => (this.mode === 'title' ? 'title' : this.driving || this.transform ? 'drive' : 'foot'),
      summon: () => this.mode === 'play' && this.onFoot && this.cody.can('summon'),
      hours: () => this.clock.hours,
      phase: () => this.clock.phase,
      day: () => this.clock.day,
      cash: () => this.money.cash,
      inventory: () => this.interactions.inventoryView(this.inventory),
      wares: () => this.shop.view(this.waresShown),
      ledger: () => ({
        logged: this.garage.logged,
        actual: this.garage.actual(this.vehicles),
        phantom: this.garage.phantomOccupancy(this.vehicles),
        max: TUNING.garage.spots,
      }),
      // Exclude crash tumbling from the AIRBORNE indicator.
      dash: () => {
        const v = this.driving;
        if (v) {
          return { speed: v.speed, form: v.form, label: v.breed.label, airborne: !v.grounded && !v.crashing };
        }

        return this.transform ? { speed: 0, form: 'truck', label: VEHICLE_BREEDS.truck.label, airborne: false } : null;
      },
      // Show GhASt controls when the current ride can burn fuel.
      ghast: () => (this.driving?.breed.boost ? { fill: this.ghast, burning: this.fuel.burning } : null),
      reset: () => this.resetOffered,
    });
    // Build the shared phone and connect its notifications to game events.
    this.phone = new Phone(
      this.hud.root,
      this.input.focus,
      {
        time: () => GameClock.format(this.clock.hours),
        goal: () => this.objectives.goal,
        how: () => this.objectives.how,
        now: () => ({ hours: this.clock.hours, day: this.clock.day }),
      },
      new Messages(),
      new Calls(),
      [
        new Tasks({
          goal: () => this.objectives.goal,
          how: () => this.objectives.how,
          aim: () => `FILL ALL ${TUNING.garage.spots} SPOTS WITH PHANTOMS.`,
          marks: () => this.objectives.list,
        }),
        new Phantoms(() => this.phantomReport()),
        new MapApp(),
        new Photos(),
        new Help(helpRows),
      ],
    );
    this.events.on('entered', ({ possessed, from, quiet }) => {
      if (from === null) {
        return;
      } // A null previous role denotes transformation while already seated.

      this.iso.zoomTarget = Math.max(this.iso.zoomTarget, TUNING.camera.driveZoom);
      this.hud.setPrompt(null);

      if (quiet) {
        return;
      }

      if (from === 'valet') {
        this.hud.toast('HEY!', "THAT'S A GUEST'S CAR", 'warn', 1.8);
      }

      if ((from === 'traffic' || from === 'visitor') && this.conditions.parking()) {
        this.hud.toast('STOLEN!', 'GET IT TO THE HAUNTED DECK');
      }

      if (possessed) {
        this.hud.toast(
          this.cody.phantom ? 'PHANTOM CODY!' : 'POSSESSED!',
          'GET IT OUT. NOT THROUGH THE GATE.',
          '',
          2.6,
        );
      }
    });
    this.events.on('exited', ({ spot, quiet }) => {
      this.fuel.burning = false;
      this.stuck.clear();
      this.iso.zoomTarget = Math.min(this.iso.zoomTarget, TUNING.camera.zoom);
      this.hud.setPrompt(null);

      if (spot && !quiet) {
        this.hud.toast('PARKED', spotLabel(spot), 'purple', 1.6);
      }
    });
    this.phone.onBuzz = (what) => this.events.emit('phone', what);
    this.phone.quiet = () => this.hushed();
    this.hud.initMap(level);
    this.hud.onStart(() => this.start());
    this.hud.onItemAction = (kind, id) => this.interactions.useItem(kind, id);
    this.hud.onBuy = (slot, n) => this.buy(slot, n);
    this.hud.setCamera(this.cameras.view);
    this.talk = new ValetTalk(this.hud, this.garage, this.valet, this.rng, this.input.focus, {
      me: () => (this.driving ?? this.player).pos,
      onShift: () => this.conditions.valetsOnShift(),
      carToTake: () => this.codyRide.carForValet(),
      handOff: (car, valet) => this.codyRide.handOff(car, valet.keys),
      cash: () => this.money.cash,
      pay: (amount) => this.money.spend(amount),
    });
    this.randyTalk = new RandyTalk(this.input.focus, this.npcs, {
      tires: () => this.inventory.count('tire'),
      give: (to) => this.interactions.give(to, 'tire'),
    });
    this.interactions = new Interactions(
      this.makePlay(),
      {
        player: this.player,
        vehicles: this.vehicles,
        valet: this.valet,
        randyTalk: this.randyTalk,
        elevators: this.elevators,
        blocked: () =>
          this.mode !== 'play' || this.talk.active || this.randyTalk.active || !!this.cutscene || !!this.transform,
      },
      this.input,
      {
        prompt: (text, control) => this.hud.setPrompt(text, control),
        refused: (reason) => this.hud.toast(reason, '', 'warn', FAIL_TOAST),
        performed: (action) => this.events.emit('performed', { action }),
        failed: (action, reason) => this.events.emit('failed', { action, reason }),
      },
    );
    this.valetFrame = {
      day: true,
      avoid: this.avoid,
      parked: (_v, s, valet) => this.talk.parked(s, valet),
    };
    this.haunting = new Haunting({
      needed: TUNING.garage.spots,
      victory: () => this.hud.showVictory(),
      moved: (step) => this.events.emit('step', { quest: 'haunting', step }),
    });
    this.quests = new Quests([this.haunting]);
    this.events.on('phantom', ({ n }) => this.haunting.mind.send({ type: 'phantom', n }));

    // Initialize the title’s nighttime orbit with the clock paused.
    this.clock.hours = 21.5;
    this.clock.paused = true;
    this.player.setForm('night');
    this.iso.zoom = this.iso.zoomTarget = 74;
    this.iso.snapTo(new Vector3(this.deckCenter.x, 6, this.deckCenter.z));
    this.debug = createGameDebug(this, {
      driving: () => this.driving,
      mode: () => this.mode,
      render: (on) => {
        this.rendering = on;
      },
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

  /** Whether chase view is currently active. */
  private get chaseActive(): boolean {
    return this.cameras.view === 'chase';
  }

  private get view(): IsoCamera | ChaseCamera {
    return this.chaseActive ? this.chase : this.iso;
  }

  /** Current drivable vehicle, or null. */
  private get driving(): Vehicle | null {
    return this.codyRide.driving;
  }

  /** Active vehicle transformation, or null. */
  private get transform(): TransformSequence | null {
    return this.codyRide.transform;
  }

  /** Whether the current ride is in its post-escape sequence. */
  private get escaping(): boolean {
    return this.codyRide.escaping;
  }

  /** Current vehicle, including one undergoing transformation. */
  private get ride(): Vehicle | null {
    return this.codyRide.vehicle;
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

  /** The active camera override also mutes player controls. */
  get cutscene(): Cutscene | null {
    return this.cameraShots.top;
  }

  /** Board a vehicle for a script, quietly leaving the previous ride. Set `own` to prevent glovebox rewards. */
  board(v: Vehicle, own = false): void {
    this.codyRide.board(v, own);
  }

  get vehicleAccess(): VehicleAccess {
    return this.codyRide.access;
  }
  set vehicleAccess(access: VehicleAccess) {
    this.codyRide.access = access;
  }

  /** Spawn a parked civilian vehicle using the supplied kind or normal weighted selection. */
  park(pos: Vector3, yaw: number, kind?: CarKind): Vehicle {
    return this.fleet.spawnCar('parked', pos, yaw, kind);
  }

  /** Exit the current vehicle without a parking notification. */
  alight(): void {
    if (this.driving) {
      this.codyRide.exit(true);
    }
  }

  /** Begin the timed effect that changes Cody to the current clock phase. */
  transformCody(): void {
    this.codyFx = 0;
  }

  /** Set ghost and slime presence, optionally animating their return over `seconds`. */
  haunt(on: boolean, seconds = 0): void {
    this.ghosts.fade(on, seconds);

    if (on && seconds > 0) {
      this.world.slime.emerge(seconds);
    } else {
      this.world.slime.setPresence(on ? 1 : 0);
    }
  }

  private shake(t: number): void {
    this.view.addTrauma(t);
  }

  /** Advance one frame (also used by headless tests). */
  frame(dt: number): void {
    this.time += dt;
    Vehicle.advance(dt);
    this.syncView();

    if (this.mode === 'title') {
      this.updateTitle(dt);
    } else {
      this.updatePlay(dt);
    }

    this.updateShared(dt);
    this.hud.update();
    this.phone.update(dt);
    this.gfx.chaseView = this.chaseActive;

    if (this.rendering) {
      this.gfx.render(this.time);
    }

    this.input.endFrame();
    this.fpsAcc.t += dt;
    this.fpsAcc.n++;

    if (this.fpsAcc.t > 0.5) {
      this.hud.setFps(
        this.fpsAcc.n / this.fpsAcc.t,
        `${this.world.stats.meshes} meshes ${Math.round(this.world.stats.triangles / 1000)}k tris`,
      );
      this.fpsAcc.t = 0;
      this.fpsAcc.n = 0;
    }
  }

  start(): void {
    this.phone.setAvatar(this.portraits.randy);

    if (this.mode === 'play') {
      return;
    }

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

  /** Display the current day and daytime task. */
  announceDay(): void {
    this.hud.toast(`DAY ${this.clock.day}`, 'STEAL CARS. BADGE THEM IN. PARK THEM IN THE DECK.', '', 3.2);
  }

  /**
   * Restore a phantom from game/save.ts. Remove any occupant of its available home spot while retaining that entry
   * count; otherwise add an unmatched logged entry. Create the imprint at the home spot or saved position.
   */
  restorePhantom(spotId: number | null, at: Vector3, yaw: number): void {
    const spot = spotId !== null ? (this.garage.spots[spotId] ?? null) : null;
    const home = spot && !spot.phantom ? spot : null;
    const car = home?.occupant ?? null;
    if (car) {
      this.fleet.remove(car);
    } else {
      this.garage.logged++;
    }

    this.garage.addPhantom(at, yaw, home);
  }

  private updateTitle(dt: number): void {
    this.iso.azimuthTarget += dt * 0.12;
    this.iso.update(dt, _v.set(this.deckCenter.x, 7, this.deckCenter.z), null, 2);
    this.traffic.update(dt, this.vehicles, NONE);
    // Discard horn and detour requests during the title sequence.
    this.traffic.honks.length = 0;
    this.traffic.fedUp.length = 0;
    this.cutaway.off();

    // Handle start after the orbit update so its camera setup remains effective.
    if (this.input.wasPressed('start')) {
      this.start();
    }
  }

  /** Whether Cody is outside both driving and transformation states. */
  private get onFoot(): boolean {
    return this.codyRide.onFoot;
  }

  /** Rebuild perception entries and obstacle bodies before movement. */
  private sense(): void {
    const things = this.things;
    things.length = 0;
    const seen = this.cody.presence(this.driving, !!this.transform);
    if (seen?.kind === 'phantom') {
      things.push({ kind: 'phantom', pos: seen.at });
    } else if (seen?.kind === 'phantomTruck' && this.driving) {
      things.push({ kind: 'phantomTruck', pos: seen.at, vehicle: this.driving });
    }

    for (const pos of this.skeletons.threats) {
      things.push({ kind: 'skeleton', pos });
    }

    for (const person of this.crowd.living()) {
      things.push({ kind: 'townsperson', pos: person.walker.pos, person });
    }

    for (const vehicle of this.vehicles) {
      const driven = vehicle.role === 'traffic' || !!this.drivers.of(vehicle) || this.detours.has(vehicle);
      if (driven && !vehicle.crashing) {
        things.push({ kind: 'driver', pos: vehicle.pos, vehicle });
      }
    }

    this.space.rebuild(things);
    this.senseBodies();
  }

  /** Collect current bodies from each actor system. */
  private senseBodies(): void {
    const b = this.bodies;
    b.clear();
    this.crowd.addBodies(b);
    this.valet.addBodies(b);

    for (const n of this.npcs.list) {
      b.add({ kind: 'still', pos: n.pos, r: NPC_ROOM });

      if (n.fire) {
        b.add({ kind: 'still', pos: n.fire.root.position, r: FIRE_ROOM });
      }
    }

    // Register skeletons for walker avoidance; vehicle braking queries exclude them.
    for (const pos of this.skeletons.threats) {
      b.add({ kind: 'skeleton', pos, r: PERSON_RADIUS });
    }

    if (this.onFoot && this.player.visible) {
      b.add({ kind: 'cody', pos: this.player.pos, vel: this.player.vel, r: TUNING.player.radius });
    }

    for (const v of this.vehicles) {
      if (!v.gone) {
        b.add({ kind: 'car', pos: v.pos, vel: v.vel, r: v.params.radius, vehicle: v });
      }
    }
  }

  /** Deliver a threat sighting to the active driver job, detour, or traffic controller. */
  private frightenDriver(v: Vehicle, from: Vector3): void {
    if (this.drivers.sees(v, from)) {
      return;
    }

    if (this.detours.has(v)) {
      this.detours.frighten(v, from);
    } else {
      this.traffic.frighten(v, from);
    }
  }

  private updatePlay(dt: number): void {
    const inp = this.input;
    inp.muted = !!this.cutscene;
    this.clock.rate = inp.isDown('fastForward') ? TUNING.clock.fastForward : 1;

    if (inp.wasPressed('nextPhase')) {
      this.clock.skipToNextPhase();
    }

    const ev = this.clock.update(dt);
    if (ev.nightfall) {
      this.onNightfall();
    }

    if (ev.sunrise) {
      this.onSunrise();
    }

    if (inp.wasPressed('camera')) {
      this.cycleCamera();
    }

    if (!this.chaseActive) {
      if (inp.wasPressed('rotateLeft')) {
        this.iso.rotate(-1);
      }

      if (inp.wasPressed('rotateRight')) {
        this.iso.rotate(1);
      }
    }

    if (inp.wasPressed('phone')) {
      this.phone.toggle();
    }

    if (inp.wasPressed('map')) {
      this.phone.toggle('map');
    }

    if (inp.wasPressed('help')) {
      this.phone.toggle('help');
    }

    if (inp.wasPressed('reload') && !this.resetOffered) {
      reloadIfPending();
    }

    const wheel = inp.consumeWheel();
    if (wheel) {
      this.view.zoomBy(wheel);
    }

    // Consume mouse movement even in isometric view to prevent a jump when chase view resumes.
    const [mx, my] = inp.consumeMouse();

    // Index bodies before movement for this frame's proximity queries.
    this.claims.newFrame();
    this.sense();

    // Move elevators before Cody so standing passengers follow the cab.
    this.elevators.update(dt, this.driving || this.transform ? NONE : this.riders);
    this.codyRide.tick(dt);

    this.updateMorphs(dt);
    this.updateCodyFx(dt);
    // Evaluate visibility-based fright reactions for indexed pedestrians and drivers.

    const seen = this.cody.presence(this.driving, !!this.transform);
    const ghost = seen && FRIGHTENING.has(seen.kind) ? seen.at : null;
    react(this.perception, this.reactions);
    // Traffic brakes for Cody, moving pedestrians, and fallen bodies.
    const obstacles = this.bodies.points(
      (b) => b.kind === 'cody' || b.kind === 'down' || (b.kind === 'person' && b.moving),
      this.trafficObstacles,
    );
    this.traffic.update(dt, this.vehicles, obstacles);

    for (const v of this.traffic.abandoned.splice(0)) {
      this.crowd.bail(v, ghost ?? v.pos);
      this.fleet.abandon(v);
    }

    // Report new frights, then offer deck diversions to cornered drivers.
    for (const { car } of this.traffic.scared.splice(0)) {
      this.events.emit('spooked', { car });
    }

    for (const { car, from } of this.traffic.cornered.splice(0)) {
      this.refuge.take(car, from);
    }

    // Process horn requests and detours from impatient traffic.
    for (const v of this.traffic.honks.splice(0)) {
      this.honk(v);
    }

    for (const j of this.traffic.fedUp.splice(0)) {
      this.detours.take(j);
    }

    this.fillAvoidance();
    this.crowd.update(dt, {
      near: this.view.target,
      day: this.conditions.daylight(),
      driving: this.driving,
      vehicles: this.vehicles,
      avoid: this.avoid,
      visitors: this.visitors,
    });

    // Remove skeletons during daylight; otherwise follow Cody’s current position.
    if (this.conditions.daylight() && this.skeletons.count) {
      this.skeletons.crumbleAll();
    }

    this.skeletons.update(dt, this.driving ? this.driving.pos : this.player.pos, this.vehicles);
    this.collectMoney(dt);
    this.shop.update(this.onFoot && this.mode === 'play' && !this.cutscene ? this.player.pos : null);
    // Project the active conversation bubble above its speaker.
    const me = (this.driving ?? this.player).pos;
    const said = this.talk.update(dt, me) ?? this.randyTalk.update(dt, me) ?? this.bubble;
    const head = said && this.toScreen(said.at);
    this.hud.setBubble(said && head ? { ...head, who: said.who, line: said.line, choices: said.choices } : null);
    this.fleet.update(dt, this.dayNight.nightness);
    this.fleet.maintain(dt, this.view.target, this.conditions.daylight());

    const focusV = this.ride;
    const cut = this.cutscene;
    const focus = cut ? cut.focus : focusV ? focusV.pos : this.player.pos;
    // Keep isometric tracking current while chase view is active to avoid a large transition on return.
    const lead =
      focusV && !cut ? _w.set(clamp(focusV.vel.x * 0.35, -7, 7), 0, clamp(focusV.vel.z * 0.35, -7, 7)) : null;
    if (cut) {
      this.iso.zoomTarget = cut.zoom;
    }

    this.iso.update(dt, focus, lead, cut ? 2.5 : focusV ? 5 : 6);

    if (this.chaseActive) {
      const kind: ChaseKind = focusV ? focusV.form : 'foot';
      const subject = { kind, pos: focus, vel: focusV ? focusV.vel : this.player.vel, yaw: focusV ? focusV.yaw : null };
      this.chase.look(mx, my);
      this.chase.update(dt, subject, inp.axis('rotateLeft', 'rotateRight'), this.world.collision);
    }

    // Fade Cody when the on-foot chase camera approaches his body.
    this.player.seenFrom(this.chaseActive && !focusV ? this.chase.camera.position : null, dt);
    // Enable the ghost pass for faded Cody or phantom imprints above the sky band.
    this.gfx.ghost.enabled = this.player.faded || this.garage.phantoms > 0;

    if (this.chaseActive) {
      this.cutaway.off();
    } else {
      this.cutaway.update(dt, focus, focusV, this.iso, this.world.collision, this.world.sight);
    }

    this.updateNav(dt);
    const randy = this.randyTalk.enabled ? (this.npcs.find('randy')?.pos ?? null) : null;
    this.objectives.replace(this.trades, tireMarks(this.inventory.count('tire'), randy));
    this.updateObjectives();
    this.events.emit('frame', dt);
  }

  /** Translate registered bodies into pedestrian avoidance inputs. */
  private fillAvoidance(): void {
    const a = this.avoid;
    a.clear();
    this.bodies.each((b) => {
      if (b.kind === 'person') {
        a.person(b.pos, b.vel, b.dodges, b.owner);
      } else if (b.kind === 'cody') {
        a.mover(b.pos, b.vel, b.r);
      } else if (b.kind === 'car' && b.vehicle) {
        a.vehicle(b.vehicle);
      } else {
        a.still(b.pos, b.r);
      }
    });
  }

  /**
   * Collect money on foot or while driving, and collectible items only on foot. Disable collection during
   * transformation.
   */
  private collectMoney(dt: number): void {
    const M = TUNING.money;
    const me = this.driving ? this.driving.pos : this.transform ? null : this.player.pos;
    for (const got of this.money.update(dt, me, this.driving ? M.reachCar : M.reachFoot)) {
      this.events.emit('money', { kind: got.kind, amount: got.amount });
    }

    const onFoot = this.driving || this.transform ? null : this.player.pos;
    for (const kind of this.junk.update(dt, onFoot)) {
      this.gain(kind, 1);
      this.gotToast(kind);
    }
  }

  /** Transfer one free item from an NPC’s stock and show its pickup notification. Return false when unavailable. */
  handOver(from: Npc, kind: ItemKind): boolean {
    if (!this.shop.gift(from, kind)) {
      return false;
    }

    this.gotToast(kind);
    return true;
  }

  /** Display the item name and optional note, extending duration when there is a note. */
  private gotToast(kind: ItemKind): void {
    const { name, note } = ITEM_BREEDS[kind];
    this.hud.toast(`+ ${name}`, note ?? '', '', note ? TRADE_TOAST : MONEY_TOAST);
  }

  /** Buy up to the requested stock quantity, limited by availability and balance, and announce the transfer. */
  private buy(slot: string, n: number): void {
    const got = this.shop.buy(slot, n);
    if (!got) {
      return;
    }

    this.hud.toast(`+${got.n} ${ITEM_BREEDS[got.kind].name}`, `-$${got.cost}`, '', MONEY_TOAST);
  }

  /** Add inventory items and report their acquisition. */
  private gain(kind: ItemKind, n: number): void {
    this.inventory.add(kind, n);
    this.deed({ how: 'got', kind, n });
  }

  /** Publish the inventory deed and update milestone triggers. */
  private deed(d: ItemDeed): void {
    this.events.emit('item', d);
    this.triggers.deed(d);
  }

  private updateOnFoot(dt: number): void {
    const blockers = this.blockers;
    let n = 0;
    for (const v of this.vehicles) {
      if (v.gone) {
        continue;
      }

      const b = (blockers[n++] ??= { pos: v.pos, r: 0 });
      b.pos = v.pos;
      b.r = v.params.length * 0.42;
    }

    // Use current NPC and fire positions so scripted relocation also moves their obstacles.
    for (const npc of this.npcs.list) {
      const b = (blockers[n++] ??= { pos: npc.pos, r: 0 });
      b.pos = npc.pos;
      b.r = NPC_ROOM;

      if (!npc.fire) {
        continue;
      }

      const f = (blockers[n++] ??= { pos: npc.fire.root.position, r: 0 });
      f.pos = npc.fire.root.position;
      f.r = FIRE_ROOM;
    }

    blockers.length = n;
    this.player.update(dt, this.input, this.view, this.world.collision, blockers, this.world.gates);
    this.interactions.update();
  }

  /** Adds a script's offer, such as the tutorial's talk with Randy. The returned function removes it. */
  addOffer(source: () => CodyAction | null): () => void {
    return this.interactions.addOffer(source);
  }

  /** Adapt game services to the interface used by Cody’s actions. */
  private makePlay(): Play {
    return {
      cody: this.cody,
      conditions: this.conditions,
      ride: () => this.driving,
      possessable: (car) => this.codyRide.possessable(car),
      canEnter: (car) => this.codyRide.canEnter(car),
      canHotwire: (car) => this.codyRide.canHotwire(car),
      hotwire: (car) => this.codyRide.hotwire(car),
      enter: (car) => this.codyRide.enter(car),
      exit: () => this.codyRide.exit(),
      escaping: () => this.escaping,
      locked: () => this.doorLock,
      inFreeSpot: (car) => {
        const spot = this.garage.spotAt(car.pos);
        return !!spot && this.garage.isFree(spot, car);
      },
      talkToValet: (valet) => this.talk.start(valet),
      talkToRandy: (randy) => this.randyTalk.start(randy),
      summon: () => this.summon(),
      items: {
        inventory: this.inventory,
        canEat: () => this.canEat,
        used: (kind, action) => this.deed({ how: 'used', kind, action }),
        skipPhase: (notice) => this.skipPhase(notice),
      },
      tradeFor: (kind) => (this.mode === 'play' && this.onFoot ? this.trades.offer(kind, this.player.pos) : null),
      give: (to, kind) => this.trades.give(to, kind, this.player.pos) > 0,
    };
  }

  /** Summon skeletons at Cody's position and return the number raised. */
  summon(): number {
    if (!this.cody.can('summon') || this.driving || this.transform) {
      return 0;
    }

    const n = this.skeletons.summon(this.player.pos, this.player.yaw);
    if (n > 0) {
      this.shake(0.15);
      this.events.emit('summoned', { n });
    }

    return n;
  }

  /** Movement, contacts, and effects for Cody's current vehicle. */
  private updateDriving(v: Vehicle, dt: number): void {
    if (v.rig.rider) {
      this.player.ride(dt);
    }

    const inp = this.input;
    const di: DriveInput = this.autopilot?.(v, dt) ?? {
      throttle: inp.axis('back', 'forward'),
      steer: inp.axis('left', 'right'),
      hop: inp.wasPressed('hop'),
      drift: inp.isDown('drift'),
    };
    if (this.escaping) {
      di.throttle = Math.max(di.throttle, 0);
    }

    di.boost = this.fuel.update(v, this.input.isDown('boost'), dt, this.ghosts, this.events, this.cody.can('intake'));
    const prev = _prev.copy(v.pos);
    const ev = v.drive(dt, di, this.world.collision);
    if (ev.hopped) {
      this.slime.burst(v.pos, 10, 4, [0.12, 0.25], [0.6, 1], SLIME, 0.6, v.pos.y);
    }

    this.impacts.afterDrive(v, ev);

    const c = this.garage.track(v, prev);
    if (c) {
      this.onCrossing(c);
    }

    this.exhaust.drive(dt, v, di.throttle, this.fuel.burning);
    this.stuck.update(dt, v, !this.cutscene && !this.escaping && inp.axis('back', 'forward') !== 0);

    if (this.resetOffered && inp.wasPressed('reset')) {
      this.resetVehicle(v);
    }

    this.interactions.update();
  }

  private get resetOffered(): boolean {
    return this.mode === 'play' && !!this.driving && !this.cutscene && this.stuck.on;
  }

  resetVehicle(v: Vehicle, pose?: Pose): void {
    const at = pose ?? openPose(v, this.nav, this.vehicles);
    const { x, z } = at?.pos ?? v.pos;
    const y = at?.pos.y ?? this.world.collision.groundAt(x, z, v.pos.y + 0.5, v.params.stepUp);
    v.place(x, y, z, at?.yaw ?? v.yaw, 0, 0, this.world.collision);
    this.garage.resync(v);
    this.stuck.clear();

    if (v === this.ride) {
      this.chase.snapBehind(v.yaw);
    }

    this.events.emit('reset', { v });
  }

  /** Project a world point into CSS pixels, returning null when its projected depth is at or beyond one. */
  toScreen(p: Vector3): { x: number; y: number } | null {
    // Apply render curvature before camera projection; see render/curvature.ts.
    this.gfx.bend(_v.copy(p)).project(this.view.camera);

    if (_v.z >= 1) {
      return null;
    }

    const r = this.gfx.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((_v.x + 1) / 2) * r.width, y: r.top + ((1 - _v.y) / 2) * r.height };
  }

  private onCrossing(c: Crossing): void {
    this.events.emit('crossing', c);
    const v = c.vehicle;
    switch (c.kind) {
      case 'logged-in':
        this.hud.toast('BEEP', 'BADGE SCANNED. ENTRY LOGGED.', 'purple', 1.4);
        break;
      case 'logged-out':
        if (v.form === 'truck') {
          this.hud.toast('BADGE SCANNED', 'EXIT LOGGED. THE GARAGE SAW YOU. NO PHANTOM.', 'warn', 2.6);
        } else {
          this.hud.toast('BEEP', 'BADGE SCANNED. EXIT LOGGED.', 'purple', 1.4);
        }

        this.garage.release(v);
        v.homeSpot = null;
        break;
      case 'snuck-in':
        this.hud.toast('SNUCK IN', 'NO BADGE, NO RECORD', 'warn', 1.8);
        break;

      case 'escaped': {
        if (this.counted.has(v)) {
          break;
        }

        const phantom = this.garage.escape(v);
        if (!phantom) {
          break;
        }

        this.counted.add(v);
        const { imprint, home } = phantom;
        this.events.emit('phantom', {
          at: imprint.position.clone(),
          yaw: imprint.rotation.y,
          spot: home,
          n: this.garage.phantoms,
          hours: this.clock.hours,
          day: this.clock.day,
        });
        this.hud.toast(`PHANTOM CODY #${this.garage.phantoms}`, 'OOPS! YOU FORGOT TO BADGE OUT!', '', 2.8);
        this.doFlash(0.35, '#9dff3a');
        this.shake(0.3);

        if (!this.keepEscaped) {
          this.codyRide.escaped();
        }

        break;
      }
    }
  }

  private deathGhost(at: Vector3): void {
    this.sprites.spray(_at.copy(at).setY(at.y + 0.6), 3, 2, [1.6, 2.6], WHITE, 1.2, 2.4, 1.4, 'ghost', 0.8);
    this.ghosts.rise(at);
  }

  private onNightfall(): void {
    this.hud.toast('THE MOON IS UP', this.cody.holdForm ? 'THE DECK WAKES UP' : 'PHANTOM CODY RISES', '', 3.2);
    this.doFlash(0.6, '#b46bff');
    this.shake(0.3);

    if (!this.cody.holdForm) {
      this.codyFx = 0;
    }

    this.codyRide.moonrise();
    this.events.emit('nightfall', null);
  }

  private onSunrise(): void {
    this.hud.toast(`DAY ${this.clock.day}`, 'SUN UP. BACK TO WORK.', 'warn', 3);
    // Clear remaining GhASt at sunrise.
    this.ghast = 0;
    this.money.scatter();

    if (!this.cody.holdForm) {
      this.codyFx = 0;
    }

    this.impacts.repair();
    this.skeletons.crumbleAll();

    // Start civilian-form transformations for trucks without an active status.
    for (const v of this.vehicles) {
      if (v.form !== 'truck' || v.status) {
        continue;
      }

      if (v === this.driving) {
        this.codyRide.exit();
      }

      this.morphs.push(
        new TransformSequence(v, 'car', () => VEHICLE_BREEDS[v.kind].model(this.assets, v.color), this.fx),
      );
    }

    // Notify listeners after world repair and sunrise transformations are initialized.
    this.events.emit('sunrise', null);
  }

  private updateMorphs(dt: number): void {
    // Compact unfinished transformations in place while preserving order.
    let n = 0;
    for (const m of this.morphs) {
      m.update(dt);

      if (!m.done) {
        this.morphs[n++] = m;
      }
    }

    this.morphs.length = n;
  }

  /** Animate smoke, switch Cody’s form at 0.6 seconds, and finish the effect after one second. */
  private updateCodyFx(dt: number): void {
    if (this.codyFx < 0) {
      return;
    }

    const before = this.codyFx;
    // Anchor the effect to the current ride when Cody is inside a vehicle.
    const p = (this.ride ?? this.player).pos;
    if (before === 0) {
      this.events.emit('outfit', { form: this.clock.phase, at: p.clone() });
    }

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

    if (this.codyFx > 1) {
      this.codyFx = -1;
    }
  }

  private updateShared(dt: number): void {
    const nightness = this.dayNight.nightness;
    this.planner.update();

    if (this.mode === 'play') {
      // Include vehicle body circles in AI braking obstacles.
      const obstacles = this.bodies.obstacles(
        (b) => b.kind === 'car' || b.kind === 'cody' || b.kind === 'down' || (b.kind === 'person' && b.moving),
        this.valetObstacles,
      );
      this.valetFrame.day = this.conditions.valetsOnShift();
      this.valet.update(dt, this.valetFrame);
      this.visitors.update(dt, this.view.target);
      this.drivers.update(dt);
      this.detours.update(dt, obstacles);

      // Defer driver escape from detour crashes until the car settles.
      for (const v of this.detours.stranded.splice(0)) {
        this.impacts.deferBail(v, v.pos);
      }
    }

    const movers = this.movers;
    movers.length = 0;

    for (const v of this.vehicles) {
      if (v.role !== 'parked') {
        movers.push(v.pos);
      }
    }

    this.world.gates.update(dt, movers, this.vehicles);
    this.world.clocks.update(this.clock.hours);
    this.garage.update(dt, !!this.driving && this.driving.form === 'car' && this.conditions.parking(), nightness);
    const focus = this.view.target;
    this.dayNight.apply(this.clock.hours, (focus.x - focus.z) * 0.002 + this.iso.azimuth * 0.3);
    this.impacts.update(dt, this.mode === 'play');
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

    // Fit isometric shadows to visible corners; use a local focus for the longer chase view.
    if (this.chaseActive) {
      this.lights.follow(this.chase.shadowFocus(_s), this.dayNight.sunDir);
    } else {
      this.lights.cover(this.iso.shadowCorners(_shadowPts), this.dayNight.sunDir, this.iso.screenUp(_s));
    }

    this.fadePhaseSkip(dt);
    this.flash = Math.max(0, this.flash - dt * 1.8);
    this.gfx.grade.uniforms.flash!.value = this.flash * this.flash;
    (this.gfx.grade.uniforms.flashColor!.value as Color).copy(this.flashColor);
  }

  /** Build the ledger and haunted-spot report for the phone’s Phantoms app. */
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

  /**
   * Update objective projections and map state around Cody. Hide world markers during cutscenes while retaining map
   * markers.
   */
  private updateObjectives(): void {
    const me = this.ride ?? this.player;
    const list = this.objectives.list;
    this.hud.setObjectives(this.cutscene ? [] : list, this.view.camera, (p) => this.toScreen(p), me.pos);
    const up = this.view.screenUp(_up);
    this.hud.setMap(
      {
        x: me.pos.x,
        z: me.pos.z,
        yaw: me.yaw,
        upX: up.x,
        upZ: up.z,
        driving: this.ride !== null,
        marks: [...list, ...this.objectives.pins].map((o) => ({ x: o.at.x, z: o.at.z, kind: o.kind, color: o.color })),
      },
      this.phone.showing('map') ? this.phone.body('map') : null,
    );
  }

  /** Guide civilian cars to free parking and trucks inside the deck toward an unbroken parapet. */
  private updateNav(dt: number): void {
    const v = this.driving;
    let goal: Vector3 | null = null;
    let key = '';
    let profile: NavProfile = NAV.car;
    let query: NavQuery | undefined;
    if (v && this.conditions.parking() && v.form === 'car') {
      // When parking is enabled, route to a free spot through the entry gate if outside.
      const s = this.garage.nearestFree(v.pos, null);
      if (s) {
        goal = s.center;
        key = `spot${s.def.id}`;

        if (!v.insideDeck) {
          query = this.entryQuery;
        }
      }

      this.arrow.setColor(PALETTE.slime);
    } else if (v && v.form === 'truck' && v.insideDeck && !this.escaping) {
      // Prefer the nearest unbroken parapet on the current floor.
      const floor = this.garage.floorOf(v.pos.y);
      let best: BreakablePiece | null = null;
      let bd = Infinity;
      for (const b of this.world.breakables) {
        if (b.broken) {
          continue;
        }

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
    if (v && goal) {
      target = this.guide.update(dt, v.pos, goal, key, profile, query);
    } else {
      this.guide.reset();
    }

    this.arrow.update(dt, v ? v.pos : null, v?.rig.height ?? 2, target);
  }

  /** Return a target three meters inward from the parapet, at its base height. */
  private insideOf(b: BreakablePiece, out: Vector3): Vector3 {
    const { min, max } = b.solid;
    const alongX = max[0] - min[0] > max[2] - min[2];
    out.set(b.center.x, min[1], b.center.z);

    if (alongX) {
      out.z += Math.sign(this.deckCenter.z - out.z) * 3;
    } else {
      out.x += Math.sign(this.deckCenter.x - out.x) * 3;
    }

    return out;
  }

  /** Emit the horn event, display its caption, and flash the headlights using current impatience. */
  private honk(car: Vehicle): void {
    const anger = this.traffic.angerOf(car);
    this.events.emit('honk', { car, at: car.pos.clone(), anger });
    this.honks.pop(_at.copy(car.pos).setY(car.pos.y + car.rig.height + 0.2), anger);
    this.fleet.flash(car);
  }

  private hushed(): boolean {
    const ride = this.ride;
    return (
      this.mode !== 'play' ||
      !!this.cutscene ||
      this.phone.calling ||
      this.talk.active ||
      this.randyTalk.active ||
      document.body.classList.contains('dialogue-open') ||
      !!this.hud.root.querySelector('.signpost.on') ||
      (!!ride && !ride.grounded)
    );
  }

  nearestGhost(at: Vector3, out: Vector3): boolean {
    return this.ghosts.nearest(at, out);
  }

  activeGhosts(): readonly Readonly<Vector3>[] {
    return this.ghosts.active();
  }

  raiseGhost(at: Vector3): void {
    this.ghosts.rise(at);
  }

  looseItems(kind: ItemKind): readonly Vector3[] {
    return this.junk.where(kind);
  }

  /** Emit a smoke request using a copied ground position. */
  puff(at: Vector3): void {
    this.events.emit('puff', { at: at.clone() });
  }

  /** Cody can eat on foot, outside cutscenes and phase skips. */
  private get canEat(): boolean {
    return !this.driving && !this.transform && !this.cutscene && !this.phaseFade.active;
  }

  /** Fade through the next day/night boundary unless the tutorial has disabled meal skips. */
  private skipPhase({ title, message }: { title: string; message: string }): void {
    if (this.skipAfterEating && this.phaseFade.start()) {
      this.hud.toast(title, message, 'purple', PHASE_SKIP.toast);
    }
  }

  /** Apply the phase-skip and scripted fades after normal day/night grading. */
  private fadePhaseSkip(dt: number): void {
    const exposure = this.gfx.grade.uniforms.exposure as { value: number };
    exposure.value *= this.phaseFade.update(dt) * this.scriptFade.update(dt);
  }

  fadeThrough(whileDark: () => void): boolean {
    if (!this.scriptFade.start()) {
      return false;
    }

    this.whileDark = whileDark;
    return true;
  }

  get fading(): boolean {
    return this.scriptFade.active;
  }

  private doFlash(a: number, color = '#9dff3a'): void {
    this.flash = Math.max(this.flash, a);
    this.flashColor.set(color);
  }
}

/** Return the actor’s world-space sight point using its configured eye-height offset. */
function eyeOf(thing: Thing): [number, number, number] {
  return [thing.pos.x, thing.pos.y + EYE_HEIGHT[thing.kind], thing.pos.z];
}

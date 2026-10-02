/** Central tuning table. Everything gameplay-feel related lives here. */

export interface VehicleParams {
  maxSpeed: number;
  reverseSpeed: number;
  accel: number;
  brake: number;
  drag: number;
  maxSteer: number;
  wheelBase: number;
  grip: number;
  driftGrip: number;
  /** Collision circle radius (three circles are placed along the body). */
  radius: number;
  length: number;
  height: number;
  /** Max ledge the vehicle can roll up without being blocked. */
  stepUp: number;
  /** Vertical impulse for the hop (Space). */
  hop: number;
  /** Minimum speed to smash breakable parapets (Infinity = can't). */
  smashSpeed: number;
  /** Two-wheelers lean into turns, up to this angle (radians); cars just roll a little on their springs. */
  lean?: number;
}

/**
 * Where a vehicle's collision circles sit along its length (tail, middle,
 * nose), each of `params.radius`. The physics uses them, and so does anything
 * checking whether a simulated pose fits (autopilot rollouts, drive searches).
 */
export function bodyOffsets(params: VehicleParams): number[] {
  const half = bodyHalf(params);
  return [-half, 0, half];
}

/** How far the nose and tail collision circles sit from the middle one. */
export function bodyHalf(params: Pick<VehicleParams, 'length' | 'radius'>): number {
  return params.length / 2 - params.radius;
}

/** At top speed the wheels turn this much less than at a crawl (less twitchy at speed). */
const STEER_FADE = 0.45;

/** Share of full steering lock available at `speed` (m/s). The physics uses it, and so does anything simulating a vehicle. */
export function steerScale(params: VehicleParams, speed: number): number {
  return 1 - STEER_FADE * Math.min(1, Math.abs(speed) / params.maxSpeed);
}

export const TUNING = {
  clock: {
    /** Hours as decimals: 7.5 = 7:30. */
    startHour: 7.5,
    sunrise: 7.5,
    nightfall: 19,
    secondsPerGameHour: 15,
    fastForward: 14,
  },
  camera: {
    zoom: 30,
    driveZoom: 38,
    minZoom: 14,
    maxZoom: 90,
    distance: 240,
    /**
     * Small screens zoom both rigs in. CSS pixels are close to a constant visual angle, so a phone
     * held sideways (short side about 390 px) showing the desktop view draws everything at about 60%
     * of its laptop size. Below `shortSide` px the view shrinks by (short / shortSide)^power, which
     * brings a phone back to about laptop size and still shows more than a 1:1 scale would.
     */
    fit: { shortSide: 800, power: 0.6 },
    /**
     * World curvature in the top-down view, an experiment: every material's vertex shader bends
     * the world onto a small planet (render/curvature.ts), so the ground curves away into a real
     * horizon with sky behind it. `on` switches it all, the tiling included (?curve=0 or ?curve=1
     * overrides). `radius` is the planet's radius in view heights at the default zoom, the one
     * strength: smaller is rounder, larger flatter. Zooming keeps the planet's size. `lean` is
     * how far buildings stand out along the planet's radius (1, fanning out as they rise) rather
     * than straight up (0). `tile` (m) is the grid long faces are split on so they bend smoothly;
     * the ground hazes toward the horizon once it faces the view less than `haze` (0 is edge on).
     */
    curve: { on: true, radius: 8, lean: 0, tile: 5, haze: 0.25 },
    /** Third-person rig (C toggles it): boom length, pivot height above the feet, boom pitch in radians. */
    chase: {
      foot: { dist: 6, pivot: 1.5, pitch: 0.22 },
      car: { dist: 8.5, pivot: 1.3, pitch: 0.2 },
      truck: { dist: 11.5, pivot: 2.4, pitch: 0.22 },
      /** Field of view (degrees) across the screen's short side. */
      fov: 60,
      /** Widest horizontal view (degrees, 16:9 at `fov`): wider screens trim the vertical view instead of stretching. */
      maxHFov: 92,
      /** Extra field of view at top speed. */
      fovBoost: 10,
      /** Q/E look-around speed, radians per second. */
      orbitRate: 2.4,
      /** Mouse look: radians per pixel, boom pitch limits, and how long the view holds before recentering. */
      mouseSens: 0.0025,
      pitchMin: -0.12,
      pitchMax: 1.2,
      recenterDelay: 1.5,
      /** Clearance the camera keeps from walls and slabs. */
      pad: 0.35,
      /** Distance fog (world units): the chase view can see to the edge of the map. */
      fogNear: 45,
      fogFar: 150,
    },
  },
  /** X-ray window radius (world units) around the focus when something blocks the view. */
  cutaway: { foot: 6.2, car: 7.8, truck: 9.4 },
  gravity: 32,
  player: { walk: 7, run: 11.5, radius: 0.45, height: 1.8, stepUp: 0.55, hop: 8.5 },
  car: {
    maxSpeed: 25,
    reverseSpeed: 9,
    accel: 17,
    brake: 32,
    drag: 0.35,
    maxSteer: 0.55,
    // body sizes match the sedan model at SEDAN_SCALE
    wheelBase: 2.48,
    grip: 9,
    driftGrip: 1.8,
    radius: 0.97,
    length: 4.05,
    height: 1.66,
    stepUp: 0.45,
    hop: 7.5,
    smashSpeed: Infinity,
  } satisfies VehicleParams,
  /**
   * The compact pickup and the motorcycle stay within the sedan's length, radius and turning
   * circle (wheelBase / tan(maxSteer) <= 4.04 m): valets plan every car's route as a sedan.
   */
  pickup: {
    maxSpeed: 23,
    reverseSpeed: 8,
    accel: 15,
    brake: 30,
    drag: 0.38,
    maxSteer: 0.55,
    wheelBase: 2.4,
    grip: 8.5,
    driftGrip: 2.0,
    radius: 0.94,
    length: 4.0,
    height: 1.74,
    stepUp: 0.5,
    hop: 7.5,
    smashSpeed: Infinity,
  } satisfies VehicleParams,
  motorcycle: {
    maxSpeed: 29,
    reverseSpeed: 3,
    accel: 22,
    brake: 30,
    drag: 0.3,
    maxSteer: 0.4,
    wheelBase: 1.5,
    grip: 10,
    driftGrip: 2.6,
    radius: 0.42,
    length: 2.1,
    height: 1.6,
    stepUp: 0.35,
    hop: 8,
    smashSpeed: Infinity,
    lean: 0.6,
  } satisfies VehicleParams,
  truck: {
    maxSpeed: 27,
    reverseSpeed: 11,
    accel: 21,
    brake: 36,
    drag: 0.3,
    maxSteer: 0.6,
    wheelBase: 3.8,
    grip: 7,
    driftGrip: 2.2,
    radius: 1.7,
    length: 5.6,
    height: 3.8,
    stepUp: 1.0,
    hop: 10.5,
    smashSpeed: 8,
  } satisfies VehicleParams,
  traffic: {
    dayCars: 18,
    nightCars: 7,
    speedMin: 6,
    speedMax: 10,
    /**
     * Ghost Cody within `panicReach` (m) frightens a driver: for `panicTime`
     * seconds they push on at `panicBoost` times their cruise; held below
     * `stuckSpeed` (m/s) for `stuckTime` seconds, they leave the car and run.
     */
    panicReach: 8,
    panicTime: 5,
    panicBoost: 1.8,
    stuckSpeed: 1,
    stuckTime: 1.5,
    /**
     * At night a driver frightened within `divertReach` (m) of the deck's
     * entry gate turns off into the haunted deck, parks in a free spot and
     * runs, leaving phantom Cody a car to possess. At most `divertMax` are on
     * their way at once. No route within `divertWait` seconds (the planner is
     * shared and deck drives are slow to plan), and they bail where they are.
     */
    divertReach: 70,
    divertMax: 2,
    divertWait: 6,
    /**
     * Impatient drivers. Each driver's anger runs 0 (calm) to 1 (fuming). It
     * rises while they're stopped (below `speed`, m/s): `rise.blocked` a
     * second behind something that isn't traffic going about its business (a
     * parked or wrecked car, Cody's, someone on foot), `rise.queued` in a queue
     * of traffic, and `rise.honkedAt` at once when the driver behind honks at
     * them. On the move it fades by `calm` a second. Pairs run [calm, fuming],
     * eased by anger.
     *
     * Traffic stops `room` (m, middle to middle) short of something that isn't
     * traffic (room to pull out round it) and `gap` short of traffic, so an
     * angry driver creeps up on what's in front. Past `honkAt` they honk,
     * again every `again` seconds. Behind something that isn't traffic they
     * try to pull round it `pullAfter` seconds after a honk; in a queue, only
     * once past `queueJump`. A pull-round is a planned drive out of the lane
     * and back into it `past` (m) or more beyond what's in the way, where
     * there's `clear` (m) of room, at most `reach` (m) along the lane and no
     * more than `detour` times as far to drive, keeping `squeeze` (m) round
     * standing cars (people get a little more). At most `max` pull round at
     * once (the planner is shared). No route within `planWait` seconds, or
     * none worth taking, and they wait on. Before pulling out a pull-round
     * waits up to `gapWait` seconds for oncoming traffic within `oncoming` (m)
     * to pass.
     */
    impatience: {
      speed: 1,
      rise: { blocked: 0.08, queued: 0.025, honkedAt: 0.15 },
      calm: 0.12,
      room: [8, 6],
      gap: [5, 4.4],
      honkAt: 0.3,
      again: [7, 2.5],
      pullAfter: [1, 0.3],
      queueJump: 0.7,
      past: 9,
      clear: 4.5,
      reach: [30, 45],
      detour: 2.5,
      squeeze: [0.8, 0.4],
      max: 2,
      planWait: 5,
      oncoming: [22, 10],
      gapWait: [6, 1.5],
    },
  },
  /** Anything with its engine running. */
  vehicle: {
    /**
     * Idle shake: with someone at the wheel, the body buzzes on its springs,
     * `lift` (m) up and down, `roll` and `pitch` (rad), at about `hz`. On the
     * move it fades to `moving` of that by `fade` (m/s). Each car's pace is
     * its own, within `spread` of the rest. `kinds` scales each build's
     * [size, pace]: bikes buzz quicker, the monster truck rumbles.
     */
    idleShake: {
      lift: 0.01,
      roll: 0.0055,
      pitch: 0.003,
      hz: 13,
      spread: 0.15,
      moving: 0.35,
      fade: 8,
      kinds: { sedan: [1, 1], pickup: [1.15, 0.9], motorcycle: [0.8, 1.4], truck: [2.4, 0.6] },
    },
    /**
     * Tailpipe smoke: `share` of cars (not the monster truck, which has its
     * own) puff a little dark exhaust speeding up harder than `accel` (m/s^2)
     * below `upTo` (m/s): up to `burst` puffs a go, `every` seconds apart. A
     * puff grows over `size` (m) in `life` (s), at most `alpha` opaque. It's
     * unlit, so its grey goes from `day` to `night` with the dark (by day a
     * shade lighter than the asphalt, or it wouldn't show on the road).
     */
    exhaust: {
      share: 0.35,
      accel: 3.5,
      upTo: 9,
      burst: 4,
      every: 0.14,
      size: [0.5, 1.8],
      life: [0.8, 1.2],
      day: '#6f6a76',
      night: '#34303b',
      alpha: 0.75,
    },
  },
  /** Townsfolk on the sidewalks. */
  crowd: {
    /** How many are about near the view, by day and by night. */
    day: 14,
    night: 8,
    /** They turn up this far from the view (m) and leave beyond `despawn`. */
    spawnMin: 35,
    spawnMax: 65,
    despawn: 90,
    /** A stroll: this far (m), at a walking pace (m/s), with a pause between (s). */
    stroll: [15, 45],
    walkPace: [1.1, 1.6],
    pause: [1, 5],
    /** Running off: this far (m), at a run (m/s); they calm down after `calm` s. */
    flee: [18, 32],
    runPace: [4.2, 5.4],
    calm: 6,
    /** Ghost Cody this close (m) sends them running; so does a car Cody drives at them this fast (m/s) from this close (m). */
    ghostReach: 6,
    carSpeed: 6,
    carReach: 7,
    /** A runner drops money this often: cash, or (walletShare of the time) a wallet. */
    dropChance: 0.45,
    walletShare: 0.3,
    /** Newcomers drive in and park in a lot stall within `bayReach` (m) of the view; after `stay` (s) they walk back to the car and drive off. */
    bayReach: 70,
    stay: [60, 180],
  },
  /** Cody's money: what he starts with, what drops are worth, how close he picks them up from (m), how long they lie around (s). */
  money: {
    start: 20,
    cash: [5, 25],
    wallet: [20, 80],
    reachFoot: 1.3,
    reachCar: 2.6,
    life: 45,
    /** Some cars have cash in the glovebox: this share of them, this much (Cody looks once per car). */
    glovebox: { chance: 0.35, amount: [10, 40] as [number, number] },
    /** Cash lying about town, this many bills of this much each, laid out afresh every sunrise (no higher than `upTo` m: street level). */
    found: { count: 24, amount: [5, 25] as [number, number], upTo: 0.6 },
  },
  /**
   * GhASt: ghosts the monster truck sucks in, burned for a boost. Ghosts within
   * `reach` (m) of its intake get pulled in; each fills `perGhost` of a tank
   * of 1. Holding boost burns `burn` a second for `push` times the truck's
   * acceleration on top of the pedal, and lifts its top speed by `top` (a share).
   */
  ghast: { reach: 7, perGhost: 0.2, burn: 0.3, push: 1.6, top: 0.45 },
  /** Car parts knocked off in smashes, lying about for Cody to pick up on foot. */
  junk: {
    /** A car-on-car hit changing a car's speed by more than this (m/s) knocks a part off it; another for every `perDv` more, up to `perHit`. */
    crashDv: 4,
    perDv: 4,
    perHit: 3,
    /** Parts one car has to lose in all, tires among them (no more of those than it has wheels). */
    perCar: 8,
    /** A car sheds again no sooner than this (s), so a grinding scrape isn't a shower of parts. */
    cooldown: 0.6,
    /** Share of shed parts that are tires. */
    tireShare: 0.35,
    /** Flattened by the monster truck: it loses this many at once. */
    crushed: 5,
    /** Thrown out from the hit at this speed (m/s) and up at this (m/s). */
    fling: [2.5, 5.5] as [number, number],
    up: [2.5, 4.5] as [number, number],
    /** Parts lie about this long (s); at most this many at once (the oldest goes). */
    life: 300,
    max: 40,
    /** Picked up walking within this (m). */
    reach: 1.2,
  },
  garage: { spots: 30 },
  /** Any vehicle at this speed (m/s) knocks a street lamp over. */
  knockdown: { speed: 7 },
  /** Foxy's valets: how they walk, talk and hand cars over. */
  valet: {
    /** Gap between valets waiting at the podium. */
    spacing: 1.2,
    walkPace: 2.6,
    jogPace: 4.2,
    /** Seconds to get in before driving off, and to ease the car into its spot. */
    boardTime: 0.5,
    settleTime: 0.8,
    /** Where a driver gets in and out: this far out from the body's side. */
    doorGap: 0.6,
    /** Talking: reach on foot and from the driver's seat, how far Cody can wander before it ends, how long the valet waits. */
    talkReach: { foot: 3.5, car: 4.5 },
    talkBreak: 6,
    talkTimeout: 8,
    /** Seconds a closing line stays up. */
    lineTime: 1.5,
    /** On foot, a valet takes the car Cody last got out of if it's this close. */
    carReach: 20,
    /** Only a car going slower than this can be handed over from the driver's seat. */
    handOverSpeed: 3,
    /**
     * From the second hand-over on, a valet asks for a tip `tipChance` of the
     * time: `tipBase`, times `tipGrowth` for every tip asked before. Paid, the
     * car goes to the top floor; not, it goes wherever there's room.
     */
    tipChance: 0.6,
    tipBase: 10,
    tipGrowth: 2,
    /** What it takes to turn round a valet who's walking back to the stand (to the top floor). */
    bribe: 40,
    /** A valet's car left on its side or roof after a crash gets righted after this long (s). */
    rightAfter: 2,
  },
  /** How AI drivers (the valets) drive. */
  autopilot: {
    cruise: 10,
    deckCruise: 6,
    /** Sideways grip it's happy to use in a bend, m/s^2: corner speed is sqrt(cornerGrip * radius). */
    cornerGrip: 3.5,
    /** Braking it plans to stop with at the end of a route, m/s^2. */
    stopDecel: 4,
    /** Done this close to the end of the route (then eased into the spot). */
    arrive: 2.5,
    /** No progress for `stall` seconds, `stalls` times over, means give up. */
    stall: 3,
    stalls: 3,
    /** A committed back-up (recovering): how long, at what throttle. */
    reverseTime: 0.9,
    reverseThrottle: -0.4,
    /** Speed for planned reverse legs (three-point turns), m/s. */
    reverseCruise: 2,
    /** Room kept beyond the body's sides (its radius) to a person or another car's middle (m). */
    keepOff: 0.65,
    /** Path tracking gains: heading error (rad per rad) and sideways offset. */
    kHeading: 1.1,
    kOffset: 0.9,
  },
  /** Elevators (world/elevators.ts). */
  elevator: {
    /** The cab's top speed (m/s) and how hard it speeds up and brakes (m/s^2). */
    speed: 5,
    accel: 4,
    /** Seconds the doors take to open or shut. */
    doorTime: 0.8,
    /** Seconds they stay open at a stop, and at least this long after someone leaves the doorway. */
    dwell: 3,
    hold: 1,
    /** After a floor's picked on the cab's panel, the doors shut this long after the last pick (s). */
    panelDelay: 1,
    /** Walkers walk on and off at this pace (m/s). */
    boardPace: 1.5,
    /** Cody can call the cab from this far from where you'd wait at a landing (m). */
    callReach: 1.8,
  },
  /**
   * Sound (src/audio/): `on` unless ?sound=0 (a bare ?sound also logs each sound by name to the
   * console as it starts); M mutes, and stays muted across reloads. `master` and the two buses' levels.
   * Distance is from Cody (his ride, or what a cutscene looks at): full level within `near` (m),
   * then near / distance, faded out to nothing by the cue's own range. Anything quieter than
   * `cull` isn't played. At most `voices` one-shots play at once (loops aside). Stereo follows
   * the camera, at most `pan` off centre. Each cue's own level, range and cap are in its row of
   * the cue table (src/audio/cues.ts).
   */
  audio: {
    on: true,
    master: 0.8,
    sfx: 1,
    ambience: 0.5,
    voices: 24,
    near: 6,
    cull: 0.015,
    pan: 0.6,
    /**
     * Engines: Cody's ride, and the `traffic` nearest running cars within `reach` (m), let go
     * past `leave`. Their state (src/audio/engine-state.ts): the revs (0 idle, 1 redline) go up
     * with road speed through `gears` (car, truck, bike), shifting up at `shift` of the redline
     * and down once the speed's `downshift` (a share) under the gear below's top. Pulling away
     * the clutch lets them rise to `launch` times the throttle. They move at most `rise` and
     * `fall` a second (a shift drops them in a blink), and the load follows the throttle `lag`
     * seconds behind.
     */
    engines: { traffic: 3, reach: 26, leave: 34, gears: { car: 4, truck: 3, bike: 5 }, shift: 0.88, downshift: 0.12, launch: 0.3, rise: 3, fall: 6, lag: 0.08 },
    /**
     * Hits by how hard (m/s of speed changed): a bump from `bump`, a crash from `crash`, a hard
     * one from `hard`; landing from the air at `land` or more. A vehicle sounds off again no
     * sooner than `again` (s), so grinding along a wall isn't a drum roll.
     */
    impact: { bump: 1.5, crash: 5, hard: 10, land: 7, again: 0.25 },
    /** Loops that come and go with distance (Randy's fire, the gate arms' motors): heard from `reach` (m), let go past `leave`. */
    nearby: { reach: 30, leave: 38 },
    /** Day and night ambience cross over this many game hours either side of sunrise and nightfall. */
    dusk: 0.5,
  },
} as const;

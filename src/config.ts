/** Shared gameplay and rendering settings; system-specific constants live in their modules. */

import type { VehicleParams } from './engine/physics/vehicle-params';

export const TUNING = {
  clock: {
    /** Game time in decimal hours: 7.5 is 07:30. */
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
     * Scale both camera views on small screens to keep objects legible. Below `shortSide` CSS pixels, multiply the
     * visible span by (short / shortSide)^power.
     */
    fit: { shortSide: 800, power: 0.6 },
    /**
     * Top-down world curvature, applied by render/curvature.ts. `radius` sets the planet size relative to the default
     * view height; smaller values create stronger curvature. `lean` blends between vertical buildings (0) and radial
     * buildings (1). `tile` is the maximum subdivision size in meters. `haze` controls fading near the horizon. The
     * curve URL flag overrides `on`.
     */
    curve: { on: true, radius: 8, lean: 0, tile: 5, haze: 0.25 },
    /** Chase-camera offsets: boom length and pivot height in meters, pitch in radians. */
    chase: {
      foot: { dist: 6, pivot: 1.5, pitch: 0.22 },
      car: { dist: 8.5, pivot: 1.3, pitch: 0.2 },
      truck: { dist: 11.5, pivot: 2.4, pitch: 0.22 },
      /** Field of view (degrees) across the screen's short side. */
      fov: 60,
      /** Maximum horizontal field of view in degrees. Wider screens reduce vertical coverage. */
      maxHFov: 92,
      /** Additional field of view in degrees at top speed. */
      fovBoost: 10,
      /** Q/E look-around speed, radians per second. */
      orbitRate: 2.4,
      /** Mouse sensitivity in radians per pixel, pitch limits in radians, and recenter delay in seconds. */
      mouseSens: 0.0025,
      pitchMin: -0.12,
      pitchMax: 1.2,
      recenterDelay: 1.5,
      /** Camera clearance from walls and slabs, in meters. */
      pad: 0.35,
      /** Chase-camera fog start and end distances, in meters. */
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
    // Match the sedan model dimensions after applying SEDAN_SCALE.
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
   * Keep the pickup and motorcycle within the sedan's length, radius, and minimum turning radius: wheelBase /
   * tan(maxSteer) <= 4.04 m. AI routes are planned using sedan dimensions.
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
     * Driver fear thresholds: detection distance and clearance in meters, panic duration in seconds, and panic speed
     * multiplier. A driver below `stuckSpeed` m/s for `stuckTime` seconds abandons the car.
     */
    panicReach: 8,
    berth: 3.5,
    panicTime: 5,
    panicBoost: 1.8,
    stuckSpeed: 1,
    stuckTime: 1.5,
    /**
     * Limits for routing frightened drivers into the deck. The entry gate must be within `divertGate` meters of the
     * lane and at most `divertReach` meters ahead, with `divertRoom` meters to begin the turn. Limit concurrent
     * diversions to `divertMax`; abandon planning after `divertWait` seconds.
     */
    divertReach: 20,
    divertRoom: 4,
    divertGate: 12,
    divertMax: 2,
    divertWait: 6,
    /** Seconds a diverted driver waits in a parked car while outside phantom Cody's sight. */
    divertRest: 4,
    /**
     * Driver anger ranges from 0 to 1. It rises while stopped below `speed` m/s, faster behind an obstruction than in
     * traffic. `honkedAt` is an immediate increase; other rise and calm values are rates per second. Pairs interpolate
     * between calm and angry values.
     *
     * `room` and `gap` set stopping distances in meters. Drivers honk above `honkAt`, repeating every `again` seconds.
     * Overtaking starts after `pullAfter` seconds, with `queueJump` required for passing queued traffic.
     *
     * A detour must rejoin at least `past` meters beyond the obstacle with `clear` meters of space, within `reach`
     * meters along the lane. `detour` limits route length; `squeeze` sets obstacle clearance. Limit concurrent detours
     * to `max`, planning to `planWait` seconds, and waiting for oncoming traffic within `oncoming` meters to `gapWait`
     * seconds.
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
  /** Shared visual effects for running vehicles. */
  vehicle: {
    /**
     * Engine vibration amplitudes: vertical displacement in meters and roll/pitch in radians, at `hz` cycles per
     * second. Frequency varies by `spread` between vehicles. Vibration falls to the `moving` fraction by `fade` m/s;
     * each vehicle breed supplies additional size and rate multipliers.
     */
    idleShake: {
      lift: 0.01,
      roll: 0.0055,
      pitch: 0.003,
      hz: 13,
      spread: 0.15,
      moving: 0.35,
      fade: 8,
    },
    /**
     * Exhaust for a fixed `share` of ordinary cars. Emit up to `burst` puffs, `every` seconds apart, while accelerating
     * above `accel` m/s² and below `upTo` m/s. Puff size is in meters and lifetime in seconds; unlit colors interpolate
     * from day to night.
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
  /** Pedestrian population, movement, fear, and visitor settings. */
  crowd: {
    /** Target pedestrian counts near the active view. */
    day: 14,
    night: 8,
    /** Spawn distance range and removal distance from the active view, in meters. */
    spawnMin: 35,
    spawnMax: 65,
    despawn: 90,
    /** Walking route length in meters, speed in m/s, and pause duration in seconds. */
    stroll: [15, 45],
    walkPace: [1.1, 1.6],
    pause: [1, 5],
    /** Escape route length in meters, running speed in m/s, and calm-down delay in seconds. */
    flee: [18, 32],
    runPace: [4.2, 5.4],
    calm: 6,
    /** Fear detection range in meters. An approaching player vehicle must also exceed `carSpeed` m/s. */
    ghostReach: 6,
    carSpeed: 6,
    carReach: 7,
    /** Chance of dropping money when frightened, and the fraction of drops that are wallets. */
    dropChance: 0.45,
    walletShare: 0.3,
    /** Maximum parking distance from the active view in meters, and visitor stay duration in seconds. */
    bayReach: 70,
    stay: [60, 180],
  },
  /** Starting cash, drop values, collection radii in meters, and drop lifetime in seconds. */
  money: {
    start: 20,
    cash: [5, 25],
    wallet: [20, 80],
    reachFoot: 1.3,
    reachCar: 2.6,
    life: 45,
    /** Chance and value range of glovebox cash. Each car is searched only once. */
    glovebox: { chance: 0.35, amount: [10, 40] as [number, number] },
    /** Daily cash pickups: count, value range, and maximum placement height in meters. Regenerated at sunrise. */
    found: { count: 24, amount: [5, 25] as [number, number], upTo: 0.6 },
  },
  /**
   * Monster-truck fuel and boost settings. Each ghost within `reach` meters adds `perGhost` to a tank capped at 1.
   * Boost consumes `burn` units per second, adds `push` times normal acceleration, and raises top speed by the `top`
   * fraction.
   */
  ghast: { reach: 7, perGhost: 0.2, burn: 0.3, push: 1.6, top: 0.45 },
  /** Collectible parts released by vehicle impacts. */
  junk: {
    /**
     * Minimum collision speed change in m/s for shedding a part. Each additional `perDv` adds another, capped by
     * `perHit`.
     */
    crashDv: 4,
    perDv: 4,
    perHit: 3,
    /** Total parts available per car. Tire drops are additionally limited by wheel count. */
    perCar: 8,
    /** Minimum seconds between part drops, preventing continuous scrapes from shedding every frame. */
    cooldown: 0.6,
    /** Share of shed parts that are tires. */
    tireShare: 0.35,
    /** Number of parts released when a monster truck crushes a car. */
    crushed: 5,
    /** Horizontal and vertical launch-speed ranges, in m/s. */
    fling: [2.5, 5.5] as [number, number],
    up: [2.5, 4.5] as [number, number],
    /** Part lifetime in seconds and pool capacity. Reuse the oldest slot when full. */
    life: 300,
    max: 40,
    /** Collection radius for Cody on foot, in meters. */
    reach: 1.2,
  },
  garage: { spots: 30 },
  /** Minimum vehicle speed in m/s for knocking down a street lamp. */
  knockdown: { speed: 7 },
  /** Valet movement, conversation, payment, and recovery settings. */
  valet: {
    /** Spacing between valets at the podium, in meters. */
    spacing: 1.2,
    walkPace: 2.6,
    jogPace: 4.2,
    /** Seconds to get in before driving off, and to ease the car into its spot. */
    boardTime: 0.5,
    settleTime: 0.8,
    /** Offset from the vehicle body to the driver's door position, in meters. */
    doorGap: 0.6,
    /** Conversation ranges in meters and timeout in seconds. End a conversation if Cody moves beyond `talkBreak`. */
    talkReach: { foot: 3.5, car: 4.5 },
    talkBreak: 6,
    talkTimeout: 8,
    /** Duration of a conversation's closing line, in seconds. */
    lineTime: 1.5,
    /** Maximum distance in meters to offer Cody's last driven car while he is on foot. */
    carReach: 20,
    /** Maximum vehicle speed in m/s for handing over the keys from the driver's seat. */
    handOverSpeed: 3,
    /**
     * Tip requests begin after the first handoff, with probability `tipChance`. The amount is `tipBase` multiplied by
     * `tipGrowth` for each previous request. Paying selects the top floor.
     */
    tipChance: 0.6,
    tipBase: 10,
    tipGrowth: 2,
    /** Cost to redirect a returning valet to move the parked car to the top floor. */
    bribe: 40,
    /** Seconds before an overturned valet vehicle is righted. */
    rightAfter: 2,
  },
  /** Route-following speeds, clearances, steering gains, and recovery limits. */
  autopilot: {
    cruise: 10,
    deckCruise: 6,
    /** Lateral acceleration limit in m/s². Corner speed is sqrt(cornerGrip * radius). */
    cornerGrip: 3.5,
    /** Planned deceleration at the end of a route, in m/s². */
    stopDecel: 4,
    /** Distance in meters at which route following hands over to final parking alignment. */
    arrive: 2.5,
    /** Declare a stall after `stall` seconds without progress; give up after `stalls` failures. */
    stall: 3,
    stalls: 3,
    /** Duration in seconds and throttle for a reverse recovery maneuver. */
    reverseTime: 0.9,
    reverseThrottle: -0.4,
    /** Speed for planned reverse legs (three-point turns), m/s. */
    reverseCruise: 2,
    /** Additional body clearance from pedestrians and other vehicle centers, in meters. */
    keepOff: 0.65,
    /** Path tracking gains: heading error (rad per rad) and sideways offset. */
    kHeading: 1.1,
    kOffset: 0.9,
  },
  /** Elevators (world/elevators.ts). */
  elevator: {
    /** Elevator top speed in m/s and acceleration/deceleration in m/s². */
    speed: 5,
    accel: 4,
    /** Seconds the doors take to open or shut. */
    doorTime: 0.8,
    /** Door dwell time at a stop and minimum hold time after the doorway clears, in seconds. */
    dwell: 3,
    hold: 1,
    /** Delay in seconds between the last floor selection and closing the doors. */
    panelDelay: 1,
    /** Walking speed while boarding or leaving an elevator, in m/s. */
    boardPace: 1.5,
    /** Maximum distance from an elevator landing's waiting point to call the cab, in meters. */
    callReach: 1.8,
  },
  /**
   * Audio bus gains and spatial limits. One-shots are capped by `voices` and discarded below `cull` gain. Distance
   * attenuation uses `near` meters as its reference; `pan` limits stereo separation. Individual cue gains, ranges, and
   * caps are defined in audio/cues.ts.
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
     * Play the player engine and up to `traffic` nearby engines. Start traffic audio within `reach` meters and retain
     * it until `leave`.
     *
     * Audio RPM follows vehicle speed through simulated gears. `shift` sets the RPM at each gear's speed limit;
     * `downshift` adds speed hysteresis. `launch` allows revving at low speed. `rise` and `fall` limit normalized RPM
     * change per second; `lag` is the load smoothing time constant in seconds.
     */
    engines: {
      traffic: 3,
      reach: 26,
      leave: 34,
      shift: 0.88,
      downshift: 0.12,
      launch: 0.3,
      rise: 3,
      fall: 6,
      lag: 0.08,
    },
    /**
     * Collision speed-change thresholds in m/s for bumps, crashes, severe crashes, and landings. `again` is the minimum
     * delay in seconds between impact sounds from one vehicle.
     */
    impact: { bump: 1.5, crash: 5, hard: 10, land: 7, again: 0.25 },
    /** Activation range for fire and gate loops, in meters. Fire loops use `leave` as a separate exit threshold. */
    nearby: { reach: 30, leave: 38 },
    /** Day and night ambience cross over this many game hours either side of sunrise and nightfall. */
    dusk: 0.5,
  },
} as const;

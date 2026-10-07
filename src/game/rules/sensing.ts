import type { Vector3 } from 'three';

import { Avoidance, PERSON_RADIUS } from '@/actors/avoidance';
import type { Npcs } from '@/actors/npcs/npcs';
import type { Player } from '@/actors/player';
import type { Skeletons } from '@/actors/skeletons/skeletons';
import type { Obstacle } from '@/actors/vehicles/autopilot';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import { TUNING } from '@/config';
import type { CollisionWorld } from '@/engine/physics/collision';
import { Space } from '@/engine/sim/space';
import type { CodyRide } from '@/game/cody/cody-ride';
import type { CodyState } from '@/game/cody/cody-state';
import type { Crowd } from '@/game/town/crowd';
import type { ValetService } from '@/game/valets/valet';

import { Bodies } from './bodies';
import { LEVEL } from './reach';
import { EYE_HEIGHT, type Perception, type Thing } from './reactions';

/** Obstacle radii for Randy and his fire, in meters. */
const NPC_ROOM = 0.4;
const FIRE_ROOM = 0.45;

type Actors = {
  cody: CodyState;
  player: Player;
  crowd: Crowd;
  valet: ValetService;
  npcs: Npcs;
  skeletons: Skeletons;
  vehicles: readonly Vehicle[];
  driven(vehicle: Vehicle): boolean;
};

/** Perception and movement queries share the actors collected before movement. */
export class ActorSensing implements Perception {
  readonly space = new Space<Thing>(8, LEVEL.person);
  readonly things: Thing[] = [];
  readonly avoid = new Avoidance();
  readonly driverObstacles: Obstacle[] = [];
  private readonly bodies = new Bodies();
  private readonly trafficPoints: Vector3[] = [];
  private readonly blockers: { pos: Vector3; r: number }[] = [];

  constructor(
    private readonly actors: Actors,
    private readonly collision: CollisionWorld,
  ) {}

  readonly sees = (a: Thing, b: Thing): boolean =>
    !this.collision.segmentBlocked(eyeOf(a), eyeOf(b), true);

  /** Rebuild perception entries and obstacle bodies before movement. */
  scan(ride: Pick<CodyRide, 'driving' | 'transform' | 'onFoot'>): void {
    const { driving, transform, onFoot } = ride;
    const { cody, skeletons, crowd, vehicles, driven } = this.actors;
    const things = this.things;
    things.length = 0;
    const seen = cody.presence(driving, !!transform);
    if (seen?.kind === 'phantom') {
      things.push({ kind: 'phantom', pos: seen.at });
    } else if (seen?.kind === 'phantomTruck' && driving) {
      things.push({
        kind: 'phantomTruck',
        pos: seen.at,
        vehicle: driving,
      });
    }

    for (const pos of skeletons.threats) {
      things.push({ kind: 'skeleton', pos });
    }

    for (const person of crowd.living()) {
      things.push({ kind: 'townsperson', pos: person.walker.pos, person });
    }

    for (const vehicle of vehicles) {
      if (driven(vehicle) && !vehicle.crashing) {
        things.push({ kind: 'driver', pos: vehicle.pos, vehicle });
      }
    }

    this.space.rebuild(things);
    this.senseBodies(onFoot);
  }

  /** Collect current bodies from each actor system. */
  private senseBodies(onFoot: boolean): void {
    const { crowd, valet, npcs, skeletons, player, vehicles } = this.actors;
    const b = this.bodies;
    b.clear();
    crowd.addBodies(b);
    valet.addBodies(b);

    for (const n of npcs.list) {
      b.add({ kind: 'still', pos: n.pos, r: NPC_ROOM });

      if (n.fire) {
        b.add({ kind: 'still', pos: n.fire.root.position, r: FIRE_ROOM });
      }
    }

    // Walkers avoid skeletons; vehicles do not brake for them.
    for (const pos of skeletons.threats) {
      b.add({ kind: 'skeleton', pos, r: PERSON_RADIUS });
    }

    if (onFoot && player.visible) {
      b.add({
        kind: 'cody',
        pos: player.pos,
        vel: player.vel,
        r: TUNING.player.radius,
      });
    }

    for (const v of vehicles) {
      if (!v.gone) {
        b.add({
          kind: 'car',
          pos: v.pos,
          vel: v.vel,
          r: v.params.radius,
          vehicle: v,
        });
      }
    }
  }

  /** Translate registered bodies into pedestrian avoidance inputs. */
  updateAvoidance(): void {
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

  /** Traffic brakes for Cody, moving pedestrians, and fallen bodies. */
  trafficObstacles(): Vector3[] {
    return this.bodies.points(
      (b) =>
        b.kind === 'cody' ||
        b.kind === 'down' ||
        (b.kind === 'person' && b.moving),
      this.trafficPoints,
    );
  }

  /** Refresh AI braking obstacles after movement, including vehicle bodies. */
  updateDriverObstacles(): Obstacle[] {
    return this.bodies.obstacles(
      (b) =>
        b.kind === 'car' ||
        b.kind === 'cody' ||
        b.kind === 'down' ||
        (b.kind === 'person' && b.moving),
      this.driverObstacles,
    );
  }

  playerBlockers(): { pos: Vector3; r: number }[] {
    const blockers = this.blockers;
    let n = 0;
    for (const v of this.actors.vehicles) {
      if (v.gone) {
        continue;
      }

      const b = (blockers[n++] ??= { pos: v.pos, r: 0 });
      b.pos = v.pos;
      b.r = v.params.length * 0.42;
    }

    // Scripts can move NPCs and their fires after the frame's initial scan.
    for (const npc of this.actors.npcs.list) {
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
    return blockers;
  }
}

/**
 * Return the actor’s world-space sight point using its configured eye-height
 * offset.
 */
function eyeOf(thing: Thing): [number, number, number] {
  return [thing.pos.x, thing.pos.y + EYE_HEIGHT[thing.kind], thing.pos.z];
}

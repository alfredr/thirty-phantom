import { Group, PointLight, type Vector3 } from 'three';
import { clamp } from '../core/math';
import type { LightEmitter } from '../world/build-world';

/** How far each kind of lamp's light reaches (m). */
const RANGE: Readonly<Record<LightEmitter['kind'], number>> = { street: 16, ceiling: 11, flood: 30 };

interface Scored {
  e: LightEmitter;
  /** Squared distance to the focus, Infinity for a dead lamp. */
  d: number;
}

const nearestFirst = (a: Scored, b: Scored): number => a.d - b.d;

/**
 * A fixed number of real point lights reassigned every frame to the emitters
 * nearest the camera focus. Keeps shader light count constant (no recompiles)
 * while lamps near the action still light vehicles and characters.
 * Intensities fade toward the cut-off so lights never pop.
 */
export class LightPool {
  readonly root = new Group();
  private readonly lights: PointLight[] = [];
  private readonly scored: Scored[];
  level = 1;

  constructor(emitters: LightEmitter[], count = 6) {
    for (let i = 0; i < count; i++) {
      const l = new PointLight(0xffffff, 0, RANGE.street, 1.6);
      l.castShadow = false;
      this.lights.push(l);
      this.root.add(l);
    }
    this.scored = emitters.map((e) => ({ e, d: 0 }));
  }

  update(focus: Vector3): void {
    // dead lamps (knocked over) never take a light
    for (const s of this.scored) s.d = s.e.strength > 0 ? s.e.pos.distanceToSquared(focus) : Infinity;
    this.scored.sort(nearestFirst);
    const n = this.lights.length;
    const cutoff = Math.sqrt(Math.min(this.scored[n]?.d ?? 1e6, 1e6));
    for (let i = 0; i < n; i++) {
      const l = this.lights[i] as PointLight;
      const s = this.scored[i];
      if (!s || s.d === Infinity || this.level <= 0.01) {
        l.intensity = 0;
        continue;
      }
      const d = Math.sqrt(s.d);
      const fade = clamp((cutoff - d) / Math.max(4, cutoff * 0.25), 0, 1);
      l.position.copy(s.e.pos);
      l.color.copy(s.e.color);
      l.distance = RANGE[s.e.kind];
      l.intensity = 60 * s.e.strength * fade * this.level;
    }
  }
}

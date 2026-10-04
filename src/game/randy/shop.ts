import type { Vector3 } from 'three';
import type { Npc, Npcs } from './npcs';

/** Cody on foot this close to Randy (m, on his level) while he's pitching is at his wares. */
const SHOP_REACH = 2.8;
const SHOP_LEVEL = 2;

/**
 * Randy's shop: an encounter between Cody and Randy, open from when Cody's on
 * foot by him while he's pitching (his coat open on his wares) until Cody
 * walks off or a scene takes Randy. Randy is sent browse and browseEnded, and
 * keeps his coat open while it lasts; the game shows the wares menu, whose
 * keys buy.
 */
export class Shop {
  /** Whose wares Cody's at, if anyone's. */
  private at: Npc | null = null;

  constructor(private readonly npcs: Npcs) {}

  /** `cody`: where Cody is on foot, or null. Returns whose wares he's at now, if anyone's. */
  update(cody: Vector3 | null): Npc | null {
    const at = this.at;
    if (at && !(cody && within(at, cody) && at.pitch.in('browsing'))) {
      // he's walked off: Randy can shut his coat (a scene that took Randy has seen to that already)
      at.send({ type: 'browseEnded' });
      this.at = null;
    }
    if (!this.at && cody) {
      for (const n of this.npcs.list) {
        if (!n.fire || !n.pitch.in('pitching') || !within(n, cody)) continue;
        n.send({ type: 'browse' });
        this.at = n;
        break;
      }
    }
    return this.at;
  }
}

function within(n: Npc, cody: Vector3): boolean {
  return Math.hypot(n.pos.x - cody.x, n.pos.z - cody.z) < SHOP_REACH && Math.abs(n.pos.y - cody.y) < SHOP_LEVEL;
}

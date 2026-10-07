import type { Vector3 } from 'three';

import type { Player } from '@/actors/player';
import type { Emitter } from '@/engine/core/events';
import type { GameClock } from '@/game/game-clock';
import type { GameEffects } from '@/game/game-effects';
import type { GameEvents } from '@/game/game-events';

/** Change Cody's form at the end of the smoke, then finish the reveal. */
export class CodyTransformation {
  private elapsed = -1;

  constructor(
    private readonly player: Player,
    private readonly clock: GameClock,
    private readonly events: Pick<Emitter<GameEvents>, 'emit'>,
    private readonly effects: Pick<GameEffects, 'codySmoke' | 'codyChanged'>,
  ) {}

  start(): void {
    this.elapsed = 0;
  }

  update(dt: number, at: Vector3): void {
    if (this.elapsed < 0) {
      return;
    }

    const before = this.elapsed;
    if (before === 0) {
      this.events.emit('outfit', { form: this.clock.phase, at: at.clone() });
    }

    this.elapsed += dt;

    if (before < 0.6) {
      this.effects.codySmoke(at);
    }

    if (before < 0.6 && this.elapsed >= 0.6) {
      this.player.setForm(this.clock.phase);
      this.effects.codyChanged(at, this.clock.phase);
    }

    if (this.elapsed > 1) {
      this.elapsed = -1;
    }
  }
}

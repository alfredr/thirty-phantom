import { el } from '@/engine/ui/dom';
import { GameClock } from '@/game/game-clock';

export interface GameTime {
  hours: number;
  day: number;
}

export interface Stamp extends GameTime {
  wall: Date;
}

const WALL = import.meta.env.DEV;

export const stampAt = (t: GameTime): Stamp => ({ hours: t.hours, day: t.day, wall: new Date() });

export const dayLabel = (t: GameTime): string => `${GameClock.phaseAt(t.hours) === 'day' ? 'DAY' : 'NIGHT'} ${t.day}`;

const two = (n: number): string => String(n).padStart(2, '0');

export function stampText(s: Stamp): string {
  const game = GameClock.format(s.hours);
  if (!WALL) {
    return game;
  }

  const w = s.wall;
  return `${game}<i class="wall">${two(w.getHours())}:${two(w.getMinutes())}:${two(w.getSeconds())}</i>`;
}

export class DayGroups {
  private last = '';

  constructor(private readonly root: HTMLElement) {}

  mark(t: GameTime): void {
    const label = dayLabel(t);
    if (label === this.last) {
      return;
    }

    this.last = label;
    el('div', 'phone-day', this.root, label);
  }
}

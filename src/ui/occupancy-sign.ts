import { clamp } from '@/engine/core/math';
import { el } from '@/engine/ui/dom';

/** Display logged, actual, and phantom occupancy beside the clock, with one visual cell per parking space. */
export class OccupancySign {
  readonly root: HTMLDivElement;
  private readonly score: HTMLElement;
  private readonly of: HTMLElement;
  private readonly window: HTMLElement;
  private readonly stalls: HTMLElement;
  private readonly logged: HTMLElement;
  private readonly actual: HTMLElement;
  private last = { logged: -1, actual: -1, phantom: -1, max: -1 };

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud-sign drip', parent);
    this.window = el('div', 'sign-window', this.root);
    this.score = el('span', 'sign-score slime-text', this.window, '0');
    this.of = el('span', 'sign-of', this.window, '/30');
    const body = el('div', 'sign-body', this.root);
    el('div', 'sign-label', body, 'PHANTOM OCCUPANCY');
    this.stalls = el('div', 'sign-stalls', body);
    const foot = el('div', 'sign-foot', body);
    this.logged = el('b', '', el('span', '', foot, 'BADGE LOG '), '0');
    this.actual = el('b', '', el('span', 'in-deck', foot, 'IN DECK '), '0');
  }

  set(logged: number, actual: number, phantom: number, max: number): void {
    const last = this.last;
    if (logged === last.logged && actual === last.actual && phantom === last.phantom && max === last.max) {
      return;
    }

    this.logged.textContent = String(logged);
    this.actual.textContent = String(actual);
    this.score.textContent = String(phantom);
    this.of.textContent = `/${max}`;

    if (max !== last.max) {
      this.stalls.replaceChildren(...Array.from({ length: max }, () => el('i')));
      this.stalls.style.gridTemplateColumns = `repeat(${Math.ceil(max / 2)}, 1fr)`;
    }

    // Draw phantoms before actual cars so an escape visibly changes a car cell into a ghost.
    const ghosts = clamp(phantom, 0, max);
    const cars = clamp(actual, 0, max - ghosts);
    const cells = [...this.stalls.children];
    cells.forEach((c, i) => (c.className = i < ghosts ? 'ghost' : i < ghosts + cars ? 'car' : ''));

    if (last.phantom >= 0 && phantom > last.phantom) {
      cells[ghosts - 1]?.classList.add('new');
      this.window.classList.remove('bump');
      void this.window.offsetWidth;
      this.window.classList.add('bump');
    }

    this.last = { logged, actual, phantom, max };
  }
}

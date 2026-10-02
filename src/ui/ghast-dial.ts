import { el, polar, svg } from './dom';

/** Degrees either side of 12 o'clock the needle swings, E to F. */
const SWEEP = 62;
/** A rise this big in one update is a ghost going in: the dial gulps. */
const GULP = 0.01;

/**
 * The monster truck's ghost tank, beside the speedometer: a fuel gauge from E to F labelled
 * GhASt (GAS with the ghost tucked in, its h and t small and dropped). It flares while the
 * boost burns, gulps when a ghost goes in, and glows when full.
 */
export class GhastDial {
  readonly root: HTMLDivElement;
  private readonly fill: SVGPathElement;
  private readonly needle: SVGGElement;
  private last = -1;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ghast plate', parent);
    const s = svg('svg', { viewBox: '-50 -50 100 100', class: 'ghast-svg' }, this.root);
    const [ax, ay] = polar(-SWEEP, 36);
    const [bx, by] = polar(SWEEP, 36);
    const arc = `M${ax} ${ay}A36 36 0 0 1 ${bx} ${by}`;
    svg('path', { d: arc, pathLength: 100, class: 'ghast-track' }, s);
    this.fill = svg('path', { d: arc, pathLength: 100, class: 'ghast-fill' }, s);
    for (let i = 0; i <= 4; i++) {
      const deg = -SWEEP + (i / 4) * SWEEP * 2;
      const [x1, y1] = polar(deg, i % 2 ? 26.5 : 24);
      const [x2, y2] = polar(deg, 29.5);
      svg('line', { x1, y1, x2, y2, class: i % 2 ? 'ghast-tick' : 'ghast-tick major' }, s);
    }
    for (const [deg, mark] of [[-SWEEP, 'E'], [SWEEP, 'F']] as const) {
      const [x, y] = polar(deg, 17);
      svg('text', { x, y, class: 'ghast-mark' }, s).textContent = mark;
    }
    this.needle = svg('g', { class: 'ghast-needle' }, s);
    svg('line', { x1: 0, y1: 5, x2: 0, y2: -31 }, this.needle);
    svg('circle', { r: 4.5, class: 'ghast-hub' }, s);
    el('div', 'ghast-label', this.root, 'G<small>h</small>AS<small>t</small>');
    this.root.addEventListener('animationend', () => this.root.classList.remove('gulp'));
  }

  /** Tank level 0..1 and whether the boost is burning it. */
  set(fill: number, burning: boolean): void {
    const f = Math.min(1, Math.max(0, fill));
    const r = this.root.classList;
    if (this.last >= 0 && f - this.last >= GULP && !r.contains('gulp')) r.add('gulp');
    r.toggle('burn', burning && f > 0);
    r.toggle('full', f >= 0.999);
    if (Math.abs(f - this.last) < 0.002) return;
    this.last = f;
    this.fill.style.strokeDashoffset = String(100 - f * 100);
    this.needle.style.transform = `rotate(${-SWEEP + f * SWEEP * 2}deg)`;
  }

  /** Forget the last level, so the next set() doesn't gulp for a tank refilled out of sight. */
  reset(): void {
    this.last = -1;
  }
}

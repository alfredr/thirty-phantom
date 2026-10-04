import { el, polar, svg } from '@/engine/ui/dom';

const GAUGE_MAX_MPH = 80;
/** Degrees either side of 12 o'clock; the open bottom holds the dashboard clock. */
const GAUGE_SWEEP = 125;

/** Dashboard speedometer: 0-80 mph arc, digital readout, and the dash clock. */
export class SpeedGauge {
  readonly root: HTMLDivElement;
  readonly time: HTMLElement;
  private readonly fill: SVGPathElement;
  private readonly mph: HTMLElement;
  private lastMph = -1;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'gauge plate', parent);
    const s = svg('svg', { viewBox: '-60 -60 120 120', class: 'gauge-svg' }, this.root);
    const [ax, ay] = polar(-GAUGE_SWEEP, 46);
    const [bx, by] = polar(GAUGE_SWEEP, 46);
    const arc = `M${ax} ${ay}A46 46 0 1 1 ${bx} ${by}`;
    svg('path', { d: arc, pathLength: 100, class: 'gauge-track' }, s);
    this.fill = svg('path', { d: arc, pathLength: 100, class: 'gauge-fill' }, s);
    for (let v = 0; v <= GAUGE_MAX_MPH; v += 10) {
      const deg = -GAUGE_SWEEP + (v / GAUGE_MAX_MPH) * GAUGE_SWEEP * 2;
      const major = v % 20 === 0;
      const [x1, y1] = polar(deg, major ? 35 : 37.5);
      const [x2, y2] = polar(deg, 40.5);
      svg('line', { x1, y1, x2, y2, class: major ? 'gauge-tick major' : 'gauge-tick' }, s);
      if (major) {
        const [tx, ty] = polar(deg, 28.5);
        svg('text', { x: tx, y: ty, class: 'gauge-num' }, s).textContent = String(v);
      }
    }
    const read = el('div', 'gauge-read', this.root);
    this.mph = el('div', 'gauge-mph', read, '0');
    el('div', 'gauge-unit', read, 'MPH');
    this.time = el('div', 'gauge-time', this.root, '');
    el('div', 'gauge-air', this.root, 'AIRBORNE');
  }

  set(mph: number): void {
    if (mph === this.lastMph) return;
    this.lastMph = mph;
    this.mph.textContent = String(mph);
    this.fill.style.strokeDashoffset = String(100 - Math.min(1, mph / GAUGE_MAX_MPH) * 100);
  }
}

import { polar, svg } from '@/engine/ui/dom';

/**
 * Analog clock face (SVG) with live hands. Colors come from CSS so the dial
 * follows the phase.
 */
export class ClockFace {
  readonly svg: SVGSVGElement;
  private readonly hour: SVGLineElement;
  private readonly minute: SVGLineElement;

  constructor() {
    const s = svg('svg', { viewBox: '-50 -50 100 100', class: 'dial' });
    svg('circle', { r: 45, class: 'dial-face' }, s);

    for (let i = 0; i < 12; i++) {
      const major = i % 3 === 0;
      const [x1, y1] = polar(i * 30, major ? 29 : 34);
      const [x2, y2] = polar(i * 30, 39);
      svg(
        'line',
        { x1, y1, x2, y2, class: major ? 'dial-tick major' : 'dial-tick' },
        s,
      );
    }

    this.hour = svg(
      'line',
      { x1: 0, y1: 6, x2: 0, y2: -21, class: 'dial-hour' },
      s,
    );
    this.minute = svg(
      'line',
      { x1: 0, y1: 6, x2: 0, y2: -33, class: 'dial-minute' },
      s,
    );
    svg('circle', { r: 4, class: 'dial-hub' }, s);
    this.svg = s;
  }

  set(hours: number): void {
    this.minute.setAttribute('transform', `rotate(${(hours % 1) * 360})`);
    this.hour.setAttribute(
      'transform',
      `rotate(${((hours % 12) / 12) * 360})`,
    );
  }
}

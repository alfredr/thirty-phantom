import { type Camera, Vector3 } from 'three';
import { el } from '../engine/ui/dom';
import type { Objective } from '../game/story/objectives';

/** How high over its target a marker hangs (m). */
const LIFT = 2.4;
/** Keep-outs for edge arrows (CSS px): under the clock plate, clear of the sides, the dash and the touch buttons. */
const INSETS = { top: 108, right: 44, bottom: 44, left: 44 };
const TOUCH_INSETS = { top: 84, right: 130, bottom: 34, left: 40 };
/** Edge labels sit this far in from the screen edge, past their arrow (px). */
const LABEL_IN = 36;

const _p = new Vector3();
const _c = new Vector3();

/**
 * Objective markers (game/story/objectives.ts): a chevron over each target, big and slime for the
 * primary, small and lilac for optional ones. Off screen, or behind the camera, the chevron sits
 * on the screen's edge pointing the way, with the distance.
 */
export class ObjectiveMarks {
  readonly root: HTMLDivElement;
  private readonly marks = new Map<string, { el: HTMLDivElement; label: HTMLElement; dist: HTMLElement; text: string }>();

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud-marks', parent);
  }

  /** Place this frame's markers. `project` maps a world point to the screen (null behind the camera); `from` is Cody, for distances. */
  update(list: readonly Objective[], cam: Camera, project: (p: Vector3) => { x: number; y: number } | null, from: Vector3): void {
    const seen = new Set<string>();
    const touch = document.body.classList.contains('touch');
    const inset = touch ? TOUCH_INSETS : INSETS;
    const w = window.innerWidth;
    const h = window.innerHeight;
    cam.updateMatrixWorld();
    for (const o of list) {
      seen.add(o.id);
      const m = this.mark(o);
      _p.copy(o.at).setY(o.at.y + LIFT);
      const at = place(_p, cam, project, w, h, inset);
      const edge = at.angle !== null;
      m.el.classList.toggle('edge', edge);
      m.el.style.translate = `${at.x.toFixed(1)}px ${at.y.toFixed(1)}px`;
      // on target the chevron points down at it; on the edge, the way to go
      if (at.angle !== null) {
        // the label goes inward of the arrow: right-aligned on the right edge, under it on the top...
        const cos = Math.cos(at.angle);
        const sin = Math.sin(at.angle);
        const s = m.el.style;
        s.setProperty('--turn', `${at.angle - Math.PI / 2}rad`);
        s.setProperty('--tx', `calc(${(-(1 + cos) / 2) * 100}% + ${-cos * LABEL_IN}px)`);
        s.setProperty('--ty', `calc(${(-(1 + sin) / 2) * 100}% + ${-sin * LABEL_IN}px)`);
      } else for (const v of ['--turn', '--tx', '--ty']) m.el.style.removeProperty(v);
      const d = `${Math.round(o.at.distanceTo(from))} M`;
      if (m.dist.textContent !== d) m.dist.textContent = d;
    }
    for (const [id, m] of this.marks) {
      if (seen.has(id)) continue;
      m.el.remove();
      this.marks.delete(id);
    }
  }

  private mark(o: Objective): { el: HTMLDivElement; label: HTMLElement; dist: HTMLElement; text: string } {
    const text = o.kind === 'optional' ? `${o.label} <small>(OPTIONAL)</small>` : o.label;
    let m = this.marks.get(o.id);
    if (!m) {
      const root = el('div', 'mark', this.root);
      el('div', 'mark-arrow', root, '<svg viewBox="-12 -10 24 20"><path d="M-10-8h7l3 5 3-5h7L0 9z"/></svg>');
      const tag = el('div', 'mark-tag', root);
      m = { el: root, label: el('div', 'mark-label', tag), dist: el('div', 'mark-dist', tag), text: '' };
      this.marks.set(o.id, m);
    }
    m.el.className = `mark ${o.kind}${m.el.classList.contains('edge') ? ' edge' : ''}`;
    if (m.text !== text) {
      m.text = text;
      m.label.innerHTML = text;
    }
    return m;
  }
}

/**
 * Where a marker for world point `p` goes: on the target if `project` puts it inside the insets,
 * else on the inset edge toward the target. Camera space gives that direction alike for a point off
 * to the side and one behind the camera (which projection would mirror).
 */
function place(
  p: Vector3,
  cam: Camera,
  project: (p: Vector3) => { x: number; y: number } | null,
  w: number,
  h: number,
  inset: typeof INSETS,
): { x: number; y: number; angle: number | null } {
  const s = project(p);
  if (s && s.x >= inset.left && s.x <= w - inset.right && s.y >= inset.top && s.y <= h - inset.bottom) return { x: s.x, y: s.y, angle: null };
  _c.copy(p).applyMatrix4(cam.matrixWorldInverse);
  const dx = _c.x;
  const dy = Math.hypot(_c.x, _c.y) < 1e-6 ? 1 : -_c.y;
  const hw = (w - inset.left - inset.right) / 2;
  const hh = (h - inset.top - inset.bottom) / 2;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: inset.left + hw + dx * t, y: inset.top + hh + dy * t, angle: Math.atan2(dy, dx) };
}

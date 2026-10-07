import { Bindings } from '@/engine/ui/binding';
import { el } from '@/engine/ui/dom';
import type { ObjectiveKind } from '@/game/story/objectives';
import { keyText } from '@/ui/hud';

import { ICONS } from './icons';
import type { PhoneApp } from './phone';

/** State readers for the current task, overall objective, and world markers. */
export interface TaskList {
  goal(): string | null;
  how(): string | null;
  aim(): string;
  marks(): readonly { label: string; kind: ObjectiveKind }[];
}

/** Display the current task, marked objectives, and overall goal. */
export class Tasks implements PhoneApp {
  readonly id = 'tasks';
  readonly name = 'TASKS';
  readonly icon = ICONS.tasks;
  private readonly views = new Bindings();

  constructor(private readonly list: TaskList) {}

  mount(root: HTMLElement): void {
    const now = el('section', 'phone-section', root);
    const marked = el('section', 'phone-section', root);
    const aim = el('section', 'phone-section', root);
    const { list } = this;
    this.views.add({
      read: () => {
        const g = list.goal();
        const how = g ? list.how() : null;
        return `<h4>RIGHT NOW</h4><p>${g ? keyText(g) : 'NOTHING IN PARTICULAR.'}</p>${how ? `<p class="how">${keyText(how)}</p>` : ''}`;
      },
      draw: (html) => (now.innerHTML = html),
    });
    this.views.add({
      read: () =>
        list
          .marks()
          .map((m) => `${m.kind}:${m.label}`)
          .join('|'),
      draw: () => {
        const marks = list.marks();
        marked.innerHTML = marks.length
          ? `<h4>MARKED</h4>${marks.map((m) => `<p class="mark ${m.kind}">${m.label}${m.kind === 'optional' ? ' <small>(OPTIONAL)</small>' : ''}</p>`).join('')}`
          : '';
      },
    });
    this.views.add({
      read: () => list.aim(),
      draw: (a) => (aim.innerHTML = `<h4>THE BIG ONE</h4><p>${a}</p>`),
    });
  }

  update(): void {
    this.views.update();
  }
}

/**
 * Occupancy, escape, and ledger counters plus phantom location labels consumed
 * by the Phantoms app.
 */
export interface PhantomReport {
  onBoard: number;
  spots: number;
  escapes: number;
  logged: number;
  inDeck: number;
  where: readonly string[];
}

/**
 * Display phantom occupancy, escape totals, ledger counts, and phantom
 * locations.
 */
export class Phantoms implements PhoneApp {
  readonly id = 'phantoms';
  readonly name = 'PHANTOMS';
  readonly icon = ICONS.phantoms;
  private readonly views = new Bindings();

  constructor(private readonly report: () => PhantomReport) {}

  mount(root: HTMLElement): void {
    const count = el('section', 'phone-count', root);
    const log = el('section', 'phone-section', root);
    const where = el('section', 'phone-section', root);
    this.views.add({
      read: () => this.report(),
      same: (a, b) =>
        a.onBoard === b.onBoard &&
        a.spots === b.spots &&
        a.escapes === b.escapes &&
        a.logged === b.logged &&
        a.inDeck === b.inDeck &&
        a.where.join() === b.where.join(),
      draw: (r) => {
        count.innerHTML = `<b>${r.onBoard}</b><span>/ ${r.spots} ON THE BOARD</span>`;
        log.innerHTML = `<p>ESCAPES <b>${r.escapes}</b></p><p>BADGE LOG <b>${r.logged}</b></p><p>CARS IN THE DECK <b>${r.inDeck}</b></p>`;
        where.innerHTML = `<h4>WHERE THEY HANG</h4>${r.where.length ? r.where.map((w) => `<p>${w}</p>`).join('') : '<p class="none">NONE YET. GET A CAR OUT WITHOUT BADGING IT.</p>'}`;
      },
    });
  }

  update(): void {
    this.views.update();
  }
}

/**
 * Provide a container for the HUD’s phone map, available while walking or
 * driving.
 */
export class MapApp implements PhoneApp {
  readonly id = 'map';
  readonly name = 'MAP';
  readonly icon = ICONS.map;

  mount(root: HTMLElement): void {
    root.classList.add('phone-map');
  }
}

/** Image source and caption for the phone’s photo gallery. */
interface Photo {
  src: string;
  caption: string;
}

/** Static photo gallery entries. */
const PHOTOS: readonly Photo[] = [];

/** The phone's camera roll. */
export class Photos implements PhoneApp {
  readonly id = 'photos';
  readonly name = 'PHOTOS';
  readonly icon = ICONS.photos;

  mount(root: HTMLElement): void {
    if (!PHOTOS.length) {
      el('p', 'phone-empty', root, 'NO PHOTOS YET.');
      return;
    }

    const grid = el('div', 'phone-photos', root);
    for (const p of PHOTOS) {
      el(
        'figure',
        '',
        grid,
        `<img src="${p.src}" alt=""><figcaption>${p.caption}</figcaption>`,
      );
    }
  }
}

/**
 * Rebuild the control reference when selected so labels match the current
 * input device.
 */
export class Help implements PhoneApp {
  readonly id = 'help';
  readonly name = 'HELP';
  readonly icon = ICONS.help;
  private root: HTMLElement | null = null;

  constructor(
    private readonly rows: () => readonly [keys: string, what: string][],
  ) {}

  mount(root: HTMLElement): void {
    this.root = root;
  }

  shown(on: boolean): void {
    if (!on || !this.root) {
      return;
    }

    this.root.innerHTML = `<div class="phone-keys">${this.rows()
      .map(
        ([keys, what]) =>
          `<p><span class="keys">${keys}</span><span class="what">${what}</span></p>`,
      )
      .join('')}</div>`;
  }
}

import { Bindings } from '../../engine/ui/binding';
import { el } from '../../engine/ui/dom';
import type { ObjectiveKind } from '../../game/story/objectives';
import { keyText } from '../hud';
import { ICONS } from './icons';
import type { PhoneApp } from './phone';

/** What the Tasks app reads: the task right now, the standing aim, and the markers out in the world. */
export interface TaskList {
  goal(): string | null;
  aim(): string;
  marks(): readonly { label: string; kind: ObjectiveKind }[];
}

/** The task right now (the line under the clock), the standing aim, and what's marked out in the world. */
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
      read: () => list.goal(),
      draw: (g) => (now.innerHTML = `<h4>RIGHT NOW</h4><p>${g ? keyText(g) : 'NOTHING IN PARTICULAR.'}</p>`),
    });
    this.views.add({
      read: () => list.marks().map((m) => `${m.kind}:${m.label}`).join('|'),
      draw: () => {
        const marks = list.marks();
        marked.innerHTML = marks.length ? `<h4>MARKED</h4>${marks.map((m) => `<p class="mark ${m.kind}">${m.label}${m.kind === 'optional' ? ' <small>(OPTIONAL)</small>' : ''}</p>`).join('')}` : '';
      },
    });
    this.views.add({ read: () => list.aim(), draw: (a) => (aim.innerHTML = `<h4>THE BIG ONE</h4><p>${a}</p>`) });
  }

  update(): void {
    this.views.update();
  }
}

/** What the Phantoms app reads: the board's phantom count (the badge log less the cars really there) of how many spots, all the escapes, the badge log, cars really in the deck, and the spots their imprints haunt. */
export interface PhantomReport {
  onBoard: number;
  spots: number;
  escapes: number;
  logged: number;
  inDeck: number;
  where: readonly string[];
}

/** How the haunting's going: phantoms in spots against the deck's spots, the badge log, and where each phantom hangs. */
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
      same: (a, b) => a.onBoard === b.onBoard && a.spots === b.spots && a.escapes === b.escapes && a.logged === b.logged && a.inDeck === b.inDeck && a.where.join() === b.where.join(),
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

/** The city map. While it's up and Cody's on foot, the HUD's map docks in here. */
export class MapApp implements PhoneApp {
  readonly id = 'map';
  readonly name = 'MAP';
  readonly icon = ICONS.map;

  mount(root: HTMLElement): void {
    root.classList.add('phone-map');
  }
}

/** A photo on the phone, and what it says under it. */
export interface Photo {
  src: string;
  caption: string;
}

/** The phone's photos. None yet. */
export const PHOTOS: readonly Photo[] = [];

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
    for (const p of PHOTOS) el('figure', '', grid, `<img src="${p.src}" alt=""><figcaption>${p.caption}</figcaption>`);
  }
}

/** Every key, and what it does: drawn when it comes up, so the caps match the device in use. */
export class Help implements PhoneApp {
  readonly id = 'help';
  readonly name = 'HELP';
  readonly icon = ICONS.help;
  private root: HTMLElement | null = null;

  constructor(private readonly rows: () => readonly [keys: string, what: string][]) {}

  mount(root: HTMLElement): void {
    this.root = root;
  }

  shown(on: boolean): void {
    if (!on || !this.root) return;
    this.root.innerHTML = `<div class="phone-keys">${this.rows()
      .map(([keys, what]) => `<p><span class="keys">${keys}</span><span class="what">${what}</span></p>`)
      .join('')}</div>`;
  }
}

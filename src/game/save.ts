import { Vector3 } from 'three';
import { TUNING } from '../config';
import { urlFlag } from '../engine/core/url-flags';
import type { Game } from './game';
import { type ItemKind, isItemKind } from './items/item-breeds';
import type { FoundCash } from './items/money';

const KEY = '30pc.save';
/** 2 added quest steps, Randy's stock and today's cash about town; a version 1 save still loads. */
const VERSION = 2;
/** How often (s of play) to look for anything new to save. */
const EVERY = 2;

/** A saved phantom's spot (null for an unparked escape), position, yaw, number, and creation time. */
export interface PhantomRecord {
  spot: number | null;
  at: [number, number, number];
  yaw: number;
  n: number;
  hours: number;
  day: number;
}

/**
 * What a save keeps: the day, Cody's cash and inventory, every phantom so far, each quest's step
 * (so a won game stays won), what's left in each of Randy's slots, and the cash still lying about
 * town today (null: lay out fresh), so a reload brings back the same day rather than a new one.
 */
export interface SaveData {
  v: typeof VERSION;
  day: number;
  cash: number;
  items: [ItemKind, number][];
  phantoms: PhantomRecord[];
  quests: Record<string, string>;
  stock: number[];
  found: FoundCash[] | null;
}

/**
 * Persists the game in localStorage (SaveData). Restores on start unless the tutorial is running
 * or ?fresh is set, and writes nothing while the tutorial runs, so a run through it doesn't
 * overwrite the game it set aside. Checks for changes every two seconds and saves when the page
 * is hidden.
 */
export class SaveGame {
  /** Every phantom so far, in order. */
  readonly phantoms: PhantomRecord[] = [];
  private playing = false;
  private wait = 0;
  private last = '';

  constructor(
    private readonly game: Game,
    private readonly tutorialRunning: () => boolean,
  ) {
    const ev = game.events;
    ev.on('start', () => {
      const saved = this.tutorialRunning() || urlFlag('fresh') ? null : load();
      if (saved) this.restore(saved);
      this.playing = true;
      this.flush();
    });
    ev.on('phantom', ({ at, spot, yaw, n, hours, day }) => {
      this.phantoms.push({ spot: spot ? spot.def.id : null, at: [at.x, at.y, at.z], yaw, n, hours, day });
      this.wait = 0;
    });
    ev.on('frame', (dt) => {
      this.wait -= dt;
      if (this.wait > 0) return;
      this.wait = EVERY;
      this.flush();
    });
    window.addEventListener('pagehide', () => this.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.flush();
    });
  }

  /** Write the save if anything in it has changed. */
  flush(): void {
    if (!this.playing || this.tutorialRunning()) return;
    const g = this.game;
    const data: SaveData = {
      v: VERSION,
      day: g.clock.day,
      cash: g.money.cash,
      items: g.inventory.list(),
      phantoms: this.phantoms,
      quests: g.quests.steps(),
      stock: g.wares.slots.map((s) => s.count),
      found: g.money.foundToday(),
    };
    const json = JSON.stringify(data);
    if (json === this.last) return;
    try {
      localStorage.setItem(KEY, json);
      this.last = json;
    } catch {
      // Keep the previous snapshot so the next flush retries a failed write.
    }
  }

  private restore(d: SaveData): void {
    const g = this.game;
    g.clock.day = d.day;
    g.money.cash = d.cash;
    for (const [kind, n] of d.items) g.inventory.add(kind, n);
    for (const p of d.phantoms) {
      g.restorePhantom(p.spot, new Vector3(...p.at), p.yaw);
      this.phantoms.push(p);
    }
    g.quests.restore(d.quests);
    // Randy's slots as they were, if his coat's the same
    if (d.stock.length === g.wares.slots.length) g.wares.slots.forEach((s, i) => (s.count = d.stock[i] ?? s.count));
    if (d.found) g.money.layOut(d.found);
    // start() said DAY 1
    g.hud.clearToasts();
    g.announceDay();
  }
}

function load(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? null : parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/** A save from storage, if it's one this version can read (version 1 too). */
function parse(x: unknown): SaveData | null {
  if (!isObj(x) || (x.v !== VERSION && x.v !== 1) || !isNum(x.day) || !Array.isArray(x.items) || !Array.isArray(x.phantoms)) return null;
  const items: [ItemKind, number][] = [];
  const rawItems: unknown[] = x.items;
  for (const e of rawItems) {
    if (!Array.isArray(e)) continue;
    const [kind, n]: unknown[] = e;
    if (typeof kind === 'string' && isItemKind(kind) && isNum(n) && n > 0) items.push([kind, n]);
  }
  const phantoms: PhantomRecord[] = [];
  const rawPhantoms: unknown[] = x.phantoms;
  for (const p of rawPhantoms) {
    const rec = phantom(p);
    if (rec) phantoms.push(rec);
  }
  // a version 1 save that had already won had shown it: won, quietly
  const quests: Record<string, string> = x.v === 1 && phantoms.length >= TUNING.garage.spots ? { haunting: 'won' } : {};
  if (isObj(x.quests)) for (const [id, step] of Object.entries(x.quests)) if (typeof step === 'string') quests[id] = step;
  const stock = Array.isArray(x.stock) && x.stock.every((n) => isNum(n) && n >= 0) ? x.stock.map((n) => Math.round(Number(n))) : [];
  const found = Array.isArray(x.found) ? x.found.flatMap((c) => foundCash(c)) : null;
  // Keep the rest of the save when the cash value is unreadable.
  return { v: VERSION, day: Math.max(1, Math.round(x.day)), cash: isNum(x.cash) ? Math.max(0, x.cash) : 0, items, phantoms, quests, stock, found };
}

function foundCash(x: unknown): FoundCash[] {
  if (!Array.isArray(x) || x.length !== 4) return [];
  const [a, b, c, n]: unknown[] = x;
  return isNum(a) && isNum(b) && isNum(c) && isNum(n) && n > 0 ? [[a, b, c, n]] : [];
}

function phantom(x: unknown): PhantomRecord | null {
  if (!isObj(x)) return null;
  const at = vec3(x.at);
  const { spot, yaw, n, hours, day } = x;
  if (!at || !(spot === null || isNum(spot)) || !isNum(yaw) || !isNum(n) || !isNum(hours) || !isNum(day)) return null;
  return { spot, at, yaw, n, hours, day };
}

function vec3(x: unknown): [number, number, number] | null {
  if (!Array.isArray(x) || x.length !== 3) return null;
  const [a, b, c]: unknown[] = x;
  return isNum(a) && isNum(b) && isNum(c) ? [a, b, c] : null;
}

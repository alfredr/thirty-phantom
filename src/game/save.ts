import { Vector3 } from 'three';
import { urlFlag } from '../core/url-flags';
import type { Game } from './game';
import { type ItemKind, isItemKind } from './items/inventory';

const KEY = '30pc.save';
const VERSION = 1;
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

/** What a save keeps: the day, Cody's cash and inventory, and every phantom so far. */
export interface SaveData {
  v: typeof VERSION;
  day: number;
  cash: number;
  items: [ItemKind, number][];
  phantoms: PhantomRecord[];
}

/**
 * Persists the day, cash, inventory, and phantoms in localStorage.
 * Restores on start unless the tutorial is running or ?fresh is set.
 * Checks for changes every two seconds and saves when the page is hidden.
 */
export class SaveGame {
  /** Every phantom so far, in order. */
  readonly phantoms: PhantomRecord[] = [];
  private playing = false;
  private wait = 0;
  private last = '';

  constructor(
    private readonly game: Game,
    tutorialRunning: () => boolean,
  ) {
    const ev = game.events;
    ev.on('start', () => {
      const saved = tutorialRunning() || urlFlag('fresh') ? null : load();
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
    if (!this.playing) return;
    const g = this.game;
    const data: SaveData = { v: VERSION, day: g.clock.day, cash: g.money.cash, items: g.inventory.list(), phantoms: this.phantoms };
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

/** A save from storage, if it's one this version can read. */
function parse(x: unknown): SaveData | null {
  if (!isObj(x) || x.v !== VERSION || !isNum(x.day) || !Array.isArray(x.items) || !Array.isArray(x.phantoms)) return null;
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
  // Keep the rest of the save when the cash value is unreadable.
  return { v: VERSION, day: Math.max(1, Math.round(x.day)), cash: isNum(x.cash) ? Math.max(0, x.cash) : 0, items, phantoms };
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

export interface TextOptions {
  until?: () => boolean;
  brief?: number;
  key?: string;
  landed?: () => void;
  reply?: boolean;
}

export interface CallOptions {
  key?: string;
}

export interface Outreach {
  readonly kind: 'text' | 'call';
  readonly start: number;
  readonly reply: boolean;
  end: number | null;
}

export interface OutreachView {
  show(msg: string, opts: TextOptions): void;
  hide(): void;
  fly(msg: string): void;
  land(msg: string): void;
  ring(): void;
}

export const OUTREACH_GAP = 30;
export const FLY_TIME = 0.5;
const HISTORY = 64;

type Item =
  | { kind: 'text'; msg: string; opts: TextOptions }
  | { kind: 'call'; start: () => void; key?: string };

interface Showing {
  msg: string;
  opts: TextOptions;
  record: Outreach;
  shown: number;
  visible: boolean;
  flying: number | null;
}

export class OutreachQueue {
  elapsed = 0;
  private readonly items: Item[] = [];
  private current: Showing | null = null;
  private call: Outreach | null = null;
  private last = -Infinity;
  private readonly log: Outreach[] = [];

  constructor(private readonly view: OutreachView) {}

  get history(): readonly Outreach[] {
    return this.log;
  }

  get visible(): boolean {
    return !!this.current?.visible && this.current.flying === null;
  }

  get awaitingKey(): boolean {
    const t = this.current;
    return !!t && this.visible && !t.opts.until && t.opts.brief === undefined;
  }

  get calling(): boolean {
    return this.call !== null;
  }

  get pending(): number {
    return this.items.length + (this.current ? 1 : 0) + (this.call ? 1 : 0);
  }

  get lastEnd(): number {
    return this.last;
  }

  text(msg: string, opts: TextOptions = {}): void {
    if (opts.reply) {
      this.items.unshift({ kind: 'text', msg, opts });
    } else {
      this.items.push({ kind: 'text', msg, opts });
    }
  }

  queueCall(start: () => void, opts: CallOptions = {}): void {
    this.items.push({ kind: 'call', start, key: opts.key });
  }

  drop(key: string): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (
        item &&
        (item.kind === 'text' ? item.opts.key : item.key)?.startsWith(key)
      ) {
        this.items.splice(i, 1);
      }
    }

    if (
      this.current &&
      this.current.flying === null &&
      this.current.opts.key?.startsWith(key)
    ) {
      this.acknowledge(true);
    }
  }

  endCall(): void {
    if (!this.call) {
      return;
    }

    this.call.end = this.elapsed;
    this.last = this.elapsed;
    this.call = null;
  }

  acknowledge(force = false): boolean {
    const t = this.current;
    if (!t || t.flying !== null || (!force && (!t.visible || t.opts.until))) {
      return false;
    }

    t.flying = FLY_TIME;
    t.visible = false;
    this.view.fly(t.msg);
    return true;
  }

  update(dt: number, quiet: boolean): void {
    this.elapsed += dt;
    this.updateText(dt, quiet);

    while (!this.current && !this.call) {
      const front = this.items[0];
      if (!front) {
        return;
      }

      if (front.kind === 'text' && front.opts.until?.()) {
        this.items.shift();
        this.view.land(front.msg);
        front.opts.landed?.();
        continue;
      }

      const reply = front.kind === 'text' && front.opts.reply === true;
      if (quiet || (!reply && this.elapsed - this.last < OUTREACH_GAP)) {
        return;
      }

      this.items.shift();

      if (front.kind === 'call') {
        this.call = this.record('call');
        this.view.ring();
        front.start();
        return;
      }

      this.current = {
        msg: front.msg,
        opts: front.opts,
        record: this.record('text', reply),
        shown: 0,
        visible: true,
        flying: null,
      };
      this.view.show(front.msg, front.opts);
    }
  }

  private updateText(dt: number, quiet: boolean): void {
    const t = this.current;
    if (!t) {
      return;
    }

    if (t.flying !== null) {
      t.flying -= dt;

      if (t.flying <= 0) {
        this.current = null;
        t.record.end = this.elapsed;
        this.last = this.elapsed;
        this.view.land(t.msg);
        t.opts.landed?.();
      }

      return;
    }

    if (t.opts.until?.()) {
      this.acknowledge(true);
      return;
    }

    if (quiet || this.call) {
      if (t.visible) {
        t.visible = false;
        this.view.hide();
      }

      return;
    }

    if (!t.visible) {
      t.visible = true;
      this.view.show(t.msg, t.opts);
    }

    t.shown += dt;

    if (t.opts.brief !== undefined && t.shown >= t.opts.brief) {
      this.acknowledge(true);
    }
  }

  private record(kind: Outreach['kind'], reply = false): Outreach {
    const r: Outreach = { kind, start: this.elapsed, reply, end: null };
    this.log.push(r);

    if (this.log.length > HISTORY) {
      this.log.shift();
    }

    return r;
  }
}

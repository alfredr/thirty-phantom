import type { Focus } from '@/engine/input/input';
import type { MindEvent } from '@/engine/sim/mind';
import { type Control, isControl, keyName } from '@/game/controls';
import type { DialogueLine, Side } from '@/ui/dialogue';
import type { CallLine, Phone } from '@/ui/phone/phone';

import type { Part, Scope } from './director';

const RING = 1.6;
const ANSWER_WAIT = 10;
const NUDGE_IDLE = 30;
const NAG_EVERY = 180;
const SLOWING = 1;
const CRAWLING = 0.25;
const STOPPED = 0.05;
const SOLO_LINE = 2.2;

export interface Line extends DialogueLine {
  readonly solo?: boolean;
}

export type Lines<C> = readonly Line[] | ((c: C) => readonly Line[]);
export type Words<C> = string | ((c: C) => string);

export interface Voice {
  readonly open: boolean;
  play(lines: readonly DialogueLine[], done: () => void): void;
  cancel(): void;
}

export interface Ringer {
  ring(first: boolean): void;
  answered(first: boolean): void;
}

export interface Solo {
  show(line: { who: string; say: string } | null): void;
}

export interface NudgeLines {
  readonly crawling?: readonly Line[];
  readonly stopped?: readonly Line[];
}

interface Saying {
  readonly lines: readonly Line[];
  readonly token: object;
  readonly done: () => void;
  i: number;
  t: number;
}

interface Call {
  readonly key: string;
  readonly lines: readonly Line[];
  readonly keep: boolean;
  readonly done: () => void;
  state: 'queued' | 'ringing' | 'waiting' | 'talking' | 'over';
  t: number;
  stop: (() => void) | null;
}

export class Outreach {
  private open: CallLine[] | null = null;
  private ringing: Call | null = null;
  private answered = false;
  private readonly sent = new Set<string>();
  private readonly calls = new Set<Call>();
  private talking: object | null = null;
  private saying: Saying | null = null;
  private readonly waiting: (readonly Line[])[] = [];

  constructor(
    readonly phone: Phone,
    private readonly voice: Voice,
    private readonly solo: Solo,
    private readonly names: Readonly<Record<Side, string>>,
    private readonly pace: () => number,
    focus: Focus<Control>,
    private readonly ringer: Ringer,
  ) {
    focus.add({
      controls: () => (this.ringing && !this.answered ? ['interact'] : []),
      press: (_control, { repeat }) => {
        if (!repeat) {
          this.answer();
        }
      },
    });
  }

  get free(): boolean {
    return !this.voice.open && this.talking === null;
  }

  later(lines: readonly Line[]): void {
    this.waiting.push(lines);
  }

  tick(dt: number): void {
    const next = this.waiting[0];
    if (next && this.free && !this.phone.calling && !this.phone.popupVisible) {
      this.waiting.shift();
      this.speak(next, () => undefined);
    }

    const said = this.saying;
    if (said && (said.t += dt) >= SOLO_LINE) {
      said.i++;
      said.t = 0;
      this.showSolo(said);
    }

    const r = this.ringing;
    if (r) {
      r.t += dt;

      if (r.t >= (this.answered ? RING : ANSWER_WAIT)) {
        this.answer();
      }
    }

    for (const call of this.calls) {
      if (call.state === 'waiting' && this.free) {
        this.talk(call);
      }
    }
  }

  answer(): void {
    const r = this.ringing;
    if (!r) {
      return;
    }

    this.ringing = null;
    this.ringer.answered(!this.answered);
    this.answered = true;
    r.state = 'waiting';

    if (this.free) {
      this.talk(r);
    }
  }

  speak(lines: readonly Line[], done: () => void): () => void {
    const token = {};
    this.talking = token;

    const finish = (): void => {
      if (this.talking === token) {
        this.talking = null;
      }

      done();
    };

    if (lines.length && lines.every((l) => l.solo)) {
      this.saying = { lines, token, done: finish, i: 0, t: 0 };
      this.showSolo(this.saying);
    } else {
      this.voice.play(lines, finish);
    }

    return () => {
      if (this.talking !== token) {
        return;
      }

      this.talking = null;

      if (this.saying?.token === token) {
        this.saying = null;
        this.solo.show(null);
      } else {
        this.voice.cancel();
      }
    };
  }

  private showSolo(said: Saying): void {
    const line = said.lines[said.i];
    if (!line) {
      this.saying = null;
      this.solo.show(null);
      said.done();
      return;
    }

    this.solo.show({ who: this.names[line.who], say: line.say });
    line.cue?.();
  }

  text(
    key: string,
    msg: string,
    opts: { until?: () => boolean; brief?: number; landed?: () => void; reply?: boolean } = {},
  ): void {
    this.phone.text(msg, { ...opts, key });
  }

  once(id: string): boolean {
    if (this.sent.has(id)) {
      return false;
    }

    this.sent.add(id);
    return true;
  }

  call(key: string, lines: readonly Line[], keep: boolean, done: () => void): () => void {
    const continuing = this.open !== null && this.calls.size === 0;
    const call: Call = { key, lines, keep, done, state: 'queued', t: 0, stop: null };
    this.calls.add(call);

    if (continuing) {
      call.state = 'waiting';
    } else {
      this.phone.queueCall(
        () => {
          this.open = [];
          call.state = 'ringing';
          this.ringing = call;
          this.ringer.ring(!this.answered);
        },
        { key },
      );
    }

    return () => this.abandon(call);
  }

  close(): void {
    this.waiting.length = 0;

    for (const call of this.calls) {
      this.abandon(call);
    }

    this.ringing = null;

    if (this.open) {
      this.phone.endCall(this.open);
      this.open = null;
    }
  }

  drop(prefix: string): void {
    for (const call of this.calls) {
      if (call.key.startsWith(prefix)) {
        this.abandon(call);
      }
    }

    this.phone.drop(prefix);
  }

  nudge(beat: string, action: string, idle: number, stage: Nudging, dt: number, lines: NudgeLines = {}): void {
    if (idle < NUDGE_IDLE) {
      return;
    }

    const pace = this.pace();
    const key = `${beat}:nudge`;
    if (stage.n === 0 && pace < SLOWING) {
      this.stage(beat, stage, 1);
      this.text(key, `YOU KNOW WHAT WOULD BE FUN? ${action}.`);
    } else if (stage.n === 1 && pace < CRAWLING) {
      this.stage(beat, stage, 2);
      this.call(
        key,
        lines.crawling ?? [
          { who: 'left', say: "YOU KNOW, TIME DOESN'T FLY UNLESS WE'RE HAVING FUN..." },
          { who: 'right', say: '...WHAT?' },
          { who: 'left', say: `${action}, KID.` },
        ],
        false,
        () => undefined,
      );
    } else if (stage.n === 2 && pace < STOPPED) {
      this.stage(beat, stage, 3);
      this.call(
        key,
        lines.stopped ?? [
          { who: 'left', say: `LOOK. WE'RE STUCK IN THIS LIMBO TOGETHER UNTIL YOU ${action}.` },
          { who: 'left', say: "I'VE GOT ALL NIGHT. LITERALLY. THE CLOCK STOPPED." },
        ],
        false,
        () => undefined,
      );
    } else if (stage.n === 3 && (stage.nag += dt) >= NAG_EVERY) {
      this.stage(beat, stage, 3);
      this.text(key, `STILL HERE. STILL LIMBO. ${action}.`);
    }
  }

  private stage(beat: string, stage: Nudging, n: number): void {
    this.drop(`${beat}:text`);
    stage.n = n;
    stage.nag = 0;
  }

  private talk(call: Call): void {
    call.state = 'talking';
    call.stop = this.speak(call.lines, () => this.finish(call));
  }

  private finish(call: Call): void {
    call.state = 'over';
    call.stop = null;
    this.calls.delete(call);
    const log = this.open ?? [];
    log.push(...call.lines.map((l) => ({ who: this.names[l.who], say: plain(l.say) })));

    if (call.keep) {
      this.open = log;
    } else {
      this.open = null;
      this.phone.endCall(log);
    }

    call.done();
  }

  private abandon(call: Call): void {
    if (!this.calls.delete(call)) {
      return;
    }

    if (call.state === 'queued') {
      this.phone.drop(call.key);
    }

    if (this.ringing === call) {
      this.ringing = null;
    }

    if (call.state === 'talking') {
      call.stop?.();
    }

    if (call.state === 'ringing' || call.state === 'talking' || (call.state === 'waiting' && !call.keep)) {
      this.phone.endCall(this.open ?? []);
      this.open = null;
    }

    call.state = 'over';
  }
}

const plain = (say: string): string =>
  say.replace(/\{(\w+)\}/g, (m, name: string) => (isControl(name) ? keyName(name) : m));

export interface Nudging {
  n: number;
  nag: number;
}

type Cast = { readonly outreach: Outreach };
type OutPart<C> = Part<C & Cast, MindEvent<string>, string>;

const linesOf = <C>(lines: Lines<C>, c: C): readonly Line[] => (typeof lines === 'function' ? lines(c) : lines);
const wordsOf = <C>(w: Words<C>, c: C): string => (typeof w === 'function' ? w(c) : w);
const dropAll = (s: Scope<string>, c: Cast) => (): void => c.outreach.drop(`${s.key}:`);

export function say<C>(lines: Lines<C>, opts: { wait?: number } = {}): OutPart<C> {
  return {
    create: (s, c) => {
      let stop: (() => void) | null = null;
      const start = (): void => {
        if (stop || s.t < (opts.wait ?? 0) || !c.outreach.free || c.outreach.phone.calling) {
          return;
        }

        stop = c.outreach.speak(linesOf(lines, c), () => s.done());
      };

      start();
      return { tick: start, stop: () => stop?.() };
    },
  };
}

export interface TextSpec<C> {
  readonly until?: (c: C, s: Scope<string>) => boolean;
  readonly doing?: boolean;
  readonly only?: (c: C) => boolean;
  readonly repeat?: boolean;
  readonly brief?: number;
  readonly after?: number;
  readonly done?: boolean;
  readonly key?: string;
  readonly reply?: boolean;
}

export function text<C>(msg: Words<C>, spec: TextSpec<C> = {}): OutPart<C> {
  return {
    create: (s, c) => {
      let queued = false;
      const send = (): void => {
        queued = true;
        const words = wordsOf(msg, c);
        if (spec.only && !spec.only(c)) {
          return;
        }

        if (!spec.repeat && !c.outreach.once(`${s.id}:${words}`)) {
          if (spec.done) {
            s.done();
          }

          return;
        }

        c.outreach.text(spec.key ?? `${s.key}:text`, words, {
          until: spec.until ? () => spec.until?.(c, s) === true : spec.doing ? () => false : undefined,
          brief: spec.brief,
          reply: spec.reply,
          landed: spec.done ? () => s.done() : undefined,
        });
      };

      if (!spec.after) {
        send();
      }

      return {
        tick: () => {
          if (!queued && s.t >= (spec.after ?? 0)) {
            send();
          }
        },
        stop: dropAll(s, c),
      };
    },
  };
}

export function call<C>(lines: Lines<C>, opts: { keep?: boolean } = {}): OutPart<C> {
  return {
    create: (s, c) => {
      const abandon = c.outreach.call(`${s.key}:call`, linesOf(lines, c), opts.keep ?? false, () => s.done());
      const drop = dropAll(s, c);
      return {
        stop: () => {
          abandon();
          drop();
        },
      };
    },
  };
}

export function nudge<C>(action: Words<C>, lines: NudgeLines = {}): OutPart<C> {
  return {
    create: (s, c) => {
      const stage: Nudging = { n: 0, nag: 0 };
      return {
        tick: (dt) => c.outreach.nudge(s.key, wordsOf(action, c), s.idle, stage, dt, lines),
        progressed: () => c.outreach.drop(`${s.key}:nudge`),
        stop: dropAll(s, c),
      };
    },
  };
}

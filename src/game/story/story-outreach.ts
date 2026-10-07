import type { Focus } from '@/engine/input/input';
import type { MindEvent } from '@/engine/sim/mind';
import { type Control, isControl, keyName } from '@/game/controls';
import type { DialogueLine, Side } from '@/ui/dialogue';
import type { CallLine, Phone } from '@/ui/phone/phone';

import type { BeatBehavior, Scope } from './behaviors';

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

function plain(say: string): string {
  return say.replace(/\{(\w+)\}/g, (m, name: string) => (isControl(name) ? keyName(name) : m));
}

export interface Nudging {
  n: number;
  nag: number;
}

type OutreachServices = { readonly outreach: Outreach };
type OutreachBehavior<C> = BeatBehavior<C & OutreachServices, MindEvent<string>, string>;

function linesOf<C>(lines: Lines<C>, context: C): readonly Line[] {
  return typeof lines === 'function' ? lines(context) : lines;
}

function wordsOf<C>(w: Words<C>, context: C): string {
  return typeof w === 'function' ? w(context) : w;
}

function dropAll(scope: Scope<string>, context: OutreachServices): () => void {
  return function drop() {
    context.outreach.drop(`${scope.key}:`);
  };
}

export function say<C>(lines: Lines<C>, opts: { wait?: number } = {}): OutreachBehavior<C> {
  return function start(scope, context) {
    let stop: (() => void) | null = null;
    function speakWhenReady(): void {
      if (stop || scope.t < (opts.wait ?? 0) || !context.outreach.free || context.outreach.phone.calling) {
        return;
      }

      stop = context.outreach.speak(linesOf(lines, context), () => scope.done());
    }

    speakWhenReady();
    return {
      tick: speakWhenReady,
      stop() {
        stop?.();
      },
    };
  };
}

export interface TextSpec<C> {
  readonly until?: (context: C, scope: Scope<string>) => boolean;
  readonly doing?: boolean;
  readonly only?: (context: C) => boolean;
  readonly repeat?: boolean;
  readonly brief?: number;
  readonly after?: number;
  readonly done?: boolean;
  readonly key?: string;
  readonly reply?: boolean;
}

export function text<C>(msg: Words<C>, spec: TextSpec<C> = {}): OutreachBehavior<C> {
  return function start(scope, context) {
    let queued = false;
    function send(): void {
      queued = true;
      const words = wordsOf(msg, context);
      if (spec.only && !spec.only(context)) {
        return;
      }

      if (!spec.repeat && !context.outreach.once(`${scope.id}:${words}`)) {
        if (spec.done) {
          scope.done();
        }

        return;
      }

      context.outreach.text(spec.key ?? `${scope.key}:text`, words, {
        until: spec.until ? () => spec.until?.(context, scope) === true : spec.doing ? () => false : undefined,
        brief: spec.brief,
        reply: spec.reply,
        landed: spec.done ? () => scope.done() : undefined,
      });
    }

    if (!spec.after) {
      send();
    }

    return {
      tick() {
        if (!queued && scope.t >= (spec.after ?? 0)) {
          send();
        }
      },
      stop: dropAll(scope, context),
    };
  };
}

export function call<C>(lines: Lines<C>, opts: { keep?: boolean } = {}): OutreachBehavior<C> {
  return function start(scope, context) {
    const abandon = context.outreach.call(`${scope.key}:call`, linesOf(lines, context), opts.keep ?? false, () =>
      scope.done(),
    );
    const drop = dropAll(scope, context);
    return {
      stop() {
        abandon();
        drop();
      },
    };
  };
}

export function nudge<C>(action: Words<C>, lines: NudgeLines = {}): OutreachBehavior<C> {
  return function start(scope, context) {
    const stage: Nudging = { n: 0, nag: 0 };
    return {
      tick(dt) {
        context.outreach.nudge(scope.key, wordsOf(action, context), scope.idle, stage, dt, lines);
      },
      progressed() {
        context.outreach.drop(`${scope.key}:nudge`);
      },
      stop: dropAll(scope, context),
    };
  };
}

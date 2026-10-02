import { el } from './dom';
import { keyText } from './hud';
import './burner.css';

/** Real milliseconds Randy's "typing..." shows before a text lands, and how long the phone stays up after one. */
const TYPING = 900;
const HOLD = 9000;
/** Texts kept on the screen, newest at the bottom. */
const KEEP = 4;

/**
 * Randy's burner phone (the tutorial): it pans in from the left edge when he texts, his
 * "typing..." first, then the text as an incoming bubble under the ones before it, and after a
 * while it slides back to a strip at the edge (click or tap it to bring it back). His calls ring
 * on an incoming-call screen. The task his texts boil down to sits in a line under the clock.
 */
export class Burner {
  private readonly phone: HTMLDivElement;
  private readonly time: HTMLElement;
  private readonly avatars: HTMLElement[] = [];
  private readonly thread: HTMLDivElement;
  private readonly goal: HTMLDivElement;
  private typing: HTMLElement | null = null;
  private pending = 0;
  /** It sounds off (for the game's 'phone' event): starts ringing, stops ringing, a text lands. */
  onBuzz: ((what: 'ring' | 'hangup' | 'text') => void) | null = null;
  private lower = 0;

  constructor(hud: HTMLElement) {
    this.phone = el('div', 'burner', hud);
    const screen = el('div', 'burner-screen', this.phone);
    el('div', 'burner-notch', screen);
    const status = el('div', 'burner-status', screen);
    this.time = el('span', 'time', status, '');
    el('span', 'bars', status, '<i></i><i></i><i></i><i></i>');
    const head = el('div', 'burner-head', screen);
    this.avatars.push(el('div', 'burner-avatar', head));
    const who = el('div', 'burner-who', head);
    el('div', 'name', who, 'RANDY');
    el('div', 'sub', who, 'BURNER');
    this.thread = el('div', 'burner-thread', screen);
    const call = el('div', 'burner-call', screen);
    this.avatars.push(el('div', 'big', call));
    el('div', 'name', call, 'RANDY ROLSEN');
    el('div', 'state', call, 'INCOMING CALL');
    el('div', 'buttons', call, '<i class="no"></i><i class="ok"></i>');
    this.goal = el('div', 'burner-goal', hud);
    // back up from the edge for another look
    this.phone.addEventListener('click', () => {
      if (this.phone.classList.contains('peek')) this.raise();
    });
  }

  /** Randy's face (a data URL) for the contact and the call screen. */
  setAvatar(url: string): void {
    for (const a of this.avatars) a.style.backgroundImage = `url(${url})`;
  }

  /** The time on the phone's status bar. */
  setTime(text: string): void {
    if (this.time.textContent !== text) this.time.textContent = text;
  }

  /** A text from Randy: up comes the phone, he types, it lands. HTML is allowed, and `{action}` becomes its key cap. */
  text(msg: string): void {
    this.hangUp();
    this.raise();
    window.clearTimeout(this.pending);
    // a text still being typed lands at once, and this one starts typing
    if (this.typing) this.land(this.typing.dataset.msg ?? '');
    this.typing = el('div', 'burner-msg typing', this.thread, '<i></i><i></i><i></i>');
    this.typing.dataset.msg = msg;
    this.pending = window.setTimeout(() => this.typing && this.land(msg), TYPING);
  }

  /** Randy ringing: the incoming-call screen, the phone up and buzzing, till endCall. */
  call(): void {
    this.phone.classList.add('calling');
    this.onBuzz?.('ring');
    this.raise(false);
  }

  /** The call's over: back to the texts, and the phone back to the edge. */
  endCall(): void {
    this.hangUp();
    this.peek();
  }

  /** What to do now, under the clock; null clears it. HTML is allowed, and `{action}` becomes its key cap. */
  objective(task: string | null): void {
    this.goal.classList.toggle('on', !!task);
    if (task) this.goal.innerHTML = keyText(task);
  }

  /** Put the phone away (the tutorial is over). */
  close(): void {
    window.clearTimeout(this.pending);
    window.clearTimeout(this.lower);
    this.hangUp();
    this.phone.classList.remove('up', 'peek', 'buzz');
    this.objective(null);
  }

  /** The typed text becomes a bubble, the oldest beyond KEEP go, and the phone buzzes. */
  private land(msg: string): void {
    const bubble = this.typing;
    this.typing = null;
    if (!bubble) return;
    bubble.className = 'burner-msg';
    bubble.innerHTML = keyText(msg);
    delete bubble.dataset.msg;
    const msgs = this.thread.children;
    for (let i = 0; i < msgs.length - 1; i++) msgs[i]?.classList.add('old');
    while (msgs.length > KEEP) msgs[0]?.remove();
    this.buzz();
    this.onBuzz?.('text');
  }

  /** No longer ringing, if it was. */
  private hangUp(): void {
    if (!this.phone.classList.contains('calling')) return;
    this.phone.classList.remove('calling');
    this.onBuzz?.('hangup');
  }

  /** Pan the phone in, and (unless `hold`ing it up) back to the edge after a while. */
  private raise(lower = true): void {
    this.phone.classList.remove('peek');
    this.phone.classList.add('up');
    window.clearTimeout(this.lower);
    if (lower) this.lower = window.setTimeout(() => this.peek(), HOLD);
  }

  private peek(): void {
    window.clearTimeout(this.lower);
    this.phone.classList.remove('up');
    this.phone.classList.add('peek');
  }

  private buzz(): void {
    this.phone.classList.remove('buzz');
    void this.phone.offsetWidth;
    this.phone.classList.add('buzz');
  }
}

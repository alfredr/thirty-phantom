/** An event waiting in the queue: its type and payload, kept together. */
export interface QueuedEvent<M, K extends keyof M = keyof M> {
  readonly type: K;
  readonly payload: M[K];
}

/**
 * A typed event queue. Events are buffered while a frame runs and delivered together by flush(),
 * in the order they were emitted, so no handler runs in the middle of another system's update.
 * The payloads from the most recent flush stay readable through happened(), so rules can ask
 * what happened last frame without subscribing.
 */
export class EventQueue<M extends Record<string, unknown>> {
  private readonly handlers: { [K in keyof M]?: Set<(payload: M[K]) => void> } = {};
  private last: { [K in keyof M]?: M[K][] } = {};
  private pending: QueuedEvent<M>[] = [];

  /** Subscribes to one event type. The returned function unsubscribes. */
  on<K extends keyof M>(type: K, fn: (payload: M[K]) => void): () => void {
    const set = (this.handlers[type] ??= new Set<(payload: M[K]) => void>());
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Queues an event for the next flush. */
  emit<K extends keyof M>(type: K, payload: M[K]): void {
    this.pending.push({ type, payload });
  }

  /** Delivers the queued events in order. Events emitted by handlers wait for the next flush. */
  flush(): void {
    const batch = this.pending;
    this.pending = [];
    this.last = {};
    for (const event of batch) this.deliver(event);
  }

  /** The payloads of one event type delivered by the most recent flush. */
  happened<K extends keyof M>(type: K): readonly M[K][] {
    return this.last[type] ?? [];
  }

  private deliver<K extends keyof M>(event: QueuedEvent<M, K>): void {
    (this.last[event.type] ??= []).push(event.payload);
    const set = this.handlers[event.type];
    if (set) for (const fn of set) fn(event.payload);
  }
}

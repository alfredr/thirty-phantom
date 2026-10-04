/** A small typed event emitter: `on` returns a function that unsubscribes. */
export class Emitter<M extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof M, Set<(payload: never) => void>>();

  on<K extends keyof M>(type: K, fn: (payload: M[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      this.handlers.set(type, (set = new Set()));
    }

    set.add(fn as (payload: never) => void);
    return () => set.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.handlers.get(type);
    if (!set) {
      return;
    }

    for (const fn of set) {
      (fn as (payload: M[K]) => void)(payload);
    }
  }
}

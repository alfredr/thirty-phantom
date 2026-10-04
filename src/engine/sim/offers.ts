import { type Action, resolveFully } from './action';

/** Something that might be done with a control: the action, and how strongly it claims the control. */
export interface Candidate<C extends string, S, W extends S> {
  readonly control: C;
  readonly rank: number;
  readonly action: Action<S, W>;
}

/** The action a control would perform now, resolved, with the label to show for it. */
export interface Offer<C extends string, S, W extends S> {
  readonly control: C;
  readonly rank: number;
  readonly action: Action<S, W>;
  readonly label: string;
}

/** What each control offers, and why the ones that offer nothing were refused. */
export interface Offers<C extends string, S, W extends S> {
  readonly offers: ReadonlyMap<C, Offer<C, S, W>>;
  /** The reason from the highest-ranked refused candidate of each control that has no offer. */
  readonly refusals: ReadonlyMap<C, string>;
}

/**
 * Resolves candidates into the best offer per control. Higher rank wins; among equal ranks the earlier candidate wins,
 * so a caller can list candidates nearest first. Resolving has no side effects, so offers are suggestions: performing
 * an offer resolves it again against the world.
 */
export function bestOffers<C extends string, S, W extends S>(
  w: S,
  candidates: Iterable<Candidate<C, S, W>>,
): Offers<C, S, W> {
  const offers = new Map<C, Offer<C, S, W>>();
  const refusals = new Map<C, string>();
  const refusedAt = new Map<C, number>();
  for (const { control, rank, action } of candidates) {
    const best = offers.get(control);
    if (best && best.rank >= rank) {
      continue;
    }

    const resolved = resolveFully(w, action);
    if ('fail' in resolved) {
      if (resolved.fail && rank > (refusedAt.get(control) ?? -Infinity)) {
        refusals.set(control, resolved.fail);
        refusedAt.set(control, rank);
      }

      continue;
    }

    offers.set(control, { control, rank, action: resolved, label: resolved.label(w) });
  }

  for (const control of offers.keys()) {
    refusals.delete(control);
  }

  return { offers, refusals };
}

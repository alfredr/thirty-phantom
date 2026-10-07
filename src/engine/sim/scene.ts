import { Disposables } from '@/engine/core/disposable';

import { type Action, done } from './action';
import { type ActionSteps, Sequence } from './sequence';

export type Scene<A, R, P = never> =
  | { readonly kind: 'action'; readonly action: A }
  | { readonly kind: 'sequence'; readonly steps: readonly Scene<A, R, P>[] }
  | { readonly kind: 'holding'; readonly resources: readonly R[]; readonly body: Scene<A, R, P> }
  | {
      readonly kind: 'orElse';
      readonly body: Scene<A, R, P>;
      readonly fallback: Scene<A, R, P>;
    }
  | { readonly kind: 'until'; readonly condition: P; readonly body: Scene<A, R, P> };

export function scenes<A, R, P = never>() {
  return {
    until: (condition: P, body: Scene<A, R, P>): Scene<A, R, P> => ({ kind: 'until', condition, body }),
    action: (action: A): Scene<A, R, P> => ({ kind: 'action', action }),
    sequence: (steps: readonly Scene<A, R, P>[]): Scene<A, R, P> => ({ kind: 'sequence', steps }),
    holding: (resources: readonly R[], body: Scene<A, R, P>): Scene<A, R, P> => ({ kind: 'holding', resources, body }),
    orElse: (body: Scene<A, R, P>, fallback: Scene<A, R, P>): Scene<A, R, P> => ({ kind: 'orElse', body, fallback }),
  };
}

export interface SceneBindings<C, S, W extends S, A, R, P = never> {
  action(context: C, action: A): Action<S, W>;
  acquire(context: C, resource: R): Disposable;
  until?(context: C, condition: P, elapsed: number): boolean;
}

export function playScene<C, S, W extends S, A, R, P = never>(
  scene: Scene<A, R, P>,
  context: C,
  bindings: SceneBindings<C, S, W, A, R, P>,
): Sequence<S, W> {
  return new Sequence(() => visit(scene));

  function* visit(node: Scene<A, R, P>): ActionSteps<S, W> {
    switch (node.kind) {
      case 'until': {
        const test = bindings.until;
        if (!test) {
          throw new Error('Scene condition has no binding');
        }

        return yield new Sequence(
          () => visit(node.body),
          (_world, elapsed) => test(context, node.condition, elapsed),
        );
      }

      case 'action':
        return yield bindings.action(context, node.action);
      case 'sequence':
        for (const step of node.steps) {
          const result = yield* visit(step);
          if ('fail' in result) {
            return result;
          }
        }

        return done;

      case 'holding': {
        using held = new Disposables();

        for (const resource of node.resources) {
          held.use(bindings.acquire(context, resource));
        }

        return yield* visit(node.body);
      }

      case 'orElse': {
        const result = yield* visit(node.body);
        return 'fail' in result ? yield* visit(node.fallback) : result;
      }
    }
  }
}

import { type Mind, mind, type MindEvent, type MindOptions, type State } from '@/engine/sim/mind';

// Compile-time checks: npm run typecheck also verifies every @ts-expect-error below.
type TestState = State<'idle'> | State<'waiting', { seconds: number }>;
type TestEvent = MindEvent<'start', { seconds: number }> | MindEvent<'stop'>;

export const definition = mind<void, TestState, TestEvent>({
  idle: {
    on: {
      start: (_self, state, event) => {
        // @ts-expect-error This handler receives idle, which has no timer.
        void state.seconds;
        // @ts-expect-error Start's timer is a number.
        event.seconds.toUpperCase();
        return { at: 'waiting', seconds: event.seconds };
      },
    },
  },
  waiting: {
    tick: (_self, state, dt) => {
      state.seconds -= dt;
      return state.seconds <= 0 ? { at: 'idle' } : null;
    },
    on: {
      stop: (_self, state, event) => {
        state.seconds.toFixed();
        // @ts-expect-error Stop carries no timer.
        void event.seconds;
        return { at: 'idle' };
      },
    },
  },
});

export const options: MindOptions<void, TestState, TestEvent> = {
  on: {
    start: (_self, state, event) => {
      // @ts-expect-error A fallback can receive any state.
      void state.seconds;
      if (state.at === 'waiting') state.seconds.toFixed();
      return { at: 'waiting', seconds: event.seconds };
    },
  },
};

export function checkDefinitions(): void {
  // @ts-expect-error Every state needs a definition, even if it has no handlers.
  mind<void, TestState, TestEvent>({ idle: {} });
  mind<void, TestState, TestEvent>({
    idle: {
      on: {
        // @ts-expect-error Handlers cannot return a state without its required data.
        start: () => ({ at: 'waiting' }),
      },
    },
    waiting: {
      on: {
        // @ts-expect-error Only declared events can have handlers.
        missing: () => null,
      },
    },
  });
}

export function checkTransitions(machine: Mind<void, TestState, TestEvent>): void {
  machine.go({ at: 'idle' });
  machine.go({ at: 'waiting', seconds: 2 });
  machine.send({ type: 'start', seconds: 2 });
  machine.send({ type: 'stop' });

  // @ts-expect-error A state with no payload has only its tag.
  machine.go({ at: 'idle', seconds: 2 });
  // @ts-expect-error Waiting requires its data.
  machine.go({ at: 'waiting' });
  // @ts-expect-error State data keeps its declared type.
  machine.go({ at: 'waiting', seconds: 'two' });
  // @ts-expect-error Unknown states cannot be entered.
  machine.go({ at: 'missing' });
  // @ts-expect-error A signal with no payload has only its tag.
  machine.send({ type: 'stop', seconds: 2 });
  // @ts-expect-error Start requires its data.
  machine.send({ type: 'start' });
  // @ts-expect-error Event data keeps its declared type.
  machine.send({ type: 'start', seconds: 'two' });
  // @ts-expect-error Unknown events cannot be sent.
  machine.send({ type: 'missing' });

  const waiting = machine.in('waiting');
  if (waiting) waiting.seconds -= 1;
  const idle = machine.in('idle');
  // @ts-expect-error Narrowing to idle does not expose waiting's data.
  if (idle) idle.seconds -= 1;
  // @ts-expect-error Queries use the declared state names.
  machine.in('missing');
}

export function checkNoEvents(machine: Mind<void, TestState>): void {
  // @ts-expect-error A mind with no events cannot receive any.
  machine.send({ type: 'start', seconds: 2 });
}

export function checkNarrowing(state: TestState, event: TestEvent): void {
  if (state.at === 'waiting') state.seconds -= 1;
  else {
    // @ts-expect-error The tag narrows to the state with no payload.
    void state.seconds;
  }
  if (event.type === 'start') event.seconds.toFixed();
  else {
    // @ts-expect-error The tag narrows to the event with no payload.
    void event.seconds;
  }
  // @ts-expect-error State tags cannot be changed in place.
  state.at = 'idle';
  // @ts-expect-error Event tags cannot be changed in place.
  event.type = 'stop';
}

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { SharedViewsHost } from '../src/authority/shared-views.ts';
import { open, shownOf } from './support/shared-fixture.ts';

/**
 * A shared view's gate on a host whose queue hands a decision back to the request that asked for it
 * only once what was queued behind it ran — as a host is free to, `run` promising nothing of when
 * its caller hears the answer. A request the gate holds is woken by whatever moves its view from the
 * moment the gate decided it is to wait, in the queue: never left to its deadline, answered 503,
 * because the view moved before the request heard it was to wait.
 */

/**
 * The gate's decisions to wait the host holds while `holding`, each released by its function, and
 * what tells one from any other answer of the queue's.
 */
const held = vi.hoisted(() => {
  return {
    decisions: [] as (() => void)[],
    holding: false,
    waits: (value: unknown): boolean =>
      typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'wait',
  };
});

vi.mock(import('../src/authority/shared-views.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  /** The shared views of a host whose queue hands a decision to wait back late, while held. */
  class HeldViews extends actual.SharedViews {
    constructor(host: SharedViewsHost) {
      super({
        ...host,
        run: async <T>(body: () => Promise<T> | T): Promise<T> => {
          const value = await host.run(body);
          if (held.holding && held.waits(value)) {
            await new Promise<void>((resolve) => {
              held.decisions.push(resolve);
            });
          }
          return value;
        },
      });
    }
  }
  return { ...actual, SharedViews: HeldViews };
});

describe('a shared view’s gate on a host that hands its decision back late', () => {
  it('wakes a request whose view settled before the request heard it was to wait', async () => {
    onTestFinished(() => {
      held.holding = false;
    });
    const { ask, engine, operate } = await open({ gateWaitMs: 1000 });
    await ask('/boards/p1');
    const { sharedEvaluations } = await engine.stats();
    // A write the board reads and shows nothing of: evaluated again, the view is as it was, and
    // nothing is made — its evaluation the one move of the view's to wake the request.
    await operate('setNote', 'p1', '見えない');
    held.holding = true;
    const answering = ask('/boards/p1');

    await expect.poll(() => held.decisions.length).toBe(1);
    await expect
      .poll(async () => (await engine.stats()).sharedEvaluations)
      .toBe(sharedEvaluations + 1);

    held.holding = false;
    held.decisions[0]?.();
    const answer = await answering;

    expect(answer).toMatchObject({ kind: 'respond', status: 200 });
    expect(shownOf(answer)).toStrictEqual({
      generation: 'g1',
      texts: ['開発', '一覧を作る', '同期を確認する'],
    });
  });
});

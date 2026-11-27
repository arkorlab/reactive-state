import { describe, expect, it, vi } from 'vitest';

import { answer, waitingFor } from '../../src/cloudflare/object.ts';

/** What the object does with what `onError` returns: it keeps the object, and consumes it once. */
describe('onError in a Durable Object', () => {
  it('consumes a thenable the hook returns once, and gives it to waitUntil', async () => {
    let thens = 0;
    const thenable = {
      // eslint-disable-next-line unicorn/no-thenable -- a promise of another realm
      then: (resolve: () => void) => {
        thens += 1;
        resolve();
      },
    };
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>();
    const hook = waitingFor(
      { waitUntil } as unknown as DurableObjectState,
      () => thenable as unknown as Promise<void>,
    );

    await hook(new Error('x'), { kind: 'log' });
    await Promise.all(waitUntil.mock.calls.map(([work]) => work));

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(thens).toBe(1);
  });

  it('delivers a fault as a copy, which the hook cannot change after the call awaited more', async () => {
    const fault = new TypeError('as thrown');
    let caught: unknown;
    try {
      await answer(async () => {
        await Promise.resolve();
        throw fault;
      });
    } catch (error) {
      caught = error;
    }

    const stack = fault.stack;
    fault.message = 'rewritten by the hook';

    expect(caught).not.toBe(fault);
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).toMatchObject({ message: 'as thrown', name: 'TypeError' });
    expect((caught as Error).stack).toBe(stack);
  });

  it('keeps the cause and the errors of an aggregate in the copy it delivers', async () => {
    const cause = new Error('the cause');
    const parts = [new Error('one'), new Error('two')];
    const fault = new AggregateError(parts, 'many', { cause });
    let caught: unknown;
    try {
      await answer(async () => {
        await Promise.resolve();
        throw fault;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).cause).toBe(cause);
    expect((caught as AggregateError).errors).toStrictEqual(parts);
  });
});

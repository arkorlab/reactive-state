import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { type Evaluation, evaluate } from '../src/server/context.ts';
import { underwayQuery } from '../src/sql/client-objects.ts';

/**
 * A submittable `query` of an operation is counted as under way until it ends or errors, and the
 * tracking changes nothing of what the application sees of its events.
 */

/** A submittable as `pg`'s `Query` is: an emitter with a `submit`. */
// eslint-disable-next-line unicorn/prefer-event-target -- `pg`'s `Query` is an EventEmitter
class Submittable extends EventEmitter {
  submit(): void {
    // The connection would send it.
  }
}

/** An operation's evaluation that counts the probes registered and not yet unregistered. */
function counting(): { readonly evaluation: Evaluation; readonly open: () => number } {
  const probes = new Set<WeakKey>();
  const evaluation = {
    applicationConnection: (connection: WeakKey) => {
      probes.add(connection);
      return () => {
        probes.delete(connection);
      };
    },
  } as unknown as Evaluation;
  return { evaluation, open: () => probes.size };
}

describe('a submittable query under way', () => {
  it('is released at its end', async () => {
    const { evaluation, open } = counting();
    const query = new Submittable();

    await evaluate(evaluation, async () => {
      underwayQuery([query], () => query);

      expect(open()).toBe(1);

      query.emit('end');

      expect(open()).toBe(0);

      await Promise.resolve();
    });
  });

  it('is released at its error, which still throws where the application has no listener', async () => {
    const { evaluation, open } = counting();
    const query = new Submittable();

    await evaluate(evaluation, async () => {
      underwayQuery([query], () => query);

      expect(() => query.emit('error', new Error('refused'))).toThrow('refused');
      expect(open()).toBe(0);

      await Promise.resolve();
    });
  });

  it('is released at its error, which the application’s own listener still hears', async () => {
    const { evaluation, open } = counting();
    const query = new Submittable();
    const heard = vi.fn<(error: Error) => void>();
    query.on('error', heard);

    await evaluate(evaluation, async () => {
      underwayQuery([query], () => query);
      const error = new Error('refused');

      query.emit('error', error);

      expect(heard).toHaveBeenCalledExactlyOnceWith(error);
      expect(open()).toBe(0);

      await Promise.resolve();
    });
  });

  it('listens for its end alone where it names no error monitor', async () => {
    const { evaluation, open } = counting();
    const once = vi.fn<(event: string, listener: () => void) => void>();
    const query = { once, submit: vi.fn<() => void>() };

    await evaluate(evaluation, async () => {
      underwayQuery([query], () => query);

      expect(once.mock.calls.map(([event]) => event)).toStrictEqual(['end']);
      expect(open()).toBe(1);

      await Promise.resolve();
    });
  });

  it('is released before the application’s own end listener runs, though it registered first', async () => {
    const { evaluation, open } = counting();
    const query = new Submittable();
    const seen: number[] = [];
    query.on('end', () => {
      seen.push(open());
    });

    await evaluate(evaluation, async () => {
      underwayQuery([query], () => query);

      query.emit('end');

      expect(seen).toStrictEqual([0]);

      await Promise.resolve();
    });
  });

  it('pin: is released before the application’s own error listener runs', async () => {
    const { evaluation, open } = counting();
    const query = new Submittable();
    const seen: number[] = [];
    query.on('error', () => {
      seen.push(open());
    });

    await evaluate(evaluation, async () => {
      underwayQuery([query], () => query);

      query.emit('error', new Error('refused'));

      expect(seen).toStrictEqual([0]);

      await Promise.resolve();
    });
  });
});

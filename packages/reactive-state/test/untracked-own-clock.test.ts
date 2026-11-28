import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { type Evaluation, evaluate } from '../src/server/context.ts';
import { ownNow, watchUntracked } from '../src/server/untracked.ts';

/**
 * The framework's own read of the clock (`ownNow`) inside a render every visitor shares: the time
 * `Date.now()` answers — a test's spy of it too — which no answer of the render's holds, and the
 * watch of the clock does not note. A read of the application's beside it is noted as ever, and so
 * is whatever else a clock put in `Date.now`'s place reads.
 */

/** What a shared render of `body` notes of what it read untracked, in order. */
async function notedOf(body: () => unknown): Promise<readonly string[]> {
  const noted: string[] = [];
  const evaluation = {
    shared: {
      boundToRequest: (what: string) => {
        noted.push(what);
      },
    },
  } as unknown as Evaluation;
  await evaluate(evaluation, async () => {
    await body();
  });
  return noted;
}

describe('the framework’s own read of the clock', () => {
  beforeAll(() => {
    watchUntracked();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is not noted inside a shared render', async () => {
    await expect(notedOf(() => ownNow())).resolves.toStrictEqual([]);
  });

  it('notes a read of the application’s right after it, and right before it', async () => {
    await expect(
      notedOf(() => {
        ownNow();
        Date.now();
      }),
    ).resolves.toStrictEqual(['Date.now()']);
    await expect(
      notedOf(() => {
        Date.now();
        ownNow();
      }),
    ).resolves.toStrictEqual(['Date.now()']);
  });

  it('answers what `Date.now` answers, a spy of it too', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);

    expect(ownNow()).toBe(1234);
  });

  it('notes the application’s read after a clock that threw', async () => {
    vi.spyOn(Date, 'now').mockImplementationOnce(() => {
      throw new Error('No clock.');
    });

    const thrown: unknown[] = [];
    const noted = await notedOf(() => {
      try {
        ownNow();
      } catch (error) {
        thrown.push(error);
      }
      Date.now();
    });

    expect(thrown).toStrictEqual([new Error('No clock.')]);
    expect(noted).toStrictEqual(['Date.now()']);
  });

  it('notes nothing of a read within another, and the application’s after both', async () => {
    const watched = Date.now;
    let nested = false;
    // A clock that reads the framework's own within itself once, then the watched clock.
    vi.spyOn(Date, 'now').mockImplementation(() => {
      if (!nested) {
        nested = true;
        ownNow();
      }
      return Reflect.apply(watched, Date, []);
    });

    const noted = await notedOf(() => {
      ownNow();
      Date.now();
    });

    expect(nested).toBe(true);
    expect(noted).toStrictEqual(['Date.now()']);
  });

  it('notes what a clock in `Date.now`’s place reads beside the time', async () => {
    // eslint-disable-next-line sonarjs/pseudo-random -- exercises tracking, not a security value
    vi.spyOn(Date, 'now').mockImplementation(() => Math.round(Math.random()));

    await expect(notedOf(() => ownNow())).resolves.toStrictEqual(['Math.random()']);
  });

  it('is not noted of another copy of the module, as an application’s bundle may hold', async () => {
    vi.resetModules();
    const another = await import('../src/server/untracked.ts');

    expect(another.ownNow).not.toBe(ownNow);
    await expect(notedOf(() => another.ownNow())).resolves.toStrictEqual([]);
  });
});

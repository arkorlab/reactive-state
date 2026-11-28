import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';

import * as cloudflare from '../../src/cloudflare/index.ts';
import { database } from '../../src/server/schema.ts';

/**
 * The authority's object is given no stores: it reads the log of each store the follows of its
 * database bring, as its engine does (`test/stores-option.test.ts`). `stores` is no option of
 * `authorityObject`, and one given from JavaScript, or through `any`, is read as any option the
 * object does not know: not at all, as an object of the class starts. Nor does `./cloudflare`
 * export the type of a store.
 */

describe('the stores of the authority object', () => {
  it('are none authorityObject is given: an object of its class asks none', async () => {
    const stores = vi.fn(() => ({}));
    const Made = cloudflare.authorityObject(
      { buildId: 'b_stores_option', database: database({}), programs: [] },
      // @ts-expect-error -- `stores` is no option of the object's.
      { stores },
    );
    // The storage of an object of its own, by a name no other test's has, which this one starts on.
    const stub = env.AUTHORITY.getByName(`stores-${crypto.randomUUID()}`);
    onTestFinished(async () => {
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.deleteAlarm();
      });
    });

    const made = await runInDurableObject(stub, (_instance, state) => new Made(state, env));

    expect(made).toBeInstanceOf(Made);
    expect(stores).not.toHaveBeenCalled();
  });

  it('are of no type ./cloudflare exports', () => {
    // @ts-expect-error -- the store's type is no export of `./cloudflare`.
    type Store = cloudflare.ExternalStore;

    expectTypeOf<Store>().toBeAny();
  });
});

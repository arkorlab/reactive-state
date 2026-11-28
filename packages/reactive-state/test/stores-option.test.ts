import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ExternalStore } from '../src/authority/external.ts';
import { Engine, startAuthority } from '../src/authority/index.ts';
import { logStore } from './support/follow-store.ts';
import { itemsReadThrough } from './support/followed-items.ts';

/**
 * The authority is given no stores: it reads the log of each store the follows of its database
 * bring (`followedDb`, `reactiveDb`), and nothing else. `stores` is no option of `Engine` nor of
 * `startAuthority` — of `authorityObject`, `test/cloudflare/stores-option.test.ts` — and one given
 * from JavaScript, or through `any`, is read as any option the authority does not know: not at all.
 */

const BUILD = 'b_stores_option';

/** A stand-in of a store's log, of no change, and its reads. */
function quiet() {
  const changes = vi.fn<ExternalStore['changes']>(() =>
    Promise.resolve({ changes: [], epoch: 'quiet', floor: 0, head: 0 }),
  );
  return { changes, store: logStore(changes) };
}

describe('the stores of the authority', () => {
  it('are none an engine is given: it reads the store its database brings', async () => {
    const brought = quiet();
    const given = quiet();
    const engine = new Engine({
      buildId: BUILD,
      database: itemsReadThrough(brought.store),
      externalPollMs: 60_000,
      programs: [],
      // @ts-expect-error -- `stores` is no option of the engine's.
      stores: { remote: given.store },
    });
    onTestFinished(async () => {
      await engine.close();
    });

    await engine.poke();

    expect(brought.changes).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
    expect(given.changes).not.toHaveBeenCalled();
  });

  it('are none an authority is started with: it reads the store its database brings', async () => {
    const brought = quiet();
    const given = quiet();
    const authority = await startAuthority({
      buildId: BUILD,
      database: itemsReadThrough(brought.store),
      externalPollMs: 60_000,
      programs: [],
      // @ts-expect-error -- `stores` is no option of the authority's.
      stores: { remote: given.store },
    });
    onTestFinished(async () => {
      await authority.close();
    });

    await authority.engine.poke();

    expect(brought.changes).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
    expect(given.changes).not.toHaveBeenCalled();
  });
});

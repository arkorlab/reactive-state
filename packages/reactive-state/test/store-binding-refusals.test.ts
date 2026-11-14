import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { Value } from '../src/program.ts';
import { displayValue } from '../src/runtime/operations.ts';
import { PageStore, type Send, type WriteTarget } from '../src/runtime/store.ts';
import { frameAt, receipt, refusal } from './support/page.ts';

/**
 * A refusal of a binding itself — the session may no longer write through it, its target is gone
 * or changed — drops each operation of the binding not made yet, which would be refused alike. One
 * already committed stays shown on top of each frame that does not reflect it, as any committed
 * operation does, until every frame of its session does: the root still showing an older frame
 * would else show the write undone.
 */

const TITLE = 'todos:t1:title';
const SESSION = 'session:alice';
const FIRST = frameAt(1, { [TITLE]: 'Plan' });

/** A store naming its operations `op-1`, `op-2`, …, let go of when the test ends. */
function storeWith(onRefused: () => void): PageStore {
  let named = 0;
  const store = new PageStore({
    id: () => {
      named += 1;
      return `op-${String(named)}`;
    },
    onRefused,
    retryDelay: 1,
  });
  onTestFinished(() => {
    store.dispose();
  });
  return store;
}

/** `t1`'s title, written through its binding. */
function title(send: Send): WriteTarget {
  return { binding: 'binding:title:t1', field: TITLE, send, session: SESSION, updaterId: 'u_set' };
}

/** The title a page rendered with the first frame shows. */
function shown(store: PageStore): Value | undefined {
  return displayValue(FIRST, SESSION, store.pendingOf(TITLE), TITLE);
}

describe('a refusal of a binding', () => {
  it.each([
    ['the session may no longer write through it', refusal(403, 'FORBIDDEN', 'No longer yours.')],
    ['its target is gone', refusal(404, 'NOT_FOUND', 'There is no such record.')],
    ['its target changed', refusal(409, 'TARGET_CHANGED', 'What this writes to has changed.')],
  ])(
    'keeps shown a committed write of the binding a root does not reflect yet, where %s',
    async (_why, refused) => {
      const onRefused = vi.fn<() => void>();
      const send = vi
        .fn<Send>()
        .mockResolvedValueOnce(receipt('op-1', 2))
        .mockResolvedValueOnce(refused);
      const store = storeWith(onRefused);
      store.attach('list', FIRST, SESSION);
      store.attach('details', FIRST, SESSION);
      store.set({ ...title(send), value: 'Plan A' });
      await sleep(0);
      // The list shows the commit; the details are still on their way to it.
      store.attach('list', frameAt(2, { [TITLE]: 'Plan A' }), SESSION);
      store.set({ ...title(send), value: 'Plan B' });
      await vi.waitFor(() => {
        expect(onRefused).toHaveBeenCalledExactlyOnceWith();
      });

      expect(shown(store)).toBe('Plan A');
      expect(store.getStatus().pending).toBe(1);

      store.attach('details', frameAt(2, { [TITLE]: 'Plan A' }), SESSION);

      expect(store.getStatus().pending).toBe(0);
    },
  );

  // A pin, which passes before the change as well: every operation of the binding not made yet
  // is dropped with the one refused.
  it('drops each operation of the binding not made yet', async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce(refusal(403, 'FORBIDDEN', 'No longer yours.'))
      .mockResolvedValue(receipt('op-2', 2));
    const store = storeWith(vi.fn<() => void>());
    store.attach('root', FIRST, SESSION);
    store.set({ ...title(send), value: 'Plan A' });
    store.set({ ...title(send), value: 'Plan B' });
    await vi.waitFor(() => {
      expect(store.getStatus().pending).toBe(0);
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(shown(store)).toBe('Plan');
  });
});

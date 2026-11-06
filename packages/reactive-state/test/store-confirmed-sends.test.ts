import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { FieldReceipt, Result } from '../src/program.ts';
import { PageStore, type Send } from '../src/runtime/store.ts';
import { deferred, frameAt } from './support/page.ts';

/**
 * Operations are sent one at a time, each once the one before is answered — or once a frame names
 * it: a frame says it committed, before any write made after it is sent, which commits after it,
 * and its answer, when it comes, would say nothing more. A send that nothing answered nor named
 * holds those after it, as ever.
 */

const TITLE = 'todos:t1:title';
const SESSION = 'session:alice';
const FIRST = frameAt(1, { [TITLE]: 'Plan' });

/** A store naming its operations `op-1`, `op-2`, …, whose transport answers none of them. */
function storeWith(): {
  readonly store: PageStore;
  readonly send: ReturnType<typeof vi.fn<Send>>;
} {
  let named = 0;
  const store = new PageStore({
    id: () => {
      named += 1;
      return `op-${String(named)}`;
    },
    retryDelay: 1,
  });
  onTestFinished(() => {
    store.dispose();
  });
  return { send: vi.fn<Send>(async () => deferred<Result<FieldReceipt>>().promise), store };
}

/** Writes `value` to `t1`'s title through its binding. */
function write({ send, store }: ReturnType<typeof storeWith>, value: string): void {
  store.set({
    binding: 'binding:title:t1',
    field: TITLE,
    send,
    session: SESSION,
    updaterId: 'u_set',
    value,
  });
}

describe('a send a frame names before its answer', () => {
  it('holds no write made after it, once every root shows the commit', async () => {
    const page = storeWith();
    page.store.attach('root', FIRST, SESSION);
    write(page, 'Plan A');
    page.store.attach('root', frameAt(2, { [TITLE]: 'Plan A' }, { operations: ['op-1'] }), SESSION);
    await sleep(0);

    write(page, 'Plan B');
    await sleep(0);

    expect(page.send.mock.calls.map(([operation]) => operation.operationId)).toStrictEqual([
      'op-1',
      'op-2',
    ]);
  });

  it('holds no write made after it, while a root still on its way to the commit shows it on top', async () => {
    const page = storeWith();
    page.store.attach('list', FIRST, SESSION);
    page.store.attach('details', FIRST, SESSION);
    write(page, 'Plan A');
    page.store.attach('list', frameAt(2, { [TITLE]: 'Plan A' }, { operations: ['op-1'] }), SESSION);
    await sleep(0);

    expect(page.store.getStatus().pending).toBe(1);

    write(page, 'Plan B');
    await sleep(0);

    expect(page.send).toHaveBeenCalledTimes(2);
  });

  // A pin, which passes before the change as well: a send nothing answered nor named holds the
  // writes made after it.
  it('is one nothing named, which holds the writes after it', async () => {
    const page = storeWith();
    page.store.attach('root', FIRST, SESSION);
    write(page, 'Plan A');
    page.store.attach('root', frameAt(2, { [TITLE]: 'Plan' }), SESSION);
    write(page, 'Plan B');
    page.store.resume();
    await sleep(0);

    expect(page.send).toHaveBeenCalledTimes(1);
  });
});

import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { FieldReceipt, Result } from '../src/program.ts';
import { Page } from '../src/runtime/page.ts';
import type { RefreshTarget } from '../src/runtime/refresh.ts';
import type { Send } from '../src/runtime/store.ts';
import { deferred, frameAt, receipt } from './support/page.ts';

/**
 * A commit of one of the page's writes that a frame tells of first — before the write's receipt
 * comes, or where none comes, its answer lost — is the page's to know as a receipt's is: every root
 * renders that revision, which each must reflect before the store lets the write go, and a frame
 * a link's prefetch carried shows at once no older than it (`carriedFloor`).
 */

const TITLE = 'todos:t1:title';
const SESSION = 'session:alice';

/** A page naming its one operation `op-1`, let go of when the test ends. */
function opened(): Page {
  const page = new Page({ id: () => 'op-1', retryDelay: 1 });
  onTestFinished(() => {
    page.dispose();
  });
  return page;
}

/** What a root is told to render again for. */
function told(): RefreshTarget & {
  readonly want: ReturnType<typeof vi.fn<(revision: number) => void>>;
} {
  return {
    force: vi.fn<() => void>(),
    refresh: vi.fn<() => void>(),
    want: vi.fn<(revision: number) => void>(),
  };
}

/** Shows the root `rootKey` at `revision`, naming `operations`, as a render of it attaches. */
function show(
  page: Page,
  rootKey: string,
  revision: number,
  options: { readonly target?: RefreshTarget; readonly operations?: readonly string[] } = {},
): void {
  page.attach(rootKey, {
    ...(options.target ?? told()),
    frame: frameAt(
      revision,
      { [TITLE]: 'Plan' },
      { operations: options.operations ?? [], rootKey },
    ),
    session: SESSION,
  });
}

/** Writes the title through `send`. */
function write(page: Page, send: Send): void {
  page.store.set({
    binding: 'binding:title:t1',
    field: TITLE,
    send,
    session: SESSION,
    updaterId: 'u_set',
    value: 'Plan A',
  });
}

describe('a commit a frame tells of first', () => {
  it('is past what a carried frame shows at once at, though the receipt comes after', async () => {
    const page = opened();
    show(page, 'root:a', 1);
    const answer = deferred<Result<FieldReceipt>>();
    write(page, async () => answer.promise);
    // The root shows the commit: nothing holds the write back any more.
    show(page, 'root:a', 2, { operations: ['op-1'] });

    expect(page.store.getStatus().pending).toBe(0);

    answer.resolve(receipt('op-1', 2));
    await sleep(0);

    expect(page.carriedFloor('root:b')).toBe(2);
  });

  it('has every root render its revision, where the write’s answer was lost', async () => {
    const page = opened();
    const other = told();
    show(page, 'root:a', 1);
    show(page, 'root:b', 1, { target: other });
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error('The answer was lost on its way back.'))
      .mockImplementation(async () => deferred<Result<FieldReceipt>>().promise);
    write(page, send);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    show(page, 'root:a', 2, { operations: ['op-1'] });

    expect(other.want).toHaveBeenCalledWith(2);
    expect(page.carriedFloor('root:c')).toBe(2);
  });
});

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Page } from '../src/runtime/page.ts';
import type { Send } from '../src/runtime/store.ts';
import { frameAt } from './support/page.ts';

/**
 * How old a frame a link's prefetch carried may be and still show at once (`carriedFloor`): no
 * older than the page showed that very root, than the roots it let go of the memory of, nor than a
 * write of the page's own committed at — which an older frame would show undone.
 */

/** A page, let go of when the test ends. */
function opened(): Page {
  const page = new Page();
  onTestFinished(() => {
    page.dispose();
  });
  return page;
}

/** Shows the root `rootKey` on `page` at `revision`, as a render of it attaches. */
function show(page: Page, rootKey: string, revision: number): void {
  page.attach(rootKey, {
    force: vi.fn(),
    frame: frameAt(revision, {}, { rootKey }),
    refresh: vi.fn(),
    session: 'a',
    want: vi.fn(),
  });
}

describe('what a carried frame shows at once at', () => {
  it('is the newest the page showed the root at, and none of a root it never showed', () => {
    const page = opened();
    show(page, 'root:a', 10);
    show(page, 'root:a', 4);

    expect(page.carriedFloor('root:a')).toBe(10);
    expect(page.carriedFloor('root:b')).toBe(-Infinity);
  });

  it('is the newest of the roots the page let go of the memory of, for one of them', () => {
    const page = opened();
    show(page, 'root:first', 40);
    // As many more as the page remembers, which lets the first go.
    for (let each = 0; each < 256; each += 1) {
      show(page, `root:${String(each)}`, 1);
    }

    expect(page.carriedFloor('root:first')).toBe(40);
    expect(page.carriedFloor('root:never')).toBe(40);
  });

  it('is past a write of the page’s own, which an older frame would show undone', async () => {
    const page = opened();
    show(page, 'root:a', 10);
    const committed = Promise.withResolvers<undefined>();
    const send = vi.fn<Send>((operation) => {
      committed.resolve(undefined);
      return Promise.resolve({
        ok: true,
        value: { committedRevision: 25, deduplicated: false, operationId: operation.operationId },
      });
    });
    page.store.set({
      binding: 'binding:title',
      field: 'title',
      send,
      session: 'a',
      updaterId: 'set',
      value: 'mine',
    });
    await committed.promise;
    await vi.waitFor(() => {
      expect(page.carriedFloor('root:a')).toBe(25);
    });

    expect(page.carriedFloor('root:b')).toBe(25);
  });
});

/** A catch-up still under way, which no answer ends. */
async function underWay(): Promise<never> {
  return new Promise<never>(() => {
    // Never answered.
  });
}

describe('what a root that has not shown waits for', () => {
  it('is kept for each root still waiting, however many there are at once', () => {
    const page = opened();
    const render = vi.fn<() => Promise<never>>(underWay);
    const asked = Array.from({ length: 17 }, (_, each) =>
      page.catchUp(`key:${String(each)}`, render),
    );

    // The first root asks again, as a root that has not shown yet asks on each of its renders.
    const again = page.catchUp('key:0', render);

    expect(again).toBe(asked[0]);
    expect(render).toHaveBeenCalledTimes(17);
  });

  it('lets go of an answered one no root took, past the most it keeps', async () => {
    const page = opened();
    await page.catchUp(
      'key:answered',
      vi.fn<() => Promise<string>>().mockResolvedValue('answered'),
    );
    const waiting = Array.from({ length: 16 }, (_, each) =>
      page.catchUp(`key:${String(each)}`, underWay),
    );
    const asked = vi.fn<() => Promise<string>>().mockResolvedValue('asked again');

    // Kept no longer: the navigation it was asked for was let go of before its root showed.
    await expect(page.catchUp('key:answered', asked)).resolves.toBe('asked again');
    expect(asked).toHaveBeenCalledTimes(1);
    expect(waiting).toHaveLength(16);
  });
});

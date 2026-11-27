import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { FieldReceipt, Frame, Result } from '../src/program.ts';
import type { KeptRoot } from '../src/runtime/kept-roots.ts';
import { Page } from '../src/runtime/page.ts';
import type { Send } from '../src/runtime/store.ts';
import { frameAt, receipt, refusal } from './support/page.ts';

/**
 * How old a frame a link's prefetch carried may be and still show at once (`carriedFloor`): no
 * older than the page showed that very root, than the roots it let go of the memory of, nor than a
 * write of the page's own committed at — which an older frame would show undone. And what the page
 * keeps of a root it shows no more, to show at once in place of an older frame of it (`kept`).
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

/** Shows `frame` of its root for `session`, as a render of the root `root` attaches it. */
function attached(page: Page, frame: Frame, session = 'a', root = frame.rootKey): void {
  page.attach(root, { force: vi.fn(), frame, refresh: vi.fn(), session, want: vi.fn() });
}

/** What a root showed of `frame` for `session`: its tree named by the frame's revision. */
function shownOf(frame: Frame, session = 'a'): KeptRoot<string> {
  return { children: `tree@${String(frame.revision)}`, frame, session };
}

/** Shows `frame` of its root for `session`, then lets the root `root` go as it shows it. */
function left(page: Page, frame: Frame, session = 'a', root = frame.rootKey): void {
  attached(page, frame, session, root);
  page.detach(root, shownOf(frame, session));
}

/** A frame of the root `rootKey`, of no site and no field, at `revision`. */
function plainAt(revision: number, rootKey = 'root:a'): Frame {
  return frameAt(revision, {}, { rootKey });
}

/** Writes a field through the page's store, the write answered `answer`. */
function write(page: Page, answer: Result<FieldReceipt>): void {
  page.store.set({
    binding: 'binding:title',
    field: 'title',
    send: vi.fn<Send>().mockResolvedValue(answer),
    session: 'a',
    updaterId: 'set',
    value: 'mine',
  });
}

describe('what the page keeps of a root it shows no more', () => {
  it('is the root’s render as it was let go of, by its root key', () => {
    const page = opened();
    left(page, plainAt(5));

    expect(page.kept('root:a')).toStrictEqual({
      children: 'tree@5',
      frame: plainAt(5),
      session: 'a',
    });
    expect(page.kept('root:b')).toBeUndefined();
  });

  it('is nothing of a root rendered for a site, of a field, or that no stream follows', () => {
    const page = opened();
    left(page, frameAt(5, {}, { rootKey: 'root:site', view: { part: { d0: { id: 't1' } } } }));
    left(page, frameAt(5, { title: 'Plan' }, { rootKey: 'root:field' }));
    left(page, frameAt(5, {}, { rootKey: 'root:unfollowed', subscription: '' }));

    expect(page.kept('root:site')).toBeUndefined();
    expect(page.kept('root:field')).toBeUndefined();
    expect(page.kept('root:unfollowed')).toBeUndefined();
  });

  it('is of the 16 roots let go of last, the least recently kept forgotten', () => {
    const page = opened();
    for (let each = 0; each < 17; each += 1) {
      left(page, plainAt(5, `root:${String(each)}`));
    }
    // Kept again, which makes it the most recent: the next one lets another go.
    left(page, plainAt(5, 'root:1'));
    left(page, plainAt(5, 'root:17'));

    expect(page.kept('root:0')).toBeUndefined();
    expect(page.kept('root:2')).toBeUndefined();
    expect(page.kept('root:1')?.children).toBe('tree@5');
    expect(page.kept('root:3')?.children).toBe('tree@5');
  });

  it('is the newer of two renders of a root let go of, by two roots that showed it, as the newer’s', () => {
    const page = opened();
    left(page, plainAt(7), 'a', 'r1');
    left(page, plainAt(5), 'a', 'r2');

    expect(page.kept('root:a')?.children).toBe('tree@7');

    // A newer one still, of the second root: its own, which the first showing it lets stay.
    left(page, plainAt(9), 'a', 'r2');
    attached(page, plainAt(9), 'a', 'r1');

    expect(page.kept('root:a')?.children).toBe('tree@9');

    attached(page, plainAt(9), 'a', 'r2');

    expect(page.kept('root:a')).toBeUndefined();
  });

  it('is, of two of one revision, the tree shown last, as the first root’s to let go of', () => {
    const page = opened();
    left(page, plainAt(5), 'a', 'r1');
    // A root shown from it, its tree changed since at that revision — a render that reads the time
    // — let go of and shown again, as React's development mount does.
    attached(page, plainAt(5), 'a', 'r2');
    page.detach('r2', { children: 'second@5', frame: plainAt(5), session: 'a' });
    attached(page, plainAt(5), 'a', 'r2');

    expect(page.kept('root:a')?.children).toBe('second@5');

    // The root that kept it first, on the page again.
    attached(page, plainAt(5), 'a', 'r1');

    expect(page.kept('root:a')).toBeUndefined();
  });

  it('is let go of as the root that kept it shows that root again, and kept as another does', () => {
    const page = opened();
    left(page, plainAt(5), 'a', 'r1');
    // Another root showing it — what the page kept, say: kept still, for a third.
    attached(page, plainAt(5), 'a', 'r2');

    expect(page.kept('root:a')?.children).toBe('tree@5');

    // The root that kept it on the page again: StrictMode's second mount, a route shown again.
    attached(page, plainAt(5), 'a', 'r1');

    expect(page.kept('root:a')).toBeUndefined();
  });

  it('is what a root showed before another root key took its place, the root shown still', () => {
    const page = opened();
    attached(page, plainAt(5), 'a', 'r1');
    page.keep('r1', shownOf(plainAt(5)));
    // Kept of the session the page shows alone.
    page.keep('r1', shownOf(plainAt(5, 'root:b'), 'b'));
    attached(page, plainAt(6, 'root:c'), 'a', 'r1');

    expect(page.kept('root:a')?.children).toBe('tree@5');
    expect(page.kept('root:b')).toBeUndefined();
  });

  it('is nothing older than the page showed that root at since, or a write of its own committed at', async () => {
    const page = opened();
    left(page, plainAt(5));
    left(page, plainAt(5, 'root:b'));
    // The root shown newer since, by another root that shows it still.
    attached(page, plainAt(7), 'a', 'r2');
    write(page, receipt('op', 6));
    await vi.waitFor(() => {
      expect(page.carriedFloor('root:b')).toBe(6);
    });

    expect(page.kept('root:a')).toBeUndefined();
    expect(page.kept('root:b')).toBeUndefined();
  });

  it('is nothing of another session than the page shows, and forgotten as it shows another', () => {
    const page = opened();
    left(page, plainAt(5));
    // A frame of another session older than the page's newest: the page stays the first's.
    left(page, plainAt(4, 'root:b'), 'b');

    expect(page.kept('root:b')).toBeUndefined();

    // Another session's newer frame, then the first's again: neither keeps what was before.
    attached(page, plainAt(6, 'root:c'), 'b');
    attached(page, plainAt(8, 'root:d'));

    expect(page.store.session).toBe('a');
    expect(page.kept('root:a')).toBeUndefined();
  });

  it.each([
    [
      'its stream says the session ended',
      (page: Page) => {
        page.revoked('The session ended.');
      },
    ],
    [
      'its stream says the build is another',
      (page: Page) => {
        page.revoked('The application was updated.', 'BUILD_MISMATCH');
      },
    ],
    [
      'a write is refused the session',
      (page: Page) => {
        write(page, refusal(401, 'UNAUTHENTICATED', 'Sign in first.'));
      },
    ],
    [
      'a write is refused for its build',
      (page: Page) => {
        write(page, refusal(409, 'BUILD_MISMATCH', 'Updated.'));
      },
    ],
  ])('is forgotten once %s', async (_, end) => {
    const page = opened();
    left(page, plainAt(5));
    end(page);
    // Revoked either way: a reload asked for sends nothing more either.
    await vi.waitFor(() => {
      expect(page.store.getStatus().revoked).toBe(true);
    });

    expect(page.kept('root:a')).toBeUndefined();
  });
});

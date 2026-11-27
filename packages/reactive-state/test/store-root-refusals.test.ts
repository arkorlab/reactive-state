import { describe, expect, it, type Mock, onTestFinished, vi } from 'vitest';

import type { FieldReceipt, Frame, Result } from '../src/program.ts';
import { Page } from '../src/runtime/page.ts';
import type { Send, WriteTarget } from '../src/runtime/store.ts';
import { deferred, frameAt, receipt, refusal } from './support/page.ts';

/**
 * A root's own refusal — the application's `refuse(code)` of the root's render, which the root's
 * stream was refused with as it opened (422, and the application's code) — revokes the page's store,
 * and has the route rendered again, where the application draws the refusal in the root's place.
 * The session stands, though: the revocation holds while the refused root still shows what it
 * showed, and is let go of once that root is gone or shows another frame, and the page shows a frame
 * of the session that it did not show as the refusal came — a later page's roots, the refreshed
 * route's. The page's writes are kept through it, and sent once it is let go of, and what the page
 * said of them before it is said again. A session that ended and the framework's other refusals
 * stay revoked until the page shows another session, and a build the authority no longer runs until
 * the page is reloaded.
 */

const TITLE = 'todos:t1:title';
const SESSION = 'session:alice';
const REFUSED = 'You are no longer a member of this team.';
const UPDATED = 'The application was updated. Reload the page.';
const CHECKING = 'Checking whether the change was saved.';
/** What a client answers where it heard nothing of the authority: the write's outcome is unknown. */
const UNAVAILABLE = refusal(503, 'AUTHORITY_UNAVAILABLE', 'The authority could not be reached.');
const TEAM = 'root:team-a';
/** The team's frame, a layout's root, as it showed when its stream was refused. */
const FIRST = frameAt(1, { [TITLE]: 'Plan' }, { rootKey: TEAM });

/** A page naming its operations `op-1`, `op-2`, …, what renders its route again, and its roots. */
interface Opened {
  readonly page: Page;
  readonly force: Mock<() => void>;
  readonly refresh: Mock<() => void>;
  readonly want: Mock<(revision: number) => void>;
}

/** A page, which resumes a store gone offline after `recoveryDelay` unless a render says sooner. */
function opened(recoveryDelay?: number): Opened {
  let named = 0;
  const page = new Page({
    id: () => {
      named += 1;
      return `op-${String(named)}`;
    },
    ...(recoveryDelay !== undefined && { recoveryDelay }),
    retryDelay: 1,
  });
  onTestFinished(() => {
    page.dispose();
  });
  return {
    force: vi.fn<() => void>(),
    page,
    refresh: vi.fn<() => void>(),
    want: vi.fn<(revision: number) => void>(),
  };
}

/** Shows `frame` as the root `root` of the page, rendered for Alice's session. */
function show({ force, page, refresh, want }: Opened, root: string, frame: Frame): void {
  page.attach(root, { force, frame, refresh, session: SESSION, want });
}

/** A frame of another root of the session — the main column, another team's — at `revision`. */
function otherAt(revision: number, rootKey = 'root:main'): Frame {
  return frameAt(revision, { [TITLE]: 'Plan' }, { rootKey });
}

/** `t1`'s title, written through its binding. */
function title(send: Send): WriteTarget {
  return { binding: 'binding:title:t1', field: TITLE, send, session: SESSION, updaterId: 'u_set' };
}

describe('a root’s own refusal', () => {
  it('stops the page until the refused root shows another frame, and takes writes again', async () => {
    const shown = opened();
    const { page, refresh } = shown;
    show(shown, 'sidebar', FIRST);
    const send = vi.fn<Send>().mockResolvedValue(receipt('op-1', 2));

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');

    expect(page.store.getStatus()).toMatchObject({ error: REFUSED, pending: 0, revoked: true });
    expect(page.store.set({ ...title(send), value: 'Plan B' })).toBeUndefined();
    expect(refresh).toHaveBeenCalledExactlyOnceWith();

    // The layout's root shows another team's page, at the revision the page showed: no write was
    // behind the refusal.
    show(shown, 'sidebar', otherAt(1, 'root:team-b'));

    expect(page.store.getStatus()).toMatchObject({
      error: null,
      mismatched: false,
      revoked: false,
    });
    expect(page.store.set({ ...title(send), value: 'Plan B' })).toBe('op-1');

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });

    expect(refresh).toHaveBeenCalledExactlyOnceWith();
  });

  it('holds while the refused root shows what it showed, however another root renders, and goes once it is gone', () => {
    const shown = opened();
    const { page } = shown;
    show(shown, 'sidebar', FIRST);
    show(shown, 'main', otherAt(1));

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    // The refreshed route: the refused root kept the frame it showed — a site of inputs the page
    // chose was refused, which the route's render of the states' first values passes — and the
    // other root renders anew.
    show(shown, 'main', otherAt(2));

    expect(page.store.getStatus()).toMatchObject({ error: REFUSED, revoked: true });

    page.detach('sidebar');

    expect(page.store.getStatus()).toMatchObject({ error: null, revoked: false });
  });

  it('goes as the refused root is replaced, with the first frame the page did not show then', () => {
    const shown = opened();
    const { page } = shown;
    show(shown, 'sidebar', FIRST);
    show(shown, 'main', otherAt(1));

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    // The application's boundary drew the refusal in the refused root's place.
    page.detach('sidebar');

    expect(page.store.getStatus()).toMatchObject({ error: REFUSED, revoked: true });

    // A later page's root.
    show(shown, 'next', otherAt(1, 'root:team-b'));

    expect(page.store.getStatus()).toMatchObject({ error: null, revoked: false });
  });

  it('goes as the refused root shows a newer frame of its own, or one older than the page showed', () => {
    const newer = opened();
    show(newer, 'sidebar', FIRST);
    newer.page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    show(newer, 'sidebar', frameAt(2, { [TITLE]: 'Plan' }, { rootKey: TEAM }));

    // One a link's prefetch carried, older than the page's newest, of another team.
    const older = opened();
    show(older, 'sidebar', frameAt(5, { [TITLE]: 'Plan' }, { rootKey: TEAM }));
    older.page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    show(older, 'sidebar', otherAt(2, 'root:team-b'));

    expect(newer.page.store.getStatus()).toMatchObject({ error: null, revoked: false });
    expect(older.page.store.getStatus()).toMatchObject({ error: null, revoked: false });
  });

  it('says a second root’s refusal, and renders the route again for it, holding until each refused root is gone or shows another frame', () => {
    const shown = opened();
    const { page, refresh } = shown;
    show(shown, 'sidebar', FIRST);
    show(shown, 'main', otherAt(1));

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    page.revoked('Team B is closed.', 'TEAM_CLOSED', 'main');

    // The route renders again for the second root too, whose boundary would else never draw.
    expect(page.store.getStatus()).toMatchObject({ error: 'Team B is closed.', revoked: true });
    expect(refresh).toHaveBeenCalledTimes(2);

    show(shown, 'main', otherAt(2));

    expect(page.store.getStatus()).toMatchObject({ error: 'Team B is closed.', revoked: true });

    page.detach('sidebar');

    expect(page.store.getStatus()).toMatchObject({ error: null, revoked: false });
  });

  it('has every root render again with the route, once for each root refused, and for no session’s end', () => {
    const shown = opened();
    const { force, page, refresh } = shown;
    show(shown, 'sidebar', FIRST);
    show(shown, 'main', otherAt(1));

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');

    // Each of the two roots: one may show the newest revision already, of a view the route's
    // render does not cover, and would ask for nothing again.
    expect(force).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    page.revoked('Team B is closed.', 'TEAM_CLOSED', 'main');

    expect(force).toHaveBeenCalledTimes(4);
    expect(refresh).toHaveBeenCalledTimes(2);

    page.revoked('The session ended.', 'UNAUTHENTICATED', 'main');

    expect(force).toHaveBeenCalledTimes(4);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('holds by the frame a root showed as it was refused, though rendered after the hold began', () => {
    const shown = opened();
    const { page } = shown;
    show(shown, 'sidebar', FIRST);
    show(shown, 'aside', otherAt(1, 'root:aside'));
    show(shown, 'main', otherAt(1));

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    // The aside renders anew while the sidebar holds the page, and is refused showing that frame.
    show(shown, 'aside', otherAt(2, 'root:aside'));
    page.revoked('The aside is closed.', 'ASIDE_CLOSED', 'aside');
    page.detach('sidebar');
    show(shown, 'main', otherAt(2));

    expect(page.store.getStatus()).toMatchObject({ error: 'The aside is closed.', revoked: true });

    page.detach('aside');

    expect(page.store.getStatus()).toMatchObject({ error: null, revoked: false });
  });

  it('renders nothing again, and says nothing new, for a root already refused', () => {
    const shown = opened();
    const { page, refresh } = shown;
    show(shown, 'sidebar', FIRST);

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    page.revoked('Refused again.', 'NOT_IN_TEAM', 'sidebar');

    expect(page.store.getStatus()).toMatchObject({ error: REFUSED, revoked: true });
    expect(refresh).toHaveBeenCalledExactlyOnceWith();
  });

  it('counts a frame another root rendered after the first refusal though a second came after it', () => {
    const shown = opened();
    const { page } = shown;
    show(shown, 'sidebar', FIRST);
    show(shown, 'main', otherAt(1));
    show(shown, 'aside', otherAt(1, 'root:aside'));

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    // The main column renders anew while the sidebar holds the page; then the aside is refused.
    show(shown, 'main', otherAt(2));
    page.revoked('The aside is closed.', 'ASIDE_CLOSED', 'aside');
    page.detach('sidebar');

    expect(page.store.getStatus()).toMatchObject({ revoked: true });

    page.detach('aside');

    expect(page.store.getStatus()).toMatchObject({ error: null, revoked: false });
  });

  it('is let go of by none of the frames the page showed as it came, shown again', () => {
    const shown = opened();
    const { page } = shown;
    const main = otherAt(1);
    show(shown, 'sidebar', FIRST);
    show(shown, 'main', main);

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    // A root attached again with its frame, one shown in another's place, and the refused root
    // mounted again with the frame it showed — a route the router kept, gone back to.
    show(shown, 'sidebar', FIRST);
    show(shown, 'aside', main);
    page.detach('sidebar');
    show(shown, 'sidebar', FIRST);

    expect(page.store.getStatus()).toMatchObject({ error: REFUSED, revoked: true });

    show(shown, 'sidebar', frameAt(1, { [TITLE]: 'Plan' }, { rootKey: TEAM }));

    expect(page.store.getStatus()).toMatchObject({ error: null, revoked: false });
  });

  it('is let go of by no frame of another session the page does not move to', () => {
    const shown = opened();
    const { page } = shown;
    show(shown, 'sidebar', frameAt(5, { [TITLE]: 'Plan' }, { rootKey: TEAM }));

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    page.detach('sidebar');
    page.attach('other', {
      force: vi.fn(),
      frame: frameAt(3, { [TITLE]: 'Plan' }, { rootKey: 'root:bob' }),
      refresh: vi.fn(),
      session: 'session:bob',
      want: vi.fn(),
    });

    expect(page.store.getStatus()).toMatchObject({ error: REFUSED, revoked: true });
    expect(page.store.session).toBe(SESSION);
  });

  it('renders the route again for a refusal after one let go of, as the first', () => {
    const shown = opened();
    const { page, refresh } = shown;
    show(shown, 'sidebar', FIRST);

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    show(shown, 'sidebar', otherAt(2, 'root:team-b'));
    page.revoked('Team B is closed.', 'TEAM_CLOSED', 'sidebar');

    expect(page.store.getStatus()).toMatchObject({ error: 'Team B is closed.', revoked: true });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('the page’s writes through a root’s own refusal', () => {
  it('keeps them, hears the answer on its way, sends nothing more, and sends the rest once it is let go of, a refusal of them said', async () => {
    const shown = opened();
    const { page, want } = shown;
    show(shown, 'sidebar', FIRST);
    show(shown, 'main', otherAt(1));
    const first = deferred<Result<FieldReceipt>>();
    const send = vi
      .fn<Send>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(refusal(422, 'NOT_IN_TEAM', 'Not a member: the title was not saved.'));
    // A write on its way, and the newest text behind it: an `apply` never gives way.
    page.store.apply({ ...title(send), captures: {}, predict: (value) => value });
    page.store.set({ ...title(send), value: 'Plan B' });

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');

    expect(page.store.getStatus()).toMatchObject({ error: REFUSED, pending: 2, revoked: true });
    expect(page.store.pendingOf(TITLE).map(({ id }) => id)).toStrictEqual(['op-1', 'op-2']);

    first.resolve(receipt('op-1', 2));
    await vi.waitFor(() => {
      expect(want).toHaveBeenCalledWith(2);
    });

    expect(send).toHaveBeenCalledTimes(1);

    page.detach('sidebar');
    show(shown, 'main', otherAt(2));

    expect(page.store.getStatus()).toMatchObject({ error: null, revoked: false });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    expect(send.mock.calls.map(([operation]) => operation.operationId)).toStrictEqual([
      'op-1',
      'op-2',
    ]);

    // The write behind it was the refused root's: the authority's replay refuses it, and the page
    // says so, as of any write refused.
    await vi.waitFor(() => {
      expect(page.store.getStatus()).toMatchObject({
        error: 'Not a member: the title was not saved.',
        pending: 0,
        revoked: false,
      });
    });
  });

  it('sends the writes it kept at the detach that lets it go, though no frame attaches after', async () => {
    const shown = opened();
    const { page, want } = shown;
    show(shown, 'sidebar', FIRST);
    show(shown, 'main', otherAt(1));
    const first = deferred<Result<FieldReceipt>>();
    const send = vi
      .fn<Send>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(receipt('op-2', 3));
    page.store.apply({ ...title(send), captures: {}, predict: (value) => value });
    page.store.set({ ...title(send), value: 'Plan B' });

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    first.resolve(receipt('op-1', 2));
    await vi.waitFor(() => {
      expect(want).toHaveBeenCalledWith(2);
    });
    show(shown, 'main', otherAt(2));

    expect(send).toHaveBeenCalledTimes(1);

    page.detach('sidebar');

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it('resumes a write that went offline while it held, and sends it at the detach that lets it go', async () => {
    const shown = opened(1);
    const { page } = shown;
    show(shown, 'sidebar', FIRST);
    show(shown, 'main', otherAt(1));
    const third = deferred<Result<FieldReceipt>>();
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockReturnValueOnce(third.promise)
      .mockResolvedValue(receipt('op-1', 2));
    page.store.set({ ...title(send), value: 'Plan B' });
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(3);
    });
    const resumed = vi.spyOn(page.store, 'resume');

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    // The third send's outcome is unknown too: the store goes offline as the refusal holds, and the
    // page's recovery resumes it meanwhile, which sends nothing while the refusal holds.
    third.resolve(UNAVAILABLE);
    await vi.waitFor(() => {
      expect(resumed).toHaveBeenCalledWith();
    });
    // The refreshed route: the other root renders anew, and the refused root still holds the page.
    show(shown, 'main', otherAt(2));

    expect(send).toHaveBeenCalledTimes(3);
    expect(page.store.getStatus()).toMatchObject({ revoked: true });

    page.detach('sidebar');

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(4);
    });
    await vi.waitFor(() => {
      expect(page.store.getStatus()).toMatchObject({ offline: false, pending: 0, revoked: false });
    });
  });

  it('resumes a write that was offline as it came, with its sends afresh, once it is let go of', async () => {
    const shown = opened(50);
    const { page } = shown;
    show(shown, 'sidebar', FIRST);
    show(shown, 'main', otherAt(1));
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockResolvedValue(receipt('op-1', 2));
    page.store.set({ ...title(send), value: 'Plan B' });
    // Three sends of unknown outcome: the store is offline, its recovery due a wait later.
    await vi.waitFor(
      () => {
        expect(page.store.getStatus().offline).toBe(true);
      },
      { interval: 1 },
    );
    const resumed = vi.spyOn(page.store, 'resume');

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    // The page's recovery resumes the store while the refusal holds.
    await vi.waitFor(() => {
      expect(resumed).toHaveBeenCalledWith();
    });
    let wentOffline = false;
    page.store.subscribe(() => {
      wentOffline ||= page.store.getStatus().offline;
    });
    show(shown, 'main', otherAt(2));
    page.detach('sidebar');

    // One more outcome unknown is sent again, as after any outage resumed: the store stays online.
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(5);
    });
    await vi.waitFor(() => {
      expect(page.store.getStatus()).toMatchObject({ offline: false, pending: 0, revoked: false });
    });

    expect(wentOffline).toBe(false);
  });

  it('says again, once it is let go of, what the page said of a write still unanswered', async () => {
    const shown = opened();
    const { page } = shown;
    show(shown, 'sidebar', FIRST);
    show(shown, 'main', otherAt(1));
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce(UNAVAILABLE)
      .mockReturnValue(deferred<Result<FieldReceipt>>().promise);
    page.store.set({ ...title(send), value: 'Plan B' });
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    expect(page.store.getStatus().error).toBe(CHECKING);

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');

    expect(page.store.getStatus()).toMatchObject({ error: REFUSED, pending: 1, revoked: true });

    show(shown, 'main', otherAt(2));
    page.detach('sidebar');

    expect(page.store.getStatus()).toMatchObject({ error: CHECKING, pending: 1, revoked: false });
  });

  it('drops them all at a session’s end after it', () => {
    const shown = opened();
    const { page } = shown;
    show(shown, 'sidebar', FIRST);
    const unanswered = vi.fn<Send>(async () => deferred<Result<FieldReceipt>>().promise);
    page.store.set({ ...title(unanswered), value: 'B' });

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    page.revoked('The session ended.', 'UNAUTHENTICATED', 'sidebar');

    expect(page.store.getStatus()).toMatchObject({ error: 'The session ended.', pending: 0 });
  });
});

describe('a refusal that is no root’s own', () => {
  it('keeps a session that ended revoked through every frame of it, until another session’s', () => {
    const shown = opened();
    const { page } = shown;
    show(shown, 'sidebar', FIRST);

    page.revoked('Sign in again.', 'UNAUTHENTICATED', 'sidebar');
    page.detach('sidebar');
    show(shown, 'main', otherAt(3));

    expect(page.store.getStatus()).toMatchObject({ error: 'Sign in again.', revoked: true });

    page.attach('main', {
      force: vi.fn(),
      frame: frameAt(4, { [TITLE]: 'Plan' }, { rootKey: 'root:bob' }),
      refresh: vi.fn(),
      session: 'session:bob',
      want: vi.fn(),
    });

    expect(page.store.getStatus()).toMatchObject({ error: null, revoked: false });
  });

  it.each([
    ['no code', undefined],
    ['a subscription not the session’s (403)', 'FORBIDDEN'],
    ['a component the authority does not run (404)', 'UNKNOWN_COMPONENT'],
    ['nothing served (404)', 'NOT_FOUND'],
    ['a subscription not named (400)', 'INVALID_SUBSCRIPTION'],
    ['an answer the client could not read', 'AUTHORITY_ERROR'],
    ['a code of no code’s shape', 'not-in-team'],
  ])('keeps %s revoked through every frame of the session', (_what, code) => {
    const shown = opened();
    const { page } = shown;
    show(shown, 'sidebar', FIRST);

    page.revoked('Refused.', code, 'sidebar');
    page.detach('sidebar');
    show(shown, 'main', otherAt(2));

    expect(page.store.getStatus()).toMatchObject({ error: 'Refused.', revoked: true });
  });

  it('keeps a reload asked for through every frame, another session’s too', () => {
    const shown = opened();
    const { page } = shown;
    show(shown, 'sidebar', FIRST);

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    page.revoked('The application was updated.', 'BUILD_MISMATCH', 'sidebar');
    page.detach('sidebar');
    show(shown, 'main', otherAt(2));
    page.attach('other', {
      force: vi.fn(),
      frame: frameAt(3, { [TITLE]: 'Plan' }, { rootKey: 'root:bob' }),
      refresh: vi.fn(),
      session: 'session:bob',
      want: vi.fn(),
    });

    expect(page.store.getStatus()).toMatchObject({
      error: UPDATED,
      mismatched: true,
      revoked: true,
    });
  });

  it.each([
    ['a session’s end', 'UNAUTHENTICATED'],
    ['a subscription not the session’s (403)', 'FORBIDDEN'],
    ['nothing served (404)', 'NOT_FOUND'],
    ['no code', undefined],
  ])(
    'replaces a root’s own refusal where %s comes after it: said, rendered again for, and held',
    (_what, code) => {
      const shown = opened();
      const { page, refresh } = shown;
      show(shown, 'sidebar', FIRST);

      page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
      page.revoked('Refused for good.', code, 'sidebar');
      page.detach('sidebar');
      show(shown, 'main', otherAt(2));

      expect(page.store.getStatus()).toMatchObject({ error: 'Refused for good.', revoked: true });
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );

  it('stays a session’s end where a root’s own refusal comes after it', () => {
    const shown = opened();
    const { page, refresh } = shown;
    show(shown, 'sidebar', FIRST);

    page.revoked('The session ended.', 'UNAUTHENTICATED', 'sidebar');
    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    page.detach('sidebar');
    show(shown, 'main', otherAt(2));

    expect(page.store.getStatus()).toMatchObject({ error: 'The session ended.', revoked: true });
    expect(refresh).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('what the page reads of a stream that says `revoked`', () => {
  it('reads a root’s own refusal of its code, the application’s own, and of the root that heard it', () => {
    const shown = opened();
    const { page } = shown;
    show(shown, 'sidebar', FIRST);

    page.revoked(REFUSED, 'NOT_IN_TEAM', 'sidebar');
    show(shown, 'sidebar', otherAt(2, 'root:team-b'));

    expect(page.store.getStatus()).toMatchObject({ error: null, revoked: false });

    // A code of the application's own that names no root is the session's end: nothing lets it go.
    page.revoked(REFUSED, 'NOT_IN_TEAM');
    show(shown, 'sidebar', otherAt(3, 'root:team-c'));

    expect(page.store.getStatus()).toMatchObject({ error: REFUSED, revoked: true });

    page.revoked('The application was updated.', 'BUILD_MISMATCH', 'sidebar');

    expect(page.store.getStatus()).toMatchObject({ error: UPDATED, mismatched: true });
  });
});

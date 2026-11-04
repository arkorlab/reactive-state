import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { FieldOperation, FieldReceipt, Frame, Result, Value } from '../src/program.ts';
import { Follower, revisionOf } from '../src/runtime/follow.ts';
import { toJson } from '../src/runtime/json.ts';
import { displayValue, type Predictor } from '../src/runtime/operations.ts';
import { Refresher, type RefreshTarget } from '../src/runtime/refresh.ts';
import { PageStore, type Send, type StoreOptions, type WriteTarget } from '../src/runtime/store.ts';
import {
  deferred,
  FakeEventSource,
  forgetSources,
  frameAt,
  opened,
  receipt,
  refusal,
} from './support/page.ts';

/** The fields of the item `t1` the suites write, and the session that writes them. */
const ESTIMATE = 'todos:t1:estimate';
const TITLE = 'todos:t1:title';
const SESSION = 'session:alice';

/** A store naming its operations `op-1`, `op-2`, … and retrying an unknown outcome at once. */
function storeWith(options: Partial<StoreOptions> = {}): PageStore {
  let named = 0;
  const store = new PageStore({
    id: () => {
      named += 1;
      return `op-${String(named)}`;
    },
    retryDelay: 1,
    ...options,
  });
  onTestFinished(() => {
    store.dispose();
  });
  return store;
}

/** Where an operation goes: `t1`'s estimate through its binding, unless said otherwise. */
function target(send: Send, overrides: Partial<WriteTarget> = {}): WriteTarget {
  return {
    binding: 'binding:estimate:t1',
    field: ESTIMATE,
    send,
    session: SESSION,
    updaterId: 'u_add',
    ...overrides,
  };
}

/** A registered update of the estimate, as the compiler predicts one: adding `amount`. */
function plus(amount: number): Predictor {
  return (value) => Number(value) + amount;
}

/** The value a page rendered with `frame` shows of `field`. */
function shown(store: PageStore, frame: Frame, field = ESTIMATE): Value | undefined {
  return displayValue(frame, SESSION, store.pendingOf(field), field);
}

/** A transport whose operations are never answered. */
const unanswered: Send = async () => deferred<Result<FieldReceipt>>().promise;

/** A transport that answers each operation with the next of `answers`. */
function inOrder(...answers: readonly Promise<Result<FieldReceipt>>[]): Send {
  const queue = [...answers];
  return () => queue.shift() ?? Promise.reject(new Error('No answer is left for this operation.'));
}

/** The operations a transport was handed, in order. */
function sent(send: ReturnType<typeof vi.fn<Send>>): readonly FieldOperation[] {
  return send.mock.calls.map(([operation]) => operation);
}

const FIRST = frameAt(1, { [ESTIMATE]: 2, [TITLE]: 'Plan' });

describe('the page store', () => {
  it('shows an operation at once, on top of the frame it leaves as it is', () => {
    const store = storeWith();
    store.attach('root', FIRST, SESSION);

    const id = store.apply({ ...target(unanswered), captures: { step: 1 }, predict: plus(1) });

    expect(id).toBe('op-1');
    expect(shown(store, FIRST)).toBe(3);
    expect(FIRST.fields[ESTIMATE]).toBe(2);
    expect(store.getStatus()).toMatchObject({ error: null, pending: 1 });
  });

  it('keeps an acknowledged operation shown until a frame reflects it, and shows it once then', async () => {
    const answer = deferred<Result<FieldReceipt>>();
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    store.apply({ ...target(inOrder(answer.promise)), captures: { step: 1 }, predict: plus(1) });

    answer.resolve(receipt('op-1', 2));
    await sleep(0);

    expect(shown(store, FIRST)).toBe(3);

    const second = frameAt(2, { [ESTIMATE]: 3 });

    expect(shown(store, second)).toBe(3);

    store.attach('root', second, SESSION);

    expect(store.getStatus().pending).toBe(0);
    expect(shown(store, second)).toBe(3);
  });

  it('shows an operation once when the frame that names it arrives before its acknowledgement (T12)', async () => {
    const answer = deferred<Result<FieldReceipt>>();
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    store.apply({ ...target(inOrder(answer.promise)), captures: { step: 1 }, predict: plus(1) });
    const named = frameAt(2, { [ESTIMATE]: 3 }, { operations: ['op-1'] });

    expect(shown(store, named)).toBe(3);

    store.attach('root', named, SESSION);
    answer.resolve(receipt('op-1', 2));
    await sleep(0);

    expect(shown(store, named)).toBe(3);
    expect(store.getStatus()).toMatchObject({ error: null, pending: 0 });
  });

  it('sends an operation whose outcome is unknown again under its id, and shows it once (T12)', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error('The network went away.'))
      .mockResolvedValueOnce(refusal(503, 'AUTHORITY_UNAVAILABLE', 'The authority did not answer.'))
      .mockResolvedValueOnce(receipt('op-1', 2));
    const store = storeWith();
    store.attach('root', FIRST, SESSION);

    store.apply({ ...target(send), captures: { step: 1 }, predict: plus(1) });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(3);
    });

    expect(sent(send).map(({ operationId }) => operationId)).toStrictEqual([
      'op-1',
      'op-1',
      'op-1',
    ]);
    expect(shown(store, FIRST)).toBe(3);
    expect(shown(store, frameAt(2, { [ESTIMATE]: 3 }))).toBe(3);
  });

  it('stops checking an operation whose answer was lost once a frame says it committed (T12)', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error('The answer was lost on its way back.'))
      .mockImplementation(unanswered);
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    store.apply({ ...target(send), captures: { step: 1 }, predict: plus(1) });
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    expect(store.getStatus().error).toBe('Checking whether the change was saved.');

    const named = frameAt(2, { [ESTIMATE]: 3 }, { operations: ['op-1'] });
    store.attach('root', named, SESSION);

    expect(store.getStatus()).toMatchObject({ error: null, pending: 0 });
    expect(shown(store, named)).toBe(3);
  });

  it('keeps checking while an operation whose answer was lost is named by no frame', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error('The answer was lost on its way back.'))
      .mockImplementation(unanswered);
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    store.apply({ ...target(send), captures: { step: 1 }, predict: plus(1) });
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    store.attach('root', frameAt(2, { [ESTIMATE]: 2 }), SESSION);

    expect(store.getStatus()).toMatchObject({
      error: 'Checking whether the change was saved.',
      pending: 1,
    });
  });

  it('goes offline after three unknown outcomes, and sends again from the first attempt on resuming', async () => {
    const onOffline = vi.fn();
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(receipt('op-1', 2));
    const store = storeWith({ onOffline });
    store.attach('root', FIRST, SESSION);

    store.apply({ ...target(send), captures: {}, predict: plus(1) });

    await vi.waitFor(() => {
      expect(onOffline).toHaveBeenCalledExactlyOnceWith();
    });

    expect(store.getStatus()).toMatchObject({ offline: true, pending: 1 });
    expect(store.apply({ ...target(send), captures: {}, predict: plus(1) })).toBeUndefined();
    expect(store.getStatus().error).toBe('Not connected. Try again once the connection is back.');

    store.resume();

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(4);
    });

    expect(store.getStatus()).toMatchObject({ error: null, offline: false });
  });

  it('resumes once a root shows a frame rendered while it was offline', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(receipt('op-1', 2));
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    store.apply({ ...target(send), captures: {}, predict: plus(1) });
    await vi.waitFor(() => {
      expect(store.getStatus().offline).toBe(true);
    });

    store.attach('root', frameAt(2, { [ESTIMATE]: 2 }), SESSION);

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(4);
    });
  });

  it('gives an operation up once it has failed through three recoveries, as one that may have been made', async () => {
    const send = vi.fn<Send>(() => Promise.reject(new Error('The authority failed.')));
    const onRefused = vi.fn();
    const held: { store?: PageStore } = {};
    const store = storeWith({
      onOffline: () => {
        setTimeout(() => {
          held.store?.resume();
        }, 0);
      },
      onRefused,
    });
    held.store = store;
    store.attach('root', FIRST, SESSION);

    store.apply({ ...target(send), captures: {}, predict: plus(1) });

    await vi.waitFor(() => {
      expect(store.getStatus().pending).toBe(0);
    });

    expect(send).toHaveBeenCalledTimes(9);
    // Whether it was made, a frame says: the page renders again for one.
    expect(store.getStatus().error).toBe(
      'The change may have been saved: check the page before making it again.',
    );
    expect(onRefused).toHaveBeenCalledExactlyOnceWith();
    expect(shown(store, FIRST)).toBe(2);
  });

  it('drops a refused operation alone, and applies the ones after it again', async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce(refusal(422, 'INVALID_VALUE', 'The estimate is too large.'))
      .mockResolvedValueOnce(receipt('op-2', 2));
    const store = storeWith();
    store.attach('root', FIRST, SESSION);

    store.apply({ ...target(send), captures: { step: 10 }, predict: plus(10) });
    store.apply({ ...target(send), captures: { step: 1 }, predict: plus(1) });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    expect(shown(store, FIRST)).toBe(3);
    expect(store.getStatus()).toMatchObject({ error: null, pending: 1 });
    expect(sent(send).map(({ operationId }) => operationId)).toStrictEqual(['op-1', 'op-2']);
  });

  it('drops every operation of a binding the authority refused, and sends the others (T10)', async () => {
    const onRefused = vi.fn();
    const answers = new Map([
      ['binding:estimate:t1', receipt('op-3', 2)],
      ['binding:title:t1', refusal(403, 'FORBIDDEN', 'You may no longer edit this todo.')],
    ]);
    const send = vi.fn<Send>((operation) =>
      Promise.resolve(answers.get(operation.binding) ?? refusal(500, 'FAULT', 'unexpected')),
    );
    const store = storeWith({ onRefused });
    store.attach('root', FIRST, SESSION);
    const title = target(send, { binding: 'binding:title:t1', field: TITLE, updaterId: 'u_set' });

    store.set({ ...title, value: 'Plan A' });
    store.set({ ...title, value: 'Plan B' });
    store.apply({ ...target(send), captures: { step: 1 }, predict: plus(1) });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    expect(sent(send).map(({ binding }) => binding)).toStrictEqual([
      'binding:title:t1',
      'binding:estimate:t1',
    ]);
    expect(shown(store, FIRST, TITLE)).toBe('Plan');
    expect(shown(store, FIRST)).toBe(3);
    expect(store.getStatus()).toMatchObject({ error: null, pending: 1, revoked: false });
    expect(onRefused).toHaveBeenCalledExactlyOnceWith();
  });

  it('says a write whose send went unanswered may have been made, though a resend of it is refused', async () => {
    const onRefused = vi.fn();
    // The first send may have committed — a write that took its own access away, say — and the
    // resend is refused for what it did.
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(refusal(403, 'FORBIDDEN', 'You may no longer edit this todo.'));
    const store = storeWith({ onRefused });
    store.attach('root', FIRST, SESSION);

    store.apply({ ...target(send), captures: { step: 1 }, predict: plus(1) });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    expect(store.getStatus()).toMatchObject({
      error: 'The change may have been saved: check the page before making it again.',
      pending: 0,
    });
    expect(onRefused).toHaveBeenCalledExactlyOnceWith();
  });

  it('drops a write a `unique` group refused alone, and sends the one of its binding after it', async () => {
    const onRefused = vi.fn();
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce(
        refusal(409, 'UNIQUE_VIOLATION', 'Another record of todos holds the same title.'),
      )
      .mockResolvedValueOnce(receipt('op-2', 2));
    const store = storeWith({ onRefused });
    store.attach('root', FIRST, SESSION);
    const title = target(send, { binding: 'binding:title:t1', field: TITLE, updaterId: 'u_set' });

    store.set({ ...title, value: 'Taken' });
    store.set({ ...title, value: 'Free' });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    expect(sent(send).map(({ value }) => value)).toStrictEqual(['Taken', 'Free']);
    expect(shown(store, FIRST, TITLE)).toBe('Free');
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('is revoked for the whole page by a refusal of the session, once', async () => {
    const onRevoked = vi.fn();
    const store = storeWith({ onRevoked });
    store.attach('root', FIRST, SESSION);
    const send = vi.fn<Send>().mockResolvedValue(refusal(401, 'UNAUTHENTICATED', 'Sign in again.'));

    store.apply({ ...target(send), captures: {}, predict: plus(1) });
    store.set({ ...target(send, { field: TITLE, updaterId: 'u_set' }), value: 'Plan B' });

    await vi.waitFor(() => {
      expect(store.getStatus().revoked).toBe(true);
    });
    store.revoke();

    expect(store.getStatus()).toMatchObject({
      error: 'Sign in again.',
      mismatched: false,
      pending: 0,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(onRevoked).toHaveBeenCalledExactlyOnceWith();
    expect(store.set({ ...target(send), value: 5 })).toBeUndefined();
  });

  it('asks for a reload when an operation is refused for another build', async () => {
    const onRevoked = vi.fn();
    const store = storeWith({ onRevoked });
    store.attach('root', FIRST, SESSION);
    const send = vi
      .fn<Send>()
      .mockResolvedValue(refusal(409, 'BUILD_MISMATCH', 'The application was updated.'));

    store.apply({ ...target(send), captures: {}, predict: plus(1) });

    await vi.waitFor(() => {
      expect(store.getStatus().mismatched).toBe(true);
    });

    expect(store.getStatus()).toMatchObject({
      error: 'The application was updated. Reload the page.',
      pending: 0,
      revoked: true,
    });
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('sends the newest of the sets made while one is on its way, never every keystroke', async () => {
    const first = deferred<Result<FieldReceipt>>();
    const second = Promise.resolve(receipt('op-3', 3));
    const send = vi.fn(inOrder(first.promise, second));
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    const title = target(send, { binding: 'binding:title:t1', field: TITLE, updaterId: 'u_set' });

    store.set({ ...title, value: 'P' });
    store.set({ ...title, value: 'Pl' });
    store.set({ ...title, value: 'Pla' });

    expect(shown(store, FIRST, TITLE)).toBe('Pla');
    expect(store.getStatus().pending).toBe(2);

    first.resolve(receipt('op-1', 2));
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    expect(sent(send)).toStrictEqual([
      { binding: 'binding:title:t1', operationId: 'op-1', updaterId: 'u_set', value: 'P' },
      { binding: 'binding:title:t1', operationId: 'op-3', updaterId: 'u_set', value: 'Pla' },
    ]);
  });

  it('never lets an apply give way, and sends each with what its call captured (T11)', async () => {
    const send = vi.fn<Send>((operation) => Promise.resolve(receipt(operation.operationId, 2)));
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    const captured = { step: 1 };

    store.apply({ ...target(send), captures: captured, predict: plus(1) });
    captured.step = 5;
    store.apply({ ...target(send), captures: captured, predict: plus(5) });

    expect(shown(store, FIRST)).toBe(8);

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    expect(sent(send).map(({ captures }) => captures)).toStrictEqual([{ step: 1 }, { step: 5 }]);
  });

  it('shows 7 for "set 5, +1, set 7": a set gives way only to a set right behind it', () => {
    const send = vi.fn(unanswered);
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    const set = target(send, { updaterId: 'u_set_estimate' });
    store.apply({ ...target(send), captures: {}, predict: plus(1) });

    store.set({ ...set, value: 5 });
    store.apply({ ...target(send), captures: {}, predict: plus(1) });

    expect(shown(store, FIRST)).toBe(6);

    store.set({ ...set, value: 7 });

    expect(shown(store, FIRST)).toBe(7);
    expect(store.getStatus().pending).toBe(4);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('takes a set while offline in place of the one before it, and sends it on resuming', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(receipt('op-1', 2));
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    const title = target(send, { binding: 'binding:title:t1', field: TITLE, updaterId: 'u_set' });
    store.set({ ...title, value: 'P' });
    await vi.waitFor(() => {
      expect(store.getStatus().offline).toBe(true);
    });

    store.set({ ...title, value: 'Pl' });
    store.set({ ...title, value: 'Pla' });

    expect(shown(store, FIRST, TITLE)).toBe('Pla');
    expect(store.getStatus().pending).toBe(2);

    store.resume();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(5);
    });

    expect(sent(send).map(({ operationId }) => operationId)).toStrictEqual([
      'op-1',
      'op-1',
      'op-1',
      'op-1',
      'op-3',
    ]);
  });

  it('drops the operations of another session once a newer frame of a new one is shown, and shows them on none of its frames', () => {
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    store.apply({ ...target(unanswered), captures: {}, predict: plus(1) });
    const bobs = frameAt(2, { [ESTIMATE]: 2 }, { rootKey: 'root:p1:bob' });

    expect(displayValue(bobs, 'session:bob', store.pendingOf(ESTIMATE), ESTIMATE)).toBe(2);

    store.attach('root', bobs, 'session:bob');

    expect(store.getStatus().pending).toBe(0);
    expect(store.session).toBe('session:bob');
  });

  it('keeps the page in the newer session when an older frame of the one before is shown again', () => {
    const store = storeWith();
    store.attach('root', frameAt(5, { [ESTIMATE]: 2 }), 'session:bob');
    store.apply({
      ...target(unanswered, { session: 'session:bob' }),
      captures: {},
      predict: plus(1),
    });

    store.attach('hidden', FIRST, SESSION);

    expect(store.session).toBe('session:bob');
    expect(store.getStatus().pending).toBe(1);
  });

  it('lets an operation go once every root of its session reflects it', async () => {
    const store = storeWith();
    store.attach('list', FIRST, SESSION);
    store.attach('details', FIRST, SESSION);
    store.apply({
      ...target(() => Promise.resolve(receipt('op-1', 2))),
      captures: {},
      predict: plus(1),
    });
    await sleep(0);

    store.attach('list', frameAt(2, { [ESTIMATE]: 3 }), SESSION);

    expect(store.getStatus().pending).toBe(1);

    store.attach('details', frameAt(2, { [ESTIMATE]: 3 }), SESSION);

    expect(store.getStatus().pending).toBe(0);
  });

  it('takes no failure for an operation a frame has settled, whatever its answer then says', async () => {
    const answer = deferred<Result<FieldReceipt>>();
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    store.apply({ ...target(inOrder(answer.promise)), captures: {}, predict: plus(1) });

    store.attach('root', frameAt(2, { [ESTIMATE]: 3 }, { operations: ['op-1'] }), SESSION);
    answer.reject(new Error('The connection dropped after the commit.'));
    await sleep(0);

    expect(store.getStatus()).toMatchObject({ error: null, offline: false, pending: 0 });
  });

  it('settles an operation by revision when the frame’s bounded list has let go of it', async () => {
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    store.apply({
      ...target(() => Promise.resolve(receipt('op-1', 2))),
      captures: {},
      predict: plus(1),
    });
    await sleep(0);
    const later = frameAt(9, { [ESTIMATE]: 3 });

    expect(shown(store, later)).toBe(3);

    store.attach('root', later, SESSION);

    expect(store.getStatus().pending).toBe(0);
  });

  it('hands each field the same array of operations until one of them changes', () => {
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    store.apply({ ...target(unanswered), captures: {}, predict: plus(1) });
    const estimates = store.pendingOf(ESTIMATE);
    const titles = store.pendingOf(TITLE);

    store.set({ ...target(unanswered, { field: TITLE, updaterId: 'u_set' }), value: 'Plan B' });

    expect(store.pendingOf(ESTIMATE)).toBe(estimates);
    expect(store.pendingOf(TITLE)).not.toBe(titles);
    expect(store.pendingOf(TITLE)).toHaveLength(1);
  });

  it('sends each operation through the transport it was made with', async () => {
    const one = vi.fn<Send>(() => Promise.resolve(receipt('op-1', 2)));
    const other = vi.fn<Send>(() => Promise.resolve(receipt('op-2', 3)));
    const store = storeWith();
    store.attach('root', FIRST, SESSION);

    store.apply({ ...target(one), captures: {}, predict: plus(1) });
    store.apply({ ...target(other), captures: {}, predict: plus(1) });

    await vi.waitFor(() => {
      expect(other).toHaveBeenCalledTimes(1);
    });

    expect(one).toHaveBeenCalledTimes(1);
  });

  it('refuses an operation past its limit of pending ones, without throwing', () => {
    const store = storeWith();
    store.attach('root', FIRST, SESSION);
    for (let made = 0; made < 64; made += 1) {
      store.apply({ ...target(unanswered), captures: {}, predict: plus(1) });
    }

    expect(store.apply({ ...target(unanswered), captures: {}, predict: plus(1) })).toBeUndefined();
    expect(store.getStatus()).toMatchObject({
      error: 'Too many unconfirmed changes.',
      pending: 64,
    });
  });

  it('refuses to send what an update captured that JSON would not carry as it is', () => {
    const store = storeWith();
    store.attach('root', FIRST, SESSION);

    expect(() => {
      return store.apply({
        ...target(unanswered),
        captures: { at: new Date(0) } as never,
        predict: plus(1),
      });
    }).toThrow(TypeError);
    expect(store.getStatus().pending).toBe(0);
  });

  it('names an operation without `crypto.randomUUID`, which only a secure origin has', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const store = new PageStore();
    onTestFinished(() => {
      store.dispose();
    });
    store.attach('root', FIRST, SESSION);

    expect(store.apply({ ...target(unanswered), captures: {}, predict: plus(1) })).toMatch(
      /^[\da-f]{32}$/u,
    );
  });
});

describe('what a page shows of a field', () => {
  it('leaves the value as it was where a prediction throws', () => {
    const pending = [
      {
        committedRevision: null,
        field: ESTIMATE,
        id: 'op-1',
        kind: 'apply',
        predict: () => {
          throw new Error('The prediction failed.');
        },
        session: SESSION,
      },
      {
        committedRevision: null,
        field: ESTIMATE,
        id: 'op-2',
        kind: 'apply',
        predict: plus(1),
        session: SESSION,
      },
    ] as const;

    expect(displayValue(FIRST, SESSION, pending, ESTIMATE)).toBe(3);
  });
});

/** A root the refresher tells to render again, and what it was told. */
function rootTold(): RefreshTarget & {
  readonly want: ReturnType<typeof vi.fn<(revision: number) => void>>;
  readonly force: ReturnType<typeof vi.fn<() => void>>;
  readonly refresh: ReturnType<typeof vi.fn<() => void>>;
} {
  return {
    force: vi.fn<() => void>(),
    refresh: vi.fn<() => void>(),
    want: vi.fn<(revision: number) => void>(),
  };
}

describe('the refresher', () => {
  it('tells every root of a revision a write committed at, and has every root render again when forced', () => {
    const refresher = new Refresher();
    const list = rootTold();
    const details = rootTold();
    refresher.attach('list', list);
    refresher.attach('details', details);

    refresher.want(4);
    refresher.force();

    for (const root of [list, details]) {
      expect(root.want).toHaveBeenCalledExactlyOnceWith(4);
      expect(root.force).toHaveBeenCalledExactlyOnceWith();
      expect(root.refresh).not.toHaveBeenCalled();
    }
  });

  it('renders the route again once for the page, through the root attached last', () => {
    const refresher = new Refresher();
    const list = rootTold();
    const details = rootTold();
    refresher.attach('list', list);
    refresher.attach('details', details);

    refresher.refresh();

    expect(list.refresh).not.toHaveBeenCalled();
    expect(details.refresh).toHaveBeenCalledExactlyOnceWith();
  });

  it('tells a root it no longer renders nothing', () => {
    const refresher = new Refresher();
    const list = rootTold();
    refresher.attach('list', list);
    refresher.detach('list');

    refresher.want(2);
    refresher.force();
    refresher.refresh();

    expect(list.want).not.toHaveBeenCalled();
    expect(list.force).not.toHaveBeenCalled();
    expect(list.refresh).not.toHaveBeenCalled();
  });
});

/** A follower of the stream `url` names, and what it reported. */
function following(url: () => string): {
  readonly follower: Follower;
  readonly frames: number[];
  readonly revoked: (readonly [string | undefined, string | undefined])[];
} {
  vi.stubGlobal('EventSource', FakeEventSource);
  const frames: number[] = [];
  const revoked: (readonly [string | undefined, string | undefined])[] = [];
  const follower = new Follower({
    onFrame: (revision) => {
      frames.push(revision);
    },
    onRevoked: (message, code) => {
      revoked.push([message, code]);
    },
    retryDelay: 100,
    url,
  });
  follower.start();
  onTestFinished(() => {
    follower.stop();
  });
  return { follower, frames, revoked };
}

describe('the follower', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    forgetSources();
  });

  it('reads each frame event’s revision as the authority writes it, and nothing else', () => {
    const { frames } = following(() => 'http://localhost/api/reactive-state/events?subscription=a');
    const [source] = opened;

    source?.emit('frame', { revision: 3 });
    source?.emit('frame', { frame: { revision: 4 } });
    source?.emit('frame', { frame: { revision: 'five' } });

    expect(frames).toStrictEqual([4]);
    expect(revisionOf('not json')).toBeUndefined();
  });

  it('stops at `revoked`, and says why, with the authority’s code', () => {
    const { frames, revoked } = following(() => 'http://localhost/events?subscription=a');
    const [source] = opened;

    source?.emit('revoked', { code: 'UNAUTHENTICATED', error: 'The session ended.' });
    source?.emit('frame', { frame: { revision: 9 } });

    expect(revoked).toStrictEqual([['The session ended.', 'UNAUTHENTICATED']]);
    expect(frames).toStrictEqual([]);
    expect(source?.closed).toBe(true);
  });

  it('opens a failed stream again with the newest subscription, waiting longer each time', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let subscription = 'first';
    following(() => `http://localhost/events?subscription=${subscription}`);

    opened[0]?.fail();
    subscription = 'second';
    vi.advanceTimersByTime(99);

    expect(opened).toHaveLength(1);

    vi.advanceTimersByTime(1);

    expect(opened.map((source) => source.subscription)).toStrictEqual(['first', 'second']);
    expect(opened[0]?.closed).toBe(true);

    opened[1]?.fail();
    vi.advanceTimersByTime(199);

    expect(opened).toHaveLength(2);

    vi.advanceTimersByTime(1);

    expect(opened).toHaveLength(3);
  });

  it('waits the first wait again once a stream has stayed open a while', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    following(() => 'http://localhost/events?subscription=a');
    opened[0]?.fail();
    vi.advanceTimersByTime(100);
    opened[1]?.fail();
    vi.advanceTimersByTime(200);

    opened[2]?.open();
    vi.advanceTimersByTime(30_000);
    opened[2]?.fail();
    vi.advanceTimersByTime(100);

    expect(opened).toHaveLength(4);
  });

  it('opens nothing again once stopped', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { follower } = following(() => 'http://localhost/events?subscription=a');

    opened[0]?.fail();
    follower.stop();
    vi.advanceTimersByTime(1000);

    expect(opened).toHaveLength(1);
  });
});

/** `value`, of the debug information React's development build defines on it, not enumerated. */
function debugged<T extends unknown[]>(value: T): T {
  return Object.defineProperty(value, '_debugInfo', {
    configurable: false,
    enumerable: false,
    value: [{ name: 'Panels' }],
    writable: true,
  });
}

describe('jSON as it crosses to the authority', () => {
  it('copies JSON, leaving out an undefined property', () => {
    const value = { list: [1, 'a', null, { deep: true }], missing: undefined };

    expect(toJson(value)).toStrictEqual({ list: [1, 'a', null, { deep: true }] });
    expect(toJson(value)).not.toBe(value);
  });

  it.each([
    ['a function', { run: (): void => undefined }],
    ['a date', new Date(0)],
    ['NaN', NaN],
    ['an undefined item', [1, undefined]],
    // eslint-disable-next-line no-sparse-arrays -- the hole is what is refused
    ['a hole in an array', [1, , 3]],
    ['a map', new Map()],
    ['a bigint', 1n],
    ['an entry not enumerated', Object.defineProperty({ a: 1 }, 'hidden', { value: 2 })],
    ['raw JSON text', (JSON as unknown as { rawJSON: (text: string) => unknown }).rawJSON('1')],
    ['an array of a name of its own beside its elements', Object.assign([1], { extra: 'x' })],
    [
      'an entry an accessor computes',
      Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 }),
    ],
  ])('refuses %s', (_what, value) => {
    expect(() => toJson(value, 'The argument')).toThrow(TypeError);
  });

  it('copies an array of what React’s development build defines on it as it deserializes it, `_debugInfo`, leaving it out', () => {
    expect(toJson(debugged(['a', 'b']))).toStrictEqual(['a', 'b']);
    expect(toJson({ panels: debugged([{ id: 'p1' }]) })).toStrictEqual({ panels: [{ id: 'p1' }] });
  });

  it.each([
    [
      'of an object',
      (): unknown => Object.defineProperty({ id: 'p1' }, '_debugInfo', { value: [] }),
    ],
    [
      'an accessor computes',
      (): unknown => Object.defineProperty(['a'], '_debugInfo', { get: () => [] }),
    ],
    [
      'of what is no list',
      (): unknown => Object.defineProperty(['a'], '_debugInfo', { value: 'x', writable: true }),
    ],
    [
      'enumerated',
      (): unknown => Object.defineProperty(['a'], '_debugInfo', { enumerable: true, value: [] }),
    ],
  ])(
    'refuses an entry `_debugInfo` %s, which React’s development build defines none of',
    (_what, made) => {
      expect(() => toJson(made())).toThrow(TypeError);
    },
  );

  it('copies a `__proto__` key as a key of the copy’s own, and never as its prototype', () => {
    const value = JSON.parse('{"__proto__":{"admin":true},"name":"x"}') as unknown;
    const copied = toJson(value) as Readonly<Record<string, unknown>>;

    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.hasOwn(copied, '__proto__')).toBe(true);
    expect(JSON.stringify(copied)).toBe('{"__proto__":{"admin":true},"name":"x"}');
  });

  it('copies `-0` as `0`, as JSON writes it', () => {
    const copied = toJson({ step: -0 }) as Readonly<Record<string, number>>;

    expect(Object.is(copied['step'], 0)).toBe(true);
  });

  it('refuses a cycle', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;

    expect(() => toJson(cycle)).toThrow(/nested more than 64 levels/u);
  });
});

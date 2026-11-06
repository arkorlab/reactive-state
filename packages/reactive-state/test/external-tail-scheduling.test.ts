import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { ExternalTail } from '../src/authority/external-tail.ts';
import type { ExternalStore } from '../src/authority/external.ts';
import { ObjectAlarm, scheduleExternalAlarm } from '../src/cloudflare/alarm.ts';
import { database, definitionOf, table, text } from '../src/server/schema.ts';

/** An alarm's retry deadlines, independent of the next log read. */
const TIME = { poll: 1000, retry: 100, cap: 30_000, turns: 12 } as const;
const db = database({ items: table({ title: text() }, { external: 'remote' }) });
const tables = definitionOf(db).tables;

/** A pending host write, rejected only after the test has observed the answer. */
function pending() {
  const result = Promise.withResolvers<undefined>();
  // The unchanged implementation drops the host's promise; its failure is still expected here.
  void result.promise.catch(() => {
    /* The test asserts that this failure is retried. */
  });
  return result;
}

/** A tail with host alarms, recording every background promise kept by its host. */
function fixture(schedule: (at: number) => Promise<void>, stores = true) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {
    /* The test asserts each failure is logged. */
  });
  const changes = vi.fn(() => Promise.resolve({ changes: [], epoch: 'test', floor: 0, head: 0 }));
  const store: ExternalStore = {
    changes,
    count: () => Promise.resolve(0),
    find: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
  };
  const kept: Promise<unknown>[] = [];
  let retained = true;
  const tail = new ExternalTail({
    everyMs: TIME.poll,
    ingest: () => Promise.resolve(),
    keep: (work) => {
      kept.push(work);
    },
    retained: () => retained,
    schedule,
    stores: new Map(stores ? [['items', store]] : []),
    tables,
  });
  onTestFinished(() => {
    tail.stop();
    errors.mockRestore();
    vi.useRealTimers();
  });
  return {
    changes,
    errors,
    kept,
    tail,
    idle: () => {
      retained = false;
    },
  };
}

describe('external alarm scheduling', () => {
  it('retries an asynchronous failure without another request', async () => {
    const first = pending();
    const schedule = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const { errors, kept, tail } = fixture(schedule);
    tail.refresh();
    tail.refresh();

    expect(schedule).toHaveBeenCalledExactlyOnceWith(TIME.poll);

    first.reject(new Error('The first alarm write failed.'));
    await vi.advanceTimersByTimeAsync(TIME.retry);

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenLastCalledWith(TIME.poll);
    expect(errors).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('alarm write failed'));
    await expect(Promise.all(kept)).resolves.toHaveLength(2);

    await vi.advanceTimersByTimeAsync(TIME.cap);

    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('catches a synchronous scheduling failure and retries it', async () => {
    const schedule = vi.fn<(at: number) => Promise<void>>().mockResolvedValue(undefined);
    schedule.mockImplementationOnce(() => {
      throw new Error('A synchronous host failure.');
    });
    const { tail } = fixture(schedule);

    expect(() => {
      tail.refresh();
    }).not.toThrow();

    await vi.advanceTimersByTimeAsync(TIME.retry);

    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('backs off repeated failures with a bounded delay', async () => {
    const failed = Promise.reject(new Error('Unavailable alarm storage.'));
    void failed.catch(() => {
      /* The test asserts that this failure is retried. */
    });
    const schedule = vi.fn(() => failed);
    const { errors, tail } = fixture(schedule);
    tail.refresh();
    await vi.advanceTimersByTimeAsync(0);
    let delay: number = TIME.retry;
    for (let turn = 0; turn < TIME.turns; turn += 1) {
      const before = schedule.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);

      expect(schedule).toHaveBeenCalledTimes(before);

      await vi.advanceTimersByTimeAsync(1);

      expect(schedule).toHaveBeenCalledTimes(before + 1);

      delay = Math.min(delay * 2, TIME.cap);
    }

    expect(errors).toHaveBeenCalledTimes(schedule.mock.calls.length);
  });

  it.each(['stop', 'release'] as const)('cancels a retry on $0', async (reason) => {
    const first = pending();
    const schedule = vi.fn(() => first.promise);
    const { idle, kept, tail } = fixture(schedule);
    const release = tail.follow();
    first.reject(new Error('An alarm failure before cancellation.'));
    await vi.advanceTimersByTimeAsync(0);
    idle();
    const cancel = {
      release,
      stop: () => {
        tail.stop();
      },
    };
    cancel[reason]();
    await vi.advanceTimersByTimeAsync(TIME.cap);

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(Promise.all(kept)).resolves.toHaveLength(1);
  });

  it('notices expired retention at retry time without an incoming request', async () => {
    const first = pending();
    const schedule = vi.fn(() => first.promise);
    const { idle, kept, tail } = fixture(schedule);
    tail.refresh();
    first.reject(new Error('An alarm failure.'));
    await vi.advanceTimersByTimeAsync(0);
    idle();
    await vi.advanceTimersByTimeAsync(TIME.retry);

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(Promise.all(kept)).resolves.toHaveLength(1);
  });

  it('ignores an old rejection after a new arm at the same deadline succeeds', async () => {
    const first = pending();
    const schedule = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const { idle, tail } = fixture(schedule);
    const release = tail.follow();
    idle();
    release();
    tail.follow();
    await vi.advanceTimersByTimeAsync(0);
    first.reject(new Error('An obsolete attempt failed.'));
    await vi.advanceTimersByTimeAsync(TIME.retry);
    tail.refresh();

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule.mock.calls).toStrictEqual([[TIME.poll], [TIME.poll]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('arms the next deadline when a shared alarm runs during an older pending arm', async () => {
    const first = pending();
    const schedule = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const { changes, tail } = fixture(schedule);
    tail.refresh();
    vi.setSystemTime(TIME.poll);
    await tail.run();

    expect(changes).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls).toStrictEqual([[TIME.poll], [TIME.poll * 2]]);

    first.reject(new Error('The consumed deadline failed to arm.'));
    await vi.advanceTimersByTimeAsync(TIME.retry);
    tail.refresh();

    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('adds no timer or host work without an external store', async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const { kept, tail } = fixture(schedule, false);
    tail.refreshLater();
    tail.follow();
    await vi.advanceTimersByTimeAsync(TIME.cap);

    expect(schedule).not.toHaveBeenCalled();
    expect(kept).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns before storage confirmation and arms only after that confirmation', async () => {
    const confirmed = pending();
    const getAlarm = vi.fn(() => Promise.resolve(null));
    const setAlarm = vi.fn(() => Promise.resolve());
    const alarm = new ObjectAlarm({ getAlarm, setAlarm });
    const sync = vi.fn(() => confirmed.promise);
    const schedule = vi.fn((at: number) => scheduleExternalAlarm({ sync }, alarm, at));
    const { kept, tail } = fixture(schedule);

    tail.refresh();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(kept).toHaveLength(1);
    expect(getAlarm).not.toHaveBeenCalled();

    confirmed.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(kept);

    expect(setAlarm).toHaveBeenCalledExactlyOnceWith(TIME.poll);
  });

  it.each(['sync', 'setAlarm'] as const)(
    'recovers an actual $0 failure in the host alarm',
    async (stage) => {
      const sync = vi.fn(() => Promise.resolve());
      const setAlarm = vi.fn(() => Promise.resolve());
      const getAlarm = vi.fn(() => Promise.resolve(null));
      const failure = new Error(`The first ${stage} failed.`);
      const failing = { sync, setAlarm }[stage];
      failing.mockRejectedValueOnce(failure);
      const alarm = new ObjectAlarm({ getAlarm, setAlarm });
      const schedule = vi.fn((at: number) => scheduleExternalAlarm({ sync }, alarm, at));
      const { errors, kept, tail } = fixture(schedule);
      tail.refresh();
      await vi.advanceTimersByTimeAsync(0);

      expect(errors).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(failure.message));

      await vi.advanceTimersByTimeAsync(TIME.retry);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all(kept);

      expect(schedule).toHaveBeenCalledTimes(2);
      expect(setAlarm).toHaveBeenLastCalledWith(TIME.poll);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

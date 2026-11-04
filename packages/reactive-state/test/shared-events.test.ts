import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  SharedBacklog,
  sharedEventStream,
  sharedEventText,
} from '../src/authority/shared-events.ts';
import type { SharedEvent } from '../src/routing.ts';

/**
 * A shared view's event stream, as the Durable Object hands it over (`sharedEventStream`): each
 * event as it comes to a reader that keeps up; for one that is behind, only what its page still acts
 * on — the view's state, not a log of it (`SharedBacklog`) — and no heartbeat queued behind what it
 * has yet to take.
 */

const HEARTBEAT_MS = 1000;

const decoder = new TextDecoder();

function ready(epoch: number, generation: number): SharedEvent {
  return { epoch, generation, kind: 'ready' };
}

function denied(epoch: number): SharedEvent {
  return { epoch, kind: 'denied' };
}

/** The text of `events`, as a stream writes them. */
function textOf(...events: readonly SharedEvent[]): string {
  return events.map((event) => sharedEventText(event)).join('');
}

/** A following of a view whose page missed `missed`, which tells of each event `emit` is given. */
function following(missed: readonly SharedEvent[] = []): {
  readonly emit: (event: SharedEvent) => void;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
} {
  const listeners = new Set<(event: SharedEvent) => void>();
  const listen = (listener: (event: SharedEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const reader = sharedEventStream({ listen, missed }, HEARTBEAT_MS).getReader();
  onTestFinished(async () => {
    await reader.cancel();
  });
  return {
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    reader,
  };
}

/** The text of the reader's next chunk. */
async function nextText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read();
  return decoder.decode(value);
}

describe('a shared view’s event stream', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives a reader that keeps up each event as it comes', async () => {
    const { emit, reader } = following();

    await expect(nextText(reader)).resolves.toBe(': open\n\n');

    emit(ready(1, 2));

    await expect(nextText(reader)).resolves.toBe(textOf(ready(1, 2)));

    emit(ready(1, 3));

    await expect(nextText(reader)).resolves.toBe(textOf(ready(1, 3)));
  });

  it('holds for a reader that is behind only what its page still acts on, and no heartbeat', async () => {
    vi.useFakeTimers();
    const { emit, reader } = following([ready(1, 1)]);
    // Nothing read meanwhile: every generation of the epoch, heartbeats, a denial and what follows it.
    for (let generation = 2; generation <= 1000; generation += 1) {
      emit(ready(1, generation));
    }
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 10);
    emit(denied(2));
    emit(ready(2, 1001));
    emit(ready(2, 1002));

    await expect(nextText(reader)).resolves.toBe(': open\n\n');
    await expect(nextText(reader)).resolves.toBe(textOf(denied(2), ready(2, 1002)));

    // Caught up: a heartbeat is said again when it is due.
    const next = nextText(reader);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    await expect(next).resolves.toBe(': heartbeat\n\n');
  });
});

describe('what a shared view’s stream owes a page that is behind', () => {
  it.each([
    ['nothing', [], []],
    ['the newest ready', [ready(1, 1), ready(1, 3), ready(1, 2)], [ready(1, 3)]],
    ['the newest denial', [denied(2), denied(4), denied(3)], [denied(4)]],
    ['a denial, not a ready of the epoch it ended', [ready(1, 5), denied(2)], [denied(2)]],
    ['a denial, then a ready of its epoch', [denied(2), ready(2, 6)], [denied(2), ready(2, 6)]],
    ['the newest denial alone', [denied(2), ready(2, 6), denied(3)], [denied(3)]],
    ['a denial, then a ready of a later epoch', [ready(3, 1), denied(2)], [denied(2), ready(3, 1)]],
  ])('is %s', (_name, events: readonly SharedEvent[], owed: readonly SharedEvent[]) => {
    const backlog = new SharedBacklog();
    for (const event of events) {
      backlog.add(event);
    }

    expect(backlog.take()).toBe(textOf(...owed));
    // Taken: owed no more.
    expect(backlog.take()).toBe('');
  });
});

import type { SharedEvent } from '../routing.ts';

/** What a stream says as it opens, which no client reads as an event. */
export const SHARED_OPENING = ': open\n\n';
/** What a stream says when it has said nothing for a while, which no client reads as an event. */
export const SHARED_HEARTBEAT = ': heartbeat\n\n';

/**
 * A shared view's event, as its stream writes it: `ready`, with the generation and access epoch a
 * page is to fetch the view's published artifact for, or `denied`, with the epoch that ended what a
 * page holds.
 */
export function sharedEventText(event: SharedEvent): string {
  return event.kind === 'ready'
    ? `event: ready\ndata: ${JSON.stringify({ epoch: event.epoch, generation: event.generation })}\n\n`
    : `event: denied\ndata: ${JSON.stringify({ epoch: event.epoch })}\n\n`;
}

export type Ready = Extract<SharedEvent, { readonly kind: 'ready' }>;

/** Whether `a` is of a later epoch than `b`, or a later generation of the same. */
export function later(a: Ready, b: Ready): boolean {
  return a.epoch > b.epoch || (a.epoch === b.epoch && a.generation > b.generation);
}

/**
 * What a shared view's stream owes a page that has yet to take what it was sent. Its events are the
 * view's state, not a log of it: of what came meanwhile, only what the page still acts on is kept —
 * the denial of the newest epoch, and the newest `ready` of no epoch a denial ended, which is all
 * the page acts on of them (`react/shared-root.tsx`) — and said in that order once the page took
 * what it held. However slowly a page reads, its stream holds no more for it than that; a heartbeat
 * is not owed at all, as what the page takes next says the stream is alive.
 */
export class SharedBacklog {
  #denied: number | undefined;
  #ready: Ready | undefined;

  /** Notes `event`, in place of what it makes needless. */
  add(event: SharedEvent): void {
    if (event.kind === 'denied') {
      this.#denied = Math.max(event.epoch, this.#denied ?? event.epoch);
    } else if (this.#ready === undefined || later(event, this.#ready)) {
      this.#ready = event;
    }
    if (this.#ready !== undefined && this.#ready.epoch < (this.#denied ?? this.#ready.epoch)) {
      this.#ready = undefined;
    }
  }

  /** The text of what is owed, in the order a page acts on it (`''` for nothing), owing nothing after. */
  take(): string {
    const denied =
      this.#denied === undefined ? '' : sharedEventText({ epoch: this.#denied, kind: 'denied' });
    const ready = this.#ready === undefined ? '' : sharedEventText(this.#ready);
    this.#denied = undefined;
    this.#ready = undefined;
    return `${denied}${ready}`;
  }
}

/**
 * The text of a shared view's stream, as a byte stream: what the page missed, then each event, and
 * a heartbeat whenever it has said nothing for a while. Its reader's queue holds one chunk: what
 * comes while the reader has yet to take it is owed (`SharedBacklog`), and given it as it asks for
 * more; no heartbeat is queued behind it.
 */
export function sharedEventStream(
  followed: {
    readonly missed: readonly SharedEvent[];
    readonly listen: (listener: (event: SharedEvent) => void) => () => void;
  },
  heartbeatMs: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const owed = new SharedBacklog();
  let stop: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const end = (): void => {
    stop?.();
    clearInterval(heartbeat);
  };
  const say = (controller: ReadableStreamDefaultController<Uint8Array>, text: string): void => {
    if (text === '') {
      return;
    }
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      end();
    }
  };
  /** Whether the reader took what it was given: its queue has room. */
  const caughtUp = (controller: ReadableStreamDefaultController<Uint8Array>): boolean =>
    (controller.desiredSize ?? 0) > 0;
  return new ReadableStream<Uint8Array>({
    cancel() {
      end();
    },
    pull(controller) {
      say(controller, owed.take());
    },
    start(controller) {
      const send = (event: SharedEvent): void => {
        owed.add(event);
        if (caughtUp(controller)) {
          say(controller, owed.take());
        }
      };
      say(controller, SHARED_OPENING);
      for (const event of followed.missed) {
        send(event);
      }
      stop = followed.listen(send);
      heartbeat = setInterval(() => {
        if (caughtUp(controller)) {
          say(controller, SHARED_HEARTBEAT);
        }
      }, heartbeatMs);
    },
  });
}

import { holderRefused, MAX_STREAMS_PER_SESSION } from '../authority/stream-admission.ts';

/**
 * Whether the streams a session holds at its cap are still read, asked of them before a stream past
 * the cap is refused (`EventStreams`). A browser that closes its event stream is not seen leaving by
 * the Function that proxies it — its `request.signal` aborts only under the `enable_request_signal`
 * compatibility flag, which upwind's adapter does not give a Function — so the object holds the
 * stream's place until a write finds the reader gone: at the latest the heartbeat's, an interval
 * after the stream last said anything. A reader that moves between live pages quickly would meet
 * its session's cap with streams nobody reads, and its new page's streams would be refused.
 *
 * So where the admission refuses a stream at its holder's own cap — the key its places are counted
 * by, or the session (`holderRefused`) — each of the holder's streams open here is written a
 * heartbeat: the write to a reader that left fails, and its stream gives its place back. The wait
 * that follows lasts `waitMs`, and every stream refused at the holder's cap while it lasts waits in
 * it — the one the writes were made for, and each asked for after it, as a page of several live roots
 * asks for them at once — in the order they came, as many as the holder may hold: one more could
 * be admitted only by a place that a stream admitted during the wait gave back within it. Each place
 * of the holder's given back is asked for by the stream first in line alone, which waits first again
 * where another took it, and hands it on to the next where it is refused for anything but the
 * holder's cap — its session, say; each asks once more as the wait ends. So what a probe asks of the
 * admission grows as the places given back and the streams waiting do, not as their product. A stream refused while as many wait, or after the wait is over, within the
 * second — one holder's streams are written to once a second at most — is refused at once. Nothing
 * here writes to another holder's streams, nor answers the authority's own cap.
 */

/** How long a probe waits for places given back, and how often one holder's streams are written to. */
const PROBE = { everyMs: 1000, waitMs: 300 } as const;

/** A stream a probe may write to. */
export interface Probed {
  /** Whose places the stream is counted among (`holderOf`); none where its admission says none. */
  readonly holder: string | undefined;
  /** Says a heartbeat now, which a stream whose reader left fails on. */
  readonly beat: () => void;
}

/** The streams open now, and each holder's among them, which a probe writes to. */
export class OpenStreams<T extends Probed> {
  readonly #all = new Set<T>();
  readonly #byHolder = new Map<string, Set<T>>();

  /** How many streams are open now. */
  get size(): number {
    return this.#all.size;
  }

  /** A stream that started, counted among its holder's where it has one. */
  add(stream: T): void {
    this.#all.add(stream);
    const { holder } = stream;
    if (holder === undefined) {
      return;
    }
    const held = this.#byHolder.get(holder);
    if (held === undefined) {
      this.#byHolder.set(holder, new Set([stream]));
    } else {
      held.add(stream);
    }
  }

  /** A stream that ended, which is counted nowhere from then on. */
  delete(stream: T): void {
    this.#all.delete(stream);
    const { holder } = stream;
    const held = holder === undefined ? undefined : this.#byHolder.get(holder);
    if (holder === undefined || held === undefined) {
      return;
    }
    held.delete(stream);
    if (held.size === 0) {
      this.#byHolder.delete(holder);
    }
  }

  /** The streams of `holder`'s open now. */
  of(holder: string): Iterable<T> {
    return this.#byHolder.get(holder) ?? [];
  }
}

/**
 * One holder's probe: when its streams were written to, and the streams refused at the holder's cap
 * that wait while it lasts, in line: each woken by a place given back as it is first, or by the
 * wait's end.
 */
class Probe {
  /** What wakes each stream waiting, first in line first. */
  readonly #waiting: (() => void)[] = [];
  #over = false;
  readonly at: number;

  constructor(at: number) {
    this.at = at;
    setTimeout(() => {
      this.#over = true;
      for (const wake of this.#waiting.splice(0)) {
        wake();
      }
    }, PROBE.waitMs);
  }

  /** Whether the wait is over: a place asked for now is answered as the admission answers it. */
  get over(): boolean {
    return this.#over;
  }

  /** Whether as many streams wait as the holder may hold: one more is refused at once. */
  get full(): boolean {
    return this.#waiting.length >= MAX_STREAMS_PER_SESSION;
  }

  /**
   * Settles once a place of the holder's is given back with this stream first in line, or as the
   * wait ends. `first` puts it at the head of the line: woken by a place another took, it waits
   * first for the next.
   */
  next(first: boolean): Promise<undefined> {
    const woken = Promise.withResolvers<undefined>();
    const wake = (): void => {
      woken.resolve(undefined);
    };
    if (first) {
      this.#waiting.unshift(wake);
    } else {
      this.#waiting.push(wake);
    }
    return woken.promise;
  }

  /** A place of the holder's was given back: the stream first in line asks for it. */
  released(): void {
    this.#waiting.shift()?.();
  }
}

/** The probes of the streams of each holder at its cap, by the holder. */
export class StreamProbes {
  readonly #probes = new Map<string, Probe>();

  /** Lets go of the probes begun a second ago or more, whose holders may be written to again. */
  #prune(now: number): void {
    for (const [holder, probe] of this.#probes) {
      if (now - probe.at >= PROBE.everyMs) {
        this.#probes.delete(holder);
      }
    }
  }

  /**
   * A place for a stream of `holder`'s, which `refused` refused at the holder's cap. Its streams,
   * `streams`, are written a heartbeat, unless they were less than a second ago; the place is asked
   * for again (`ask`) each time one of the holder's is given back with this stream first in line
   * while the wait after the writes lasts, and once more as it ends. The refusal then is thrown, and
   * `refused` at once where the wait is over already or as many streams wait as the holder may hold;
   * a refusal of anything but the holder's cap is thrown as it comes, the place this stream was woken
   * for handed on to the next in line.
   */
  async admitted(
    holder: string,
    streams: Iterable<Probed>,
    ask: () => () => void,
    refused: unknown,
  ): Promise<() => void> {
    const now = Date.now();
    this.#prune(now);
    const begun = this.#probes.get(holder);
    if (begun !== undefined && (begun.over || begun.full)) {
      throw refused;
    }
    const probe = begun ?? new Probe(now);
    // In line before any write: a place given back from then on wakes this stream.
    let woken = probe.next(false);
    if (begun === undefined) {
      this.#probes.set(holder, probe);
      for (const stream of streams) {
        stream.beat();
      }
    }
    for (;;) {
      await woken;
      try {
        return ask();
      } catch (error) {
        if (probe.over) {
          throw error;
        }
        if (holderRefused(error) === undefined) {
          // Woken for a place given back, and refused for another reason: the place is the next's.
          probe.released();
          throw error;
        }
        woken = probe.next(true);
      }
    }
  }

  /** A place of `holder`'s was given back: the stream first in line in its probe asks for it. */
  released(holder: string): void {
    this.#probes.get(holder)?.released();
  }
}

/**
 * Follows a root's event stream (`EventSource`): each `frame` event says the revision of a newer
 * render of the root that shows something else, and `revoked` that the session ended, after which
 * the stream ends. The stream says no more than that: the page renders the root again itself,
 * through the router, so a tree is never shown with values of another revision than its own.
 *
 * A stream that fails is opened again by the follower rather than the browser, after a wait that
 * doubles with each failure in a row — with the newest subscription the root has, which carries
 * what the root shows now: the authority answers it at once with a `frame` if anything changed
 * while the stream was down, and with nothing otherwise. A stream that says `renew` — an asserted
 * session's, whose page is to ask the application again whether the session stands — is opened
 * again at once, as the one it replaces closes, and starts no wait.
 */

interface FollowerOptions {
  /** Where the stream is read from now: the newest subscription of the root followed. */
  readonly url: () => string;
  /** A newer render of the root shows something else. */
  readonly onFrame: (revision: number) => void;
  /**
   * The stream will say no more — the session ended, or what it followed is refused to it, as a
   * page of another build is — and the follower has stopped: why, and the authority's code for it.
   */
  readonly onRevoked: (message: string | undefined, code: string | undefined) => void;
  /** The first wait before a failed stream is opened again. */
  readonly retryDelay?: number;
  /** What each other event of the stream is handed to, by its name: the event's data. */
  readonly on?: Readonly<Record<string, (data: unknown) => void>>;
}

const FIRST_RETRY_MS = 1000;
const LONGEST_RETRY_MS = 30_000;
/** A stream open this long worked: its failure starts the waits again from the first. */
const STEADY_MS = 30_000;

function parse(data: unknown): unknown {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined;
  }
}

/** The revision a `frame` event names, as the authority writes it: `{ frame: { revision } }`. */
export function revisionOf(data: unknown): number | undefined {
  const event = parse(data) as
    | { readonly frame?: { readonly revision?: unknown } }
    | null
    | undefined;
  const revision = event?.frame?.revision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) ? revision : undefined;
}

function messageOf(data: unknown): string | undefined {
  const message = (parse(data) as { readonly error?: unknown } | null | undefined)?.error;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

function codeOf(data: unknown): string | undefined {
  const code = (parse(data) as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

export class Follower {
  readonly #options: FollowerOptions;
  readonly #firstDelay: number;
  #source: EventSource | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #delay: number;
  #openedAt: number | undefined;
  #stopped = false;

  constructor(options: FollowerOptions) {
    this.#options = options;
    this.#firstDelay = options.retryDelay ?? FIRST_RETRY_MS;
    this.#delay = this.#firstDelay;
  }

  #open(): void {
    if (typeof EventSource === 'undefined' || this.#stopped) {
      return;
    }
    const source = new EventSource(this.#options.url());
    this.#source = source;
    // A stream speaks for the page only while it is this follower's own: a replaced one may still
    // dispatch what it had received.
    const own = (): boolean => !this.#stopped && this.#source === source;
    source.addEventListener('open', () => {
      if (own()) {
        this.#openedAt = performance.now();
      }
    });
    source.addEventListener('frame', (event: MessageEvent) => {
      const revision = own() ? revisionOf(event.data) : undefined;
      if (revision !== undefined) {
        this.#options.onFrame(revision);
      }
    });
    if (this.#options.on !== undefined) {
      for (const [name, handle] of Object.entries(this.#options.on)) {
        source.addEventListener(name, (event: MessageEvent) => {
          if (own()) {
            handle(parse(event.data));
          }
        });
      }
    }
    source.addEventListener('renew', () => {
      if (own()) {
        source.close();
        this.#source = undefined;
        this.#open();
      }
    });
    source.addEventListener('revoked', (event: MessageEvent) => {
      if (own()) {
        this.stop();
        this.#options.onRevoked(messageOf(event.data), codeOf(event.data));
      }
    });
    source.addEventListener('error', () => {
      if (own()) {
        source.close();
        this.#source = undefined;
        this.#later();
      }
    });
  }

  /** Opens the stream again after the current wait. */
  #later(): void {
    const opened = this.#openedAt;
    this.#openedAt = undefined;
    if (opened !== undefined && performance.now() - opened >= STEADY_MS) {
      this.#delay = this.#firstDelay;
    }
    const delay = this.#delay;
    this.#delay = Math.min(delay * 2, LONGEST_RETRY_MS);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      this.#open();
    }, delay);
  }

  start(): void {
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#source?.close();
    this.#source = undefined;
  }
}

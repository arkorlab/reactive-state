import { generationOf } from './view-tokens.ts';

/**
 * The generation tokens of the authority's requests for artifacts under way, and whether a page
 * rendered with each (`SharedJobs`). A token lets a request of its own view through the gate as a
 * generation's only while its request is under way (`passes`); once the request is over, the token
 * is nothing — replayed, or read off a log, it takes no request past its route's middleware.
 */
export class ArtifactAsks {
  readonly #asked = new Map<string, boolean>();
  /** What the authority signs a generation's token with. */
  readonly #secret: string;

  constructor(secret: string) {
    this.#secret = secret;
  }

  /** Notes that the request of `token` is under way, no page rendered with it yet. */
  start(token: string): void {
    this.#asked.set(token, false);
  }

  /** Notes that a page rendered with `token`, where its request is under way. */
  rendered(token: string): void {
    if (this.#asked.has(token)) {
      this.#asked.set(token, true);
    }
  }

  /** Whether a page rendered with `token` while its request was under way. */
  wasRendered(token: string): boolean {
    return this.#asked.get(token) === true;
  }

  /** Notes that the request of `token` is over, whatever it was answered. */
  end(token: string): void {
    this.#asked.delete(token);
  }

  /**
   * Whether `token` lets a request of the view `view` through as a generation's: signed by the
   * authority, unexpired at `now`, of that view, and the very token of a request under way.
   */
  passes(token: string, view: string, now: number): boolean {
    return generationOf(this.#secret, token, now)?.view === view && this.#asked.has(token);
  }
}

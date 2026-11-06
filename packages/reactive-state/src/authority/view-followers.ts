import type { SharedEvent } from '../routing.ts';
import { describeThrown } from './errors.ts';
import { later, type Ready } from './shared-events.ts';

/** A moment of a view: an access epoch, and a generation of it. */
type Moment = Pick<Ready, 'epoch' | 'generation'>;

/** A page that follows a view: what tells it of an event, and the newest generation it knows of. */
interface Follower {
  readonly listener: (event: SharedEvent) => void;
  known: Ready;
}

/**
 * The newest generation a page that follows a view knows of as its stream starts: the one its
 * token claims, or the `ready` its stream is told it missed (`missedOf`), whichever is later.
 */
function knownOf(claims: Moment, missed: readonly SharedEvent[]): Ready {
  let known: Ready = { epoch: claims.epoch, generation: claims.generation, kind: 'ready' };
  for (const event of missed) {
    if (event.kind === 'ready' && later(event, known)) {
      known = event;
    }
  }
  return known;
}

/**
 * The pages that follow each view, by key — an event stream each, from its start
 * (`SharedViews.follow`) — and the newest generation each knows of: the one its token claims, or
 * one it was told of since. A view settled again as the generation it showed (`restored`) tells
 * that generation to the pages that know of an older one alone, and to each once: a page that
 * followed the view while it was unsettled — kept dirty across a restart, say — was told nothing of
 * it as its stream started (`missedOf`), and nothing else would tell it before the view's next
 * generation.
 */
export class ViewFollowers {
  readonly #byKey = new Map<string, Set<Follower>>();
  #size = 0;

  /** Tells `event` to each page that follows the view of `key` whose `known` it `heeds`. */
  #tell(key: string, event: SharedEvent, heeds: (known: Ready) => boolean): void {
    const followers = this.#byKey.get(key);
    if (followers === undefined) {
      return;
    }
    for (const follower of followers) {
      if (!heeds(follower.known)) {
        continue;
      }
      if (event.kind === 'ready' && later(event, follower.known)) {
        follower.known = event;
      }
      try {
        follower.listener(event);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`A shared view's listener failed: ${describeThrown(error)}`);
      }
    }
  }

  /** How many pages follow a view, of every view. */
  get size(): number {
    return this.#size;
  }

  /** Whether a page follows the view of `key`. */
  has(key: string): boolean {
    return this.#byKey.has(key);
  }

  /**
   * Tells `listener` of each event of the view of `key` — a page's that holds the generation its
   * token `claims`, told what it `missed` as its stream started — until the returned function is
   * called, once or more: a stream's request and its response may each close.
   */
  listen(
    key: string,
    claims: Moment,
    missed: readonly SharedEvent[],
    listener: (event: SharedEvent) => void,
  ): () => void {
    const followers = this.#byKey.get(key) ?? new Set<Follower>();
    this.#byKey.set(key, followers);
    const follower: Follower = { known: knownOf(claims, missed), listener };
    followers.add(follower);
    this.#size += 1;
    return () => {
      if (followers.delete(follower)) {
        this.#size -= 1;
      }
      // The view's followers where they are still these: called again once the view's last page
      // let go of it and another followed it, it lets go of nothing of the other's.
      if (followers.size === 0 && this.#byKey.get(key) === followers) {
        this.#byKey.delete(key);
      }
    };
  }

  /** Tells each page that follows the view of `key` of `event`. */
  notify(key: string, event: SharedEvent): void {
    this.#tell(key, event, () => true);
  }

  /**
   * Tells `ready` — the generation the view of `key` settled as again, as it showed it before — to
   * each page that follows it and knows of an older one, as its stream would have told it had it
   * started once the view settled (`missedOf`).
   */
  restored(key: string, ready: Ready): void {
    this.#tell(key, ready, (known) => later(ready, known));
  }
}

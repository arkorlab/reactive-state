import type { SharedEvent } from '../routing.ts';
import { refusal } from './errors.ts';
import type { SharedJobs } from './shared-jobs.ts';
import type { ViewClaims } from './view-tokens.ts';

/** Shared following admission and the original pre-listen event buffer. */

const HTTP_UNAVAILABLE = 503;

/** Followers alone cannot retain every view the authority can keep. */
export function assertFollowerRoom(streams: number, maxViews: number): void {
  if (streams >= maxViews - 1) {
    throw refusal(
      HTTP_UNAVAILABLE,
      'TOO_MANY_SHARED_STREAMS',
      'The authority is following as many shared streams as it can: ask again shortly.',
    );
  }
}

/**
 * A shared view's event stream's start, and its following: the events the page missed, and each
 * event of the view's from the moment they were reckoned, held until `listen` takes them. Whoever
 * follows a view listens or stops: until it does either, the following holds what it is told. A
 * view is kept for as long as it is followed (`#held`).
 */
export interface SharedFollowing {
  /** The initial current published state and any denial the token missed, as following began. */
  readonly missed: readonly SharedEvent[];
  /**
   * Tells `listener` of each event held since the following began, then of each as it comes, until
   * the function it answers — `stop` — is called. A following is listened to once.
   */
  readonly listen: (listener: (event: SharedEvent) => void) => () => void;
  /** Lets go of the following, whether or not it was listened to: nothing more is held or told. */
  readonly stop: () => void;
}

/** Events are held from registration until the original following is listened to or stopped. */
export function sharedFollowing(
  jobs: SharedJobs,
  key: string,
  claims: ViewClaims,
  missed: readonly SharedEvent[],
): SharedFollowing {
  const held: SharedEvent[] = [];
  let tell = (event: SharedEvent): void => {
    held.push(event);
  };
  const stop = jobs.listen(key, claims, missed, (event) => {
    tell(event);
  });
  return {
    listen: (listener) => {
      tell = listener;
      for (const event of held.splice(0)) {
        listener(event);
      }
      return stop;
    },
    missed,
    stop,
  };
}

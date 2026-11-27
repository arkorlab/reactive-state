import { describeThrown } from './errors.ts';

/**
 * Where the authority met what the application's `onError` is told of:
 *
 * - `operation`: what a server operation's code threw that is not the authority's own refusal —
 *   a plain throw (answered 422) and a fault (its time, the storage's) alike.
 * - `render`: a fault of a component's render: of a page's or a shared route's, of the replay of a
 *   write, or of a site's own function of the inputs a view sent.
 * - `route`: a fault of a route's guards (`route` names it).
 * - `log`: a followed store's change log that could not be read, ingested or scheduled.
 * - `commit`: a commit listener that threw; the commit stands.
 * - `shared-view`: a route's shared view that could not make its artifacts.
 */
export type AuthorityErrorEvent =
  | {
      readonly kind: 'operation';
      readonly module: string;
      readonly name: string;
      readonly operationId: string;
    }
  | { readonly kind: 'render'; readonly component: string }
  | { readonly kind: 'route'; readonly route: string }
  | { readonly kind: 'log' }
  | { readonly kind: 'commit' }
  | { readonly kind: 'shared-view' };

/**
 * The application's hook for what the authority meets: given where it is told of (`onError`), the
 * authority's own `console.error` of it is not written. It changes no answer: what it throws, or
 * rejects with, is logged and goes no further.
 */
export type OnError = (error: unknown, event: AuthorityErrorEvent) => void | Promise<void>;

/** What an option of `onError` is: the hook an authority is given. */
export interface FaultOptions {
  readonly onError?: OnError | undefined;
}

/** How the authority tells of `error`: the hook's `event`, or else `log` where it has one. */
export type Report = (
  error: unknown,
  event: AuthorityErrorEvent,
  log?: string,
  /** Whether the hook was told of this failure by another site already: the flow knows, not the value. */
  told?: boolean,
) => void;

function hookFailed(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`The onError hook failed: ${describeThrown(error)}`);
}

/** What the hook answers, of whichever realm's promise: a rejection is logged, not unhandled. */
async function awaited(answer: void | PromiseLike<void>): Promise<void> {
  try {
    await answer;
  } catch (error) {
    hookFailed(error);
  }
}

/**
 * A `Report` for `onError`: it tells the hook of what it is given, on a later turn. Each failure is
 * reported once where it happens; a site that only awaits one reports no more (`told`), though
 * its log stays where there is no hook.
 */
export function reporterOf(onError: OnError | undefined): Report {
  return (error, event, log, told) => {
    if (onError === undefined) {
      if (log !== undefined) {
        // eslint-disable-next-line no-console
        console.error(log);
      }
      return;
    }
    if (told === true) {
      return;
    }
    // On a turn of its own: every answer and log made of the fault in this one, which is the
    // error itself for a render's, comes first — what the hook does to it changes none of them.
    setTimeout(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- it never rejects
        awaited(onError(error, event));
      } catch (error_) {
        hookFailed(error_);
      }
    }, 0);
  };
}

/**
 * `core` with a `report` that holds what it is told until `flush`, which tells it to the real one:
 * for a call whose answer is the thrown error itself and goes out after other work (an operation's
 * wait on the stores' logs), which the hook, a turn later, must not outrun.
 */
export function held<C extends { readonly report: Report }>(
  core: C,
): { readonly core: C; readonly flush: () => void } {
  const kept: Parameters<Report>[] = [];
  return {
    core: {
      ...core,
      report: (...each) => {
        kept.push(each);
      },
    },
    flush: () => {
      for (const each of kept.splice(0)) {
        core.report(...each);
      }
    },
  };
}

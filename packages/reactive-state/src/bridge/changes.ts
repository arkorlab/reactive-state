import { setTimeout as sleep } from 'node:timers/promises';

import { getJson, postJson, type PublicPage, settle, type SiteRequest } from '../delivery/site.ts';
import { type ChangeEvent, INTERNAL_HEADER } from '../program.ts';

/**
 * Delivers the authority's change log to the application, at least once, from a cursor the
 * authority keeps. The changes since the cursor go out as one run: the records they published —
 * those of tables with public fields, which a page rendered without a session may show — are
 * posted to the application's internal route, which invalidates what was rendered from them, and
 * the cursor moves past the run only after that — so a bridge that stops resumes where it stopped,
 * and a change delivered twice does no harm. A run that published nothing, as a text field's
 * keystrokes make, only moves the cursor: the application is asked nothing for it.
 *
 * The invalidation is stale-while-revalidate, never a hard one: a visitor of a public page is
 * served what was there while it is rendered again, rather than waiting for the render. So each
 * page the bridge is given that shows a record the run changed is asked for, which starts the
 * render, until it shows the revision of the run's last change to one of its records or a later
 * one, and the cursor moves only then; a page none of whose records changed is not waited on. The
 * Durable Object takes the same steps from its alarm (`cloudflare/delivery.ts`).
 */

export interface ChangeBridgeOptions {
  readonly authority: { readonly url: string; readonly token: string };
  /** The application's origin, as a visitor reaches it. */
  readonly site: string;
  /** Whose cursor this is; one per application the log is delivered to. */
  readonly consumer: string;
  /** The application's internal route that takes a change. */
  readonly changesPath?: string;
  /**
   * The pages the application renders without a session, each with the records it shows, which a
   * run is settled on; none unless given.
   */
  readonly pages?: readonly PublicPage[];
  readonly intervalMs?: number;
  /** How long a page has to show a change before the delivery is tried again. */
  readonly settleTimeoutMs?: number;
  /** How long one request to the authority or the site may take before the tick gives it up. */
  readonly requestTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface ChangeBridge {
  /** The last revision delivered and acknowledged. */
  readonly delivered: () => number;
  readonly stop: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 750;
const DEFAULT_SETTLE_MS = 30_000;
const DEFAULT_REQUEST_MS = 30_000;
/**
 * The most records one request names, as many as the application's route takes: a run that
 * published more goes in as many requests as it takes, rather than in one the route refuses every
 * time it is tried again.
 */
const RECORDS_PER_REQUEST = 100;

export function startChangeBridge(options: ChangeBridgeOptions): ChangeBridge {
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const stopping = new AbortController();
  let delivered = 0;
  const tick = async (): Promise<void> => {
    try {
      // The cursor is reported as it is read and as the run is acknowledged, so a run that fails
      // still reports what was delivered before it.
      await deliver(options, stopping.signal, (revision) => {
        delivered = revision;
      });
    } catch (error) {
      if (!stopping.signal.aborted) {
        const reason = error instanceof Error ? error.message : String(error);
        options.log?.(`[change bridge; will retry] ${reason}`);
      }
    }
  };
  const loop = async (): Promise<void> => {
    while (!stopping.signal.aborted) {
      await tick();
      try {
        await sleep(interval, undefined, { signal: stopping.signal });
      } catch {
        // The wait ends early when the bridge stops, which the loop's condition then sees.
      }
    }
  };
  const running = loop();
  return {
    delivered: () => delivered,
    stop: async () => {
      stopping.abort();
      await running;
    },
  };
}

/** The records a run of changes published, each once, in the order they first changed. */
function publishedIn(changes: readonly ChangeEvent[]): string[] {
  return [...new Set(changes.flatMap((change) => change.published))];
}

/** The revision of the run's last change to a record `page` shows; none when none changed. */
function lastChangeShownBy(page: PublicPage, changes: readonly ChangeEvent[]): number | undefined {
  const shown = new Set(page.resources);
  const last = changes.findLast((change) => change.published.some((record) => shown.has(record)));
  return last?.revision;
}

async function deliver(
  options: ChangeBridgeOptions,
  stopping: AbortSignal,
  acknowledged: (revision: number) => void,
): Promise<void> {
  const { authority, consumer, pages = [], site } = options;
  // Every request takes the stop signal and a time limit: a bridge stopped while an authority or a
  // site does not answer stops then, and one left running tries again rather than wait on it.
  const request: SiteRequest = {
    headers: { [INTERNAL_HEADER]: authority.token },
    signal: stopping,
    timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_MS,
  };
  const cursor = await getJson<{ revision: number }>(
    `${authority.url}/internal/delivery?consumer=${encodeURIComponent(consumer)}`,
    request,
  );
  acknowledged(cursor.revision);
  const changes = await getJson<readonly ChangeEvent[]>(
    `${authority.url}/internal/changes?since=${String(cursor.revision)}`,
    request,
  );
  const latest = changes.at(-1)?.revision;
  if (latest === undefined) {
    return;
  }
  const published = publishedIn(changes);
  for (let start = 0; start < published.length; start += RECORDS_PER_REQUEST) {
    const changed = published.slice(start, start + RECORDS_PER_REQUEST);
    await postJson(
      `${site}${options.changesPath ?? '/api/internal/changes'}`,
      { changed, revision: latest },
      request,
    );
  }
  for (const page of pages) {
    const revision = lastChangeShownBy(page, changes);
    if (revision !== undefined) {
      // A bridge that stops gives up at once, without acknowledging: the cursor has not moved, so
      // the run is delivered again next time. The page is waited on for the records that changed,
      // each in the rendering that shows it.
      await settle(`${site}${page.path}`, revision, {
        records: page.resources.filter((record) =>
          changes.some((change) => change.published.includes(record)),
        ),
        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_MS,
        signal: stopping,
        timeoutMs: options.settleTimeoutMs ?? DEFAULT_SETTLE_MS,
      });
    }
  }
  await postJson(`${authority.url}/internal/delivery`, { consumer, revision: latest }, request);
  acknowledged(latest);
}

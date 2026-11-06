import type { AuthorityEngine } from '../authority/engine.ts';
import { publishes } from '../authority/records.ts';
import { integer, text } from '../authority/rows.ts';
import type { SqlDriver } from '../authority/sql.ts';
import {
  answeredBy,
  pageShown,
  type PublicPage,
  postJson,
  settle,
  shownRevisionOf,
  type SiteRequest,
} from '../delivery/site.ts';
import { type ChangeEvent, INTERNAL_HEADER } from '../program.ts';
import { type AnyDatabase, definitionOf } from '../server/schema.ts';
import { ObjectAlarm } from './alarm.ts';
import { type AuthorityEnv, siteOf, type SiteTarget } from './env.ts';
import {
  type Answering,
  doneBy,
  isOwed,
  noteAnswer,
  type OwedCheck,
  owedChecks,
  owedStill,
  type PageDone,
} from './owed.ts';

/**
 * The change log, delivered by the object that keeps it, from its own alarm: what the Node change
 * bridge (`bridge/changes.ts`) does from outside the Node authority, with nothing outside the
 * object to run it.
 *
 * A commit arms the alarm a moment later (`delayMs`), so the commits within that moment go out
 * together. The alarm reads the site's cursor and the changes since it, posts the records they
 * changed that a page without a session may show (`published`) to the application's internal
 * route, asks each of the application's public pages (`pages`) that shows one of those records
 * until it shows the newest change to them, and only then moves the cursor: at least once, as the
 * bridge delivers, and a change delivered twice only marks a tag stale twice. A run of changes that
 * published nothing — a write to the todos, a change to who may edit, a sign-out — only moves the
 * cursor, which lets the log go of it: the engine keeps a change until every consumer has taken it.
 * Each read goes through the engine and lets go of its queue before any request is made — a page's
 * render asks this very object for its public view, which would otherwise wait behind the delivery
 * that is waiting for the render.
 *
 * A delivery that fails is kept, with a floor no attempt runs before: two seconds after it, then
 * twice as long after each failure in a row, up to five minutes, and the alarm is armed for it. The
 * alarm handler never throws, so the runtime never retries it on its own. An armed alarm is only
 * ever moved earlier, and one that fires before the floor is put back to it; and since a pause can
 * consume an alarm, an object that starts with a change the site has not taken arms one again.
 *
 * A deployment the object has not heard from is caught up: its pages were rendered when it was
 * built, which may have been before a change the log delivered to the deployment it follows. A
 * root rendered for a new deployment, or the first in five minutes, arms a check that asks for
 * each public page and, when it shows an older revision than the newest change to its records,
 * delivers the changes it is behind on again; when it is current, the check was one request. A new
 * deployment's pages render the records that never changed again too, once: its build seeded them
 * as the declaration says now, which the records the object kept from before need not hold. A
 * check that fails is given up, with its reason kept: it holds no delivery back, and the next
 * render after five minutes asks for another. An object given no page settles nothing and checks
 * nothing.
 */

/** Whose cursor the deliveries move: the one application the object belongs to. */
const CONSUMER = 'site';
/** The application's route that takes a change. */
const CHANGES_PATH = '/api/internal/changes';

/** How long after a commit the change log goes out, unless the object is told otherwise. */
export const DELIVERY_DELAY_MS = 1000;
/**
 * The most records one request names, as many as the application's route takes: a run of changes
 * that touched more goes in as many requests as it takes, rather than in one the route refuses
 * every time it is tried again.
 */
const RECORDS_PER_REQUEST = 100;
/** How long one request to the site may take. */
const REQUEST_TIMEOUT_MS = 10_000;
/** How long a page has to show a change, its requests and the waits between them. */
const SETTLE_TIMEOUT_MS = 30_000;
/** The backoff after a first failure, and the longest any backoff grows to. */
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 300_000;
/** How long a check of the public pages stands before a render asks for another. */
const CATCH_UP_INTERVAL_MS = 300_000;
/** Longer than any deployment id: what is longer is not one, and is not kept. */
const MAX_DEPLOYMENT_LENGTH = 256;
/** How many deployments the object remembers having heard from. */
const KEPT_DEPLOYMENTS = 16;
/**
 * How long a check owed to a new deployment is tried: the project's hostname reaches a deployment
 * within minutes of its going live, so one that has not answered in an hour is not the one the
 * hostname serves — one it has moved past, or one served under a hostname of its own alone.
 */
const OWED_CHECK_MS = 3_600_000;
/**
 * How long a check owed to a new deployment waits to be made again, asked for by no render: about
 * the time a switch of the project's hostname takes to reach every location.
 */
const OWED_RETRY_MS = 60_000;
/** As much of a failure's message as is kept. */
const MAX_ERROR_LENGTH = 1000;

/** What the delivery keeps in the authority's `meta` table, beside the engine's own entries. */
const META = {
  /** The backoff the last failure waited, which the next one doubles. */
  backoff: 'delivery_backoff_ms',
  /** No attempt runs before this time: the floor the last failure's backoff set. */
  retryAt: 'delivery_retry_at',
  /** Why the last attempt failed. */
  error: 'delivery_error',
  /** Why the object delivers nothing at all: no site, or no token for it. */
  disabled: 'delivery_disabled',
  /**
   * The deployments roots were rendered for, newest last, as many as are kept: two serving at once,
   * as a rollout has them, are each heard from once, however their requests alternate.
   */
  deployments: 'caller_deployments',
  /** When a check of the public pages was last asked for. */
  checkedAt: 'catch_up_at',
  /** A check owed, as the time it was asked for. */
  due: 'catch_up_due',
  /**
   * The checks owed to deployments the object had not heard from — each renders the records that
   * never changed again too — oldest first: each one's deployment, when it was heard from, and the
   * pages whose part of it is done.
   */
  fresh: 'catch_up_fresh',
  /** When the checks owed still are made again, though no render asks for one. */
  owedAt: 'catch_up_owed_at',
  /** Why the last check failed — each page's failure, a line each — until one succeeds. */
  checkError: 'catch_up_error',
} as const;

type Site = Extract<SiteTarget, { readonly kind: 'site' }>;

interface DeliveryOptions {
  readonly engine: AuthorityEngine;
  readonly sql: SqlDriver;
  readonly storage: DurableObjectStorage;
  readonly alarm?: ObjectAlarm | undefined;
  readonly env: AuthorityEnv;
  /** How long after a commit the alarm is armed for. */
  readonly delayMs: number;
  /** The pages a delivery waits for and a check asks for, as `pagesOf` read them. */
  readonly pages: readonly PublicPage[];
}

/**
 * The pages an object is given, as a delivery reads them: each a path on the application's origin,
 * given once, showing records of tables with public fields — the records a delivery tells the site
 * of, and so the only ones a page could be seen to show a change to. A page of any other is
 * refused, with why: a delivery would otherwise wait for it in vain, and every check of it fail;
 * so is a path given twice, whose checks are kept by its path.
 */
export function pagesOf(
  pages: readonly PublicPage[],
  database: AnyDatabase,
): readonly PublicPage[] {
  const published = publishes(definitionOf(database));
  const given = new Set<string>();
  return pages.map((page) => {
    const { path, resources } = page as Partial<Record<keyof PublicPage, unknown>>;
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new TypeError(
        `authorityObject(): a page is named by its path, which starts with /, and ${String(path)} does not.`,
      );
    }
    if (given.has(path)) {
      throw new TypeError(
        `authorityObject(): ${path} is given twice: give it once, with every record it shows.`,
      );
    }
    given.add(path);
    const listed: readonly unknown[] = Array.isArray(resources) ? resources : [];
    if (listed.length === 0) {
      throw new TypeError(`authorityObject(): ${path} names no record it shows.`);
    }
    const shown = listed.map((resource) => {
      if (typeof resource !== 'string' || !published(resource)) {
        throw new TypeError(
          `authorityObject(): ${path} shows ${String(resource)}, which is no record (\`table:id\`) of a table with public fields.`,
        );
      }
      return resource;
    });
    return { path, resources: shown };
  });
}

function readMeta(sql: SqlDriver, key: string): string | undefined {
  const row = sql.get('SELECT value FROM meta WHERE key = ?', key);
  return row === undefined ? undefined : text(row, 'value');
}

function writeMeta(sql: SqlDriver, key: string, value: string): void {
  sql.run(
    'INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

function deleteMeta(sql: SqlDriver, key: string): void {
  sql.run('DELETE FROM meta WHERE key = ?', key);
}

/** Deletes what `key` holds where it holds `value` still, and nothing written over it since. */
function deleteMetaIf(sql: SqlDriver, key: string, value: string): void {
  sql.run('DELETE FROM meta WHERE key = ? AND value = ?', key, value);
}

/** A number kept as text: 0 for none, and for one that does not read as a number. */
function numberOf(value = '0'): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The revision the site's cursor stands at. */
function deliveredTo(sql: SqlDriver): number {
  const row = sql.get('SELECT revision FROM deliveries WHERE consumer = ?', CONSUMER);
  return row === undefined ? 0 : integer(row, 'revision');
}

/** Whether the log holds a change after `revision`. */
function changedAfter(sql: SqlDriver, revision: number): boolean {
  return sql.get('SELECT revision FROM changes WHERE revision > ? LIMIT 1', revision) !== undefined;
}

/**
 * The revision of the last change to `resource`; 0 when it never changed. Read from its version,
 * which is kept for as long as the resource is, and not from the change log, which lets go of what
 * the site has taken — the change a new deployment's page is behind among it.
 */
function lastChangeTo(sql: SqlDriver, resource: string): number {
  const row = sql.get('SELECT version FROM versions WHERE resource = ?', resource);
  return row === undefined ? 0 : integer(row, 'version');
}

/** The records a run of changes published, each once, in the order they first changed. */
function publishedIn(changes: readonly ChangeEvent[]): string[] {
  return [...new Set(changes.flatMap((change) => change.published))];
}

/** The revision of the run's newest change that published one of `resources`; none for none. */
function newestChangeTo(
  changes: readonly ChangeEvent[],
  resources: readonly string[],
): number | undefined {
  return changes.findLast((change) =>
    change.published.some((resource) => resources.includes(resource)),
  )?.revision;
}

/** Which of `resources` the changes published: those a page that shows them waits on. */
function changedOf(changes: readonly ChangeEvent[], resources: readonly string[]): string[] {
  return resources.filter((resource) =>
    changes.some((change) => change.published.includes(resource)),
  );
}

function bypassOf(site: Site): Record<string, string> {
  return site.bypass === undefined ? {} : { [site.bypass.header]: site.bypass.value };
}

/** A change for the site's internal route: the internal token, and the bypass when there is one. */
function changeRequest(site: Site): SiteRequest {
  return {
    headers: { ...bypassOf(site), [INTERNAL_HEADER]: site.token },
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}

/** The backoff after a failure that follows one that waited `previous`. */
function nextBackoff(previous: number): number {
  return previous >= RETRY_FIRST_MS ? Math.min(previous * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
}

/** The deployment a caller names, when it names one that could be one. */
function deploymentOf(caller: unknown): string | undefined {
  if (typeof caller !== 'object' || caller === null) {
    return undefined;
  }
  const { deployment } = caller as { readonly deployment?: unknown };
  return typeof deployment === 'string' &&
    deployment !== '' &&
    deployment.length <= MAX_DEPLOYMENT_LENGTH
    ? deployment
    : undefined;
}

export class SiteDelivery {
  readonly #engine: AuthorityEngine;
  readonly #sql: SqlDriver;
  readonly #alarm: ObjectAlarm;
  readonly #env: AuthorityEnv;
  readonly #delayMs: number;
  readonly #pages: readonly PublicPage[];
  /**
   * The arming under way, and those queued behind it. One at a time, so that each reads the alarm
   * the one before it set: two that read it at once could each set theirs, the later one last.
   */
  #arming: Promise<void> = Promise.resolve();

  constructor(options: DeliveryOptions) {
    this.#engine = options.engine;
    this.#sql = options.sql;
    this.#alarm = options.alarm ?? new ObjectAlarm(options.storage);
    this.#env = options.env;
    this.#delayMs = options.delayMs;
    this.#pages = options.pages;
  }

  /** The deployments the object has heard from, newest last. */
  #heard(): readonly string[] {
    const kept = readMeta(this.#sql, META.deployments);
    if (kept === undefined) {
      return [];
    }
    try {
      const heard: unknown = JSON.parse(kept);
      return Array.isArray(heard) ? heard.filter((item) => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  #noteCaller(deployment: string | undefined, now: number): void {
    const heard = this.#heard();
    const fresh = deployment !== undefined && !heard.includes(deployment);
    if (!fresh && now - numberOf(readMeta(this.#sql, META.checkedAt)) <= CATCH_UP_INTERVAL_MS) {
      return;
    }
    if (fresh) {
      writeMeta(
        this.#sql,
        META.deployments,
        JSON.stringify([...heard, deployment].slice(-KEPT_DEPLOYMENTS)),
      );
    }
    writeMeta(this.#sql, META.checkedAt, String(now));
    writeMeta(this.#sql, META.due, String(now));
    if (fresh) {
      // Each deployment is owed a check of its own, though another is heard from before it is made.
      const owed = [
        ...owedChecks(readMeta(this.#sql, META.fresh)),
        { at: now, deployment, pages: [] },
      ];
      writeMeta(this.#sql, META.fresh, JSON.stringify(owed.slice(-KEPT_DEPLOYMENTS)));
    }
    this.#arm(now + this.#delayMs);
  }

  /** Whether a change is not taken by the site yet, or a check is owed. */
  #owed(): boolean {
    return (
      changedAfter(this.#sql, deliveredTo(this.#sql)) || readMeta(this.#sql, META.due) !== undefined
    );
  }

  /**
   * Arms the alarm for `at`, or for the floor a failure set when that is later. An alarm armed
   * already for an earlier time is left as it is: whatever it runs for, it runs everything owed.
   */
  #arm(at: number): void {
    const previous = this.#arming;
    this.#arming = (async () => {
      await previous;
      try {
        await this.#armNow(at);
      } catch {
        // An alarm the storage would not arm is armed again as the object next starts (`resume`),
        // from what its tables hold.
      }
    })();
  }

  async #armNow(at: number): Promise<void> {
    const target = Math.max(at, numberOf(readMeta(this.#sql, META.retryAt)));
    await this.#alarm.arm(target);
  }

  async #attempt(): Promise<void> {
    const floor = numberOf(readMeta(this.#sql, META.retryAt));
    if (Date.now() < floor) {
      // Armed before a failure set the floor — by a commit while the attempt that failed was under
      // way — and so put back to it.
      this.#arm(floor);
      return;
    }
    const site = siteOf(this.#env);
    if (site.kind === 'disabled') {
      // Nothing is armed again: a site and a token come with a new version of the object, which
      // starts behind, and arms its own alarm (`resume`).
      writeMeta(this.#sql, META.disabled, site.reason);
      return;
    }
    deleteMeta(this.#sql, META.disabled);
    await this.#deliverChanges(site);
    deleteMeta(this.#sql, META.backoff);
    deleteMeta(this.#sql, META.retryAt);
    deleteMeta(this.#sql, META.error);
    await this.#catchUp(site);
    // Commits during the attempt armed the alarm themselves; this is for a log longer than one read
    // of it, or a check asked for while the last one was under way — and for the next check of what
    // is owed still, which an alarm armed earlier for a commit ran before its time.
    if (this.#owed()) {
      this.#arm(Date.now() + this.#delayMs);
    }
    this.#armOwedRetry();
  }

  async #deliverChanges(site: Site): Promise<void> {
    const cursor = await this.#engine.delivery(CONSUMER);
    const changes = await this.#engine.changes(cursor);
    const latest = changes.at(-1)?.revision;
    if (latest === undefined) {
      return;
    }
    await this.#post(site, publishedIn(changes), latest);
    // A page waits for the changes to its own records alone: one to another record moves nothing on
    // it, and is delivered once the route has taken it.
    for (const page of this.#pages) {
      const newest = newestChangeTo(changes, page.resources);
      if (newest !== undefined) {
        await this.#settle(site, page, newest, changedOf(changes, page.resources));
      }
    }
    await this.#engine.acknowledge(CONSUMER, latest);
  }

  /**
   * Tells the site's route of `records`, as many to a request as it takes; of none, nothing. Answers
   * the deployment each answer says it came from.
   */
  async #post(
    site: Site,
    records: readonly string[],
    revision: number,
  ): Promise<(string | undefined)[]> {
    const answeredFrom: (string | undefined)[] = [];
    for (let start = 0; start < records.length; start += RECORDS_PER_REQUEST) {
      const answer = await postJson(
        `${site.origin}${CHANGES_PATH}`,
        { changed: records.slice(start, start + RECORDS_PER_REQUEST), revision },
        changeRequest(site),
      );
      answeredFrom.push(answeredBy(answer));
    }
    return answeredFrom;
  }

  /**
   * The check a render asked for, of every page, or the one owed to new deployments, of the pages
   * whose part of it is still to do. Never throws: a page whose check fails is given up and its
   * reason kept, so that it neither holds back the deliveries after it nor is tried again at once —
   * the next render after five minutes asks for another (`#noteCaller`) — and the pages after it
   * are checked all the same.
   */
  async #catchUp(site: Site): Promise<void> {
    const due = readMeta(this.#sql, META.due);
    const retry = readMeta(this.#sql, META.owedAt);
    if (due === undefined && (retry === undefined || Date.now() < numberOf(retry))) {
      return;
    }
    const kept = owedChecks(readMeta(this.#sql, META.fresh));
    // One owed for longer than an hour is given up, and has no page checked for it again.
    const now = Date.now();
    const owed = kept.filter((check) => now - check.at <= OWED_CHECK_MS);
    const failures: string[] = [];
    const done: PageDone[] = [];
    for (const page of this.#pages) {
      // Each page's part of a check owed to new deployments is done by itself: one done is not done
      // again — the page rendered again — for the part of another that fails. A check no render
      // asked for is made of the pages with a part still to do alone.
      const pending = owed.filter((check) => !check.pages.includes(page.path));
      if (due === undefined && pending.length === 0) {
        continue;
      }
      try {
        done.push(...(await this.#checkPage(site, page, pending)));
      } catch (error) {
        failures.push(messageOf(error));
      }
    }
    if (kept.length > 0) {
      this.#settleOwed(done);
    }
    if (failures.length === 0) {
      deleteMeta(this.#sql, META.checkError);
    } else {
      writeMeta(this.#sql, META.checkError, failures.join('\n').slice(0, MAX_ERROR_LENGTH));
    }
    // The check that was asked for, and no other: one asked for while this one was under way — by
    // a deployment this one may not have reached — is owed still.
    if (due !== undefined) {
      deleteMetaIf(this.#sql, META.due, due);
    }
    if (retry !== undefined) {
      deleteMetaIf(this.#sql, META.owedAt, retry);
    }
    // What is owed still is checked again a minute on, though no render asks: a page left as its
    // build rendered it would wait for a visitor otherwise.
    if (owedChecks(readMeta(this.#sql, META.fresh)).length > 0) {
      writeMeta(this.#sql, META.owedAt, String(Date.now() + OWED_RETRY_MS));
      this.#armOwedRetry();
    }
  }

  /** Arms the alarm for the next check of what is owed still, where one is to be made. */
  #armOwedRetry(): void {
    const retry = readMeta(this.#sql, META.owedAt);
    if (retry !== undefined) {
      this.#arm(numberOf(retry));
    }
  }

  /**
   * One page's check, for the checks owed to new deployments whose part on it is still to do
   * (`pending`); the parts it did. A check is done by one deployment's answers: the first an answer
   * names, which every other answer of the page's names too. One answered by a deployment that is
   * owed none of them did none, and fails.
   */
  async #checkPage(
    site: Site,
    page: PublicPage,
    pending: readonly OwedCheck[],
  ): Promise<readonly PageDone[]> {
    const answering: Answering | undefined =
      pending.length === 0 ? undefined : { deployment: undefined, owed: pending };
    await this.#check(site, page, answering);
    if (answering === undefined) {
      return [];
    }
    const did = doneBy(answering);
    if (did.length === 0) {
      throw new Error(
        `${site.origin}${page.path}: answered by ${String(answering.deployment)}, whose pages are owed no check; owed still: ${pending.map((check) => check.deployment).join(', ')}`,
      );
    }
    return did.map((check) => ({ check, path: page.path }));
  }

  /**
   * Settles the checks owed to new deployments whose every page's part is done, `done` among them.
   * A check owed for longer than an hour is given up, and one owed while this one was under way, by
   * a render meanwhile, is owed still.
   */
  #settleOwed(done: readonly PageDone[]): void {
    const owed = owedStill(
      owedChecks(readMeta(this.#sql, META.fresh)),
      done,
      this.#pages.map((page) => page.path),
      { maxAgeMs: OWED_CHECK_MS, now: Date.now() },
    );
    if (owed.length === 0) {
      deleteMeta(this.#sql, META.fresh);
    } else {
      writeMeta(this.#sql, META.fresh, JSON.stringify(owed));
    }
  }

  /**
   * One page, and the changes to its records it is behind on delivered again; in a check owed to
   * deployments the object had not heard from (`answering`), its records that never changed too,
   * once, every answer noted as the deployment it names.
   */
  async #check(site: Site, page: PublicPage, answering: Answering | undefined): Promise<void> {
    const changed = new Map<string, number>();
    const seeded: string[] = [];
    for (const resource of page.resources) {
      const version = lastChangeTo(this.#sql, resource);
      if (version > 0) {
        changed.set(resource, version);
      } else {
        seeded.push(resource);
      }
    }
    const route = `${site.origin}${CHANGES_PATH}`;
    const url = `${site.origin}${page.path}`;
    const request = { headers: bypassOf(site), timeoutMs: REQUEST_TIMEOUT_MS };
    // A record that never changed is shown by a deployment as its build's authority seeded it,
    // which the record the object kept need not be: the declaration's seed may have changed since
    // the object first wrote it. A new deployment's page renders those again, once — a render of
    // what the object holds, which no revision could tell apart from what the build held.
    if (answering !== undefined && seeded.length > 0) {
      // The deployment that serves the page now: one whose pages are owed no check has none of
      // them rendered again, however often what is owed is checked.
      const serving = (await pageShown(url, request)).deployment;
      noteAnswer(answering, serving, url);
      if (serving === undefined || isOwed(answering, serving)) {
        const answers = await this.#post(site, seeded, 0);
        for (const answered of answers) {
          noteAnswer(answering, answered, route);
        }
        // The invalidation keeps what was there until the page is asked for: asking for it starts
        // the render, which no visitor then waits for. Its revision says nothing of it — both
        // renders show the records as never changed — so it is asked for once, not until it shows
        // one.
        noteAnswer(answering, (await pageShown(url, request)).deployment, url);
      }
    }
    if (changed.size === 0) {
      return;
    }
    const newest = Math.max(...changed.values());
    const shown = await pageShown(url, request);
    noteAnswer(answering, shown.deployment, url);
    // Each record against the rendering that shows it, which is the page's own where the page
    // renders its records together.
    const behind = [...changed]
      .filter(([record, version]) => shownRevisionOf(shown, record) < version)
      .map(([record]) => record);
    if (behind.length === 0) {
      return;
    }
    const answers = await this.#post(site, behind, newest);
    for (const answered of answers) {
      noteAnswer(answering, answered, route);
    }
    noteAnswer(answering, await this.#settle(site, page, newest, behind), url);
  }

  /**
   * Waits for `page` to show `revision` of each of `records`, the ones that changed; answers the
   * deployment the page that showed it names, where it names one.
   */
  async #settle(
    site: Site,
    page: PublicPage,
    revision: number,
    records: readonly string[],
  ): Promise<string | undefined> {
    return settle(`${site.origin}${page.path}`, revision, {
      headers: bypassOf(site),
      records,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      timeoutMs: SETTLE_TIMEOUT_MS,
    });
  }

  /** Keeps a failure, and arms the next attempt after a backoff that doubles with each in a row. */
  #failed(error: unknown): void {
    let retryAt = Date.now() + RETRY_FIRST_MS;
    try {
      const backoff = nextBackoff(numberOf(readMeta(this.#sql, META.backoff)));
      retryAt = Date.now() + backoff;
      writeMeta(this.#sql, META.backoff, String(backoff));
      writeMeta(this.#sql, META.retryAt, String(retryAt));
      writeMeta(this.#sql, META.error, messageOf(error));
    } catch {
      // Storage that keeps no record of the failure keeps no floor for it either: the attempt is
      // armed all the same, after the first backoff.
    }
    this.#arm(retryAt);
  }

  /**
   * A commit, as the engine announces it, delivered shortly: what it published to the site, and
   * anything else only taken, so that the log lets go of it however long nothing is published.
   */
  committed(): void {
    this.#arm(Date.now() + this.#delayMs);
  }

  /** As the object starts: a delivery or a check left owed — its alarm consumed — is armed again. */
  resume(): void {
    if (this.#owed()) {
      this.#arm(Date.now() + this.#delayMs);
    }
    this.#armOwedRetry();
  }

  /** Waits for the alarms asked for so far to be armed. Never rejects. */
  async armed(): Promise<void> {
    await this.#arming;
  }

  /**
   * A root was rendered for `caller`: a deployment not heard from before, or the first caller in
   * five minutes, has its public pages checked — none, for an object given no page. Never rejects:
   * the check is the delivery's own business, and the render is answered whether or not it could
   * be asked for.
   */
  async noteCaller(caller: unknown): Promise<void> {
    if (this.#pages.length === 0) {
      return;
    }
    try {
      this.#noteCaller(deploymentOf(caller), Date.now());
    } catch {
      // Storage that will not keep the check's due date will not arm its alarm either; the next
      // render asks again.
    }
    await this.#arming;
  }

  /** The alarm. Never throws: a failure is kept, and the alarm armed again after a backoff. */
  async run(): Promise<void> {
    try {
      await this.#attempt();
    } catch (error) {
      this.#failed(error);
    }
    await this.#arming;
  }
}

/**
 * A change delivered to an application, in the two steps every host of the authority takes. The
 * change is posted to the application's internal route, which invalidates what was rendered from
 * the changed records; and since that invalidation is stale-while-revalidate — a visitor is served
 * what was there while it renders again — the page that shows the records is then asked for until
 * it shows the change's revision, which starts the render and says when it is over ("settling").
 * The Node change bridge (`bridge/changes.ts`) takes these steps for a cursor it reads over HTTP,
 * and the Durable Object (`cloudflare/delivery.ts`) from its own alarm.
 *
 * Runtime-neutral: `fetch`, `AbortController` and timers, which Node and workerd both have. `fetch`
 * is read when a request is made, so a test that stubs the global is the one asked.
 */

/**
 * A page an application renders without a session, from records' public fields: after a change to
 * one of `resources`, a delivery asks for the page until it shows the change's revision, and a
 * deployment the authority has not heard from has the page checked against the newest of them.
 *
 * The page says which revision it shows with `data-revision` — the revision its public view was
 * read at — once for every record it renders together, or, where it renders a record in a cache of
 * its own, once for that record, beside `data-resource="table:id"`: a record no rendering names is
 * shown at the revision of the first that names none. It may say which deployment rendered it, with
 * `data-deployment` — its `NEXT_DEPLOYMENT_ID` — as the changes route may in its answer
 * (`{ deployment }`): a check owed to a new deployment is done by that deployment's answers alone.
 */
export interface PublicPage {
  /** The page's path on the application's origin, `/public`. */
  readonly path: string;
  /** The records (`table:id`) whose public fields the page shows. */
  readonly resources: readonly string[];
}

/**
 * A tag of a page, where one starts: what lies between a `<` and the `>` that closes it — not one
 * inside a quoted attribute's value, where HTML lets it stand.
 */
const TAG = /<[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/uy;
/** A tag's name, after its `<` and any `/`, which is no attribute of it. */
const TAG_NAME = /^<\/?([^\s/>]*)/u;
/**
 * The elements whose text HTML reads as text, not markup — what looks like a tag in them is none:
 * a script's, a style's, a title's, and the rest; a `<noscript>`'s too, as a browser that runs
 * scripts reads it.
 */
const RAW_TEXT: ReadonlySet<string> = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);
/** An attribute's name, where one starts, and the `=` after it where it is given a value. */
const ATTRIBUTE_NAME = /([^\s"'/<=>]+)(\s*=\s*)?/uy;
/** An attribute's value: quoted either way, or not at all, as HTML lets one be written. */
const ATTRIBUTE_VALUE = /"([^"]*)"|'([^']*)'|([^\s"'<=>`]+)/uy;
/** The largest code point, past which a numeric reference stands for none. */
const MAX_CODE_POINT = 0x10_ff_ff;
/** A character reference an attribute's value may hold: `&amp;`, `&#x27;`, `&#39;`. */
const REFERENCE = /&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]{2,4}));/giu;
/** The named references that stand for what React escapes in an attribute's value. */
const NAMED: Readonly<Partial<Record<string, string>>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};
/** A revision, as a page renders one. */
const DIGITS = /^\d+$/u;

/**
 * What a page shows of its records: the revision each rendering that names its record was read at,
 * and the page's own — the first rendering that names none — for every record no rendering names;
 * -1 where there is none.
 */
export interface Shown {
  readonly records: ReadonlyMap<string, number>;
  readonly page: number;
  /** The deployment the page says rendered it, the first it names; none where it names none. */
  readonly deployment: string | undefined;
}

/** How long a settle waits between two requests for the page, unless told otherwise. */
const DEFAULT_POLL_MS = 250;

/** What one request to an application carries, and how long it may take. */
export interface SiteRequest {
  /** Sent with the request: the internal token, a bypass of the project's access protection. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Gives the request up at once when it aborts, as a bridge that stops does. */
  readonly signal?: AbortSignal | undefined;
}

interface SettleOptions {
  /** How long the page has to show the revision: its requests and the waits between them. */
  readonly timeoutMs: number;
  /**
   * How long one request for the page may take, as any request of the caller's may; the whole of
   * what is left of `timeoutMs` when not given.
   */
  readonly requestTimeoutMs?: number;
  /** How long it waits between two requests. */
  readonly pollMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Ends the settle at once, without waiting for the page or for the time to run out. */
  readonly signal?: AbortSignal | undefined;
  /** The records whose change it waits for the page to show; the page's own revision without. */
  readonly records?: readonly string[];
}

/**
 * Runs `request` — a fetch and the read of its answer — under a signal that aborts after
 * `timeoutMs`, or as soon as `signal` does. The timer goes with the request, where
 * `AbortSignal.timeout` would leave one behind for the whole of the limit: in a Durable Object, a
 * timer still to fire is work in flight, which keeps the object from being evicted until it does.
 */
async function within<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The request took too long.', 'TimeoutError'));
  }, timeoutMs);
  const forward = (): void => {
    controller.abort(signal?.reason);
  };
  signal?.addEventListener('abort', forward, { once: true });
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

/** Whether `character` ends a tag's name: a space, a `/` or a `>`, or the end of the document. */
function endsName(character: string): boolean {
  return character === '' || character === '/' || character === '>' || /\s/u.test(character);
}

/**
 * Where the end tag of the element `name`, whose text is no markup, begins at `from` or after it:
 * `</name`, in any case, then a space, a `/` or a `>`; the end of `html` where none does, as HTML
 * reads one never closed.
 */
function rawTextEnd(html: string, name: string, from: number): number {
  for (let at = html.indexOf('</', from); at !== -1; at = html.indexOf('</', at + 2)) {
    const after = at + 2 + name.length;
    if (html.slice(at + 2, after).toLowerCase() === name && endsName(html.charAt(after))) {
      return at;
    }
  }
  return html.length;
}

/**
 * The tags of `html` that are markup, in order: none in a comment, nor in the text of an element
 * HTML reads as text — `<script>`, `<style>` and the rest — though it may read as one.
 */
function tagsOf(html: string): readonly string[] {
  const tags: string[] = [];
  let at = 0;
  for (;;) {
    const start = html.indexOf('<', at);
    if (start === -1) {
      return tags;
    }
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + '<!--'.length);
      // One never closed runs to the end of the document.
      if (end === -1) {
        return tags;
      }
      at = end + '-->'.length;
      continue;
    }
    TAG.lastIndex = start;
    const tag = TAG.exec(html)?.[0];
    if (tag === undefined) {
      at = start + 1;
      continue;
    }
    tags.push(tag);
    at = TAG.lastIndex;
    const name = TAG_NAME.exec(tag)?.[1]?.toLowerCase() ?? '';
    if (!tag.startsWith('</') && RAW_TEXT.has(name)) {
      at = rawTextEnd(html, name, at);
    }
  }
}

/** What a character reference stands for; itself where it is none this reads. */
function referenced(
  reference: string,
  decimal: string | undefined,
  hex: string | undefined,
  name: string | undefined,
): string {
  if (name !== undefined) {
    return NAMED[name] ?? reference;
  }
  const code =
    decimal === undefined ? Number.parseInt(hex ?? '', 16) : Number.parseInt(decimal, 10);
  return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : reference;
}

/** The value written at `at` of a tag's inside, and where it ends; none where none is. */
function valueAt(inside: string, at: number): { readonly value: string; readonly end: number } {
  ATTRIBUTE_VALUE.lastIndex = at;
  const written = ATTRIBUTE_VALUE.exec(inside);
  if (written === null) {
    return { end: at, value: '' };
  }
  const [, double, single, bare] = written;
  const value = double ?? single ?? bare ?? '';
  return {
    end: ATTRIBUTE_VALUE.lastIndex,
    value: value.replaceAll(
      REFERENCE,
      (reference, decimal?: string, hex?: string, named?: string) =>
        referenced(reference, decimal, hex, named),
    ),
  };
}

/**
 * The attributes of a tag, by name as HTML reads it — in lower case, the first of a name — each
 * value with its character references read; none of a doctype's or an end tag's.
 */
function attributesOf(tag: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  if (tag.startsWith('<!') || tag.startsWith('</')) {
    return attributes;
  }
  const inside = tag.slice(0, -1).replace(TAG_NAME, '');
  let at = 0;
  while (at < inside.length) {
    ATTRIBUTE_NAME.lastIndex = at;
    const named = ATTRIBUTE_NAME.exec(inside);
    if (named === null) {
      // Space between attributes, or a `/` that closes the tag.
      at += 1;
      continue;
    }
    const [, name = '', equals] = named;
    const { end, value } =
      equals === undefined
        ? { end: ATTRIBUTE_NAME.lastIndex, value: '' }
        : valueAt(inside, ATTRIBUTE_NAME.lastIndex);
    at = end;
    const key = name.toLowerCase();
    if (!attributes.has(key)) {
      attributes.set(key, value);
    }
  }
  return attributes;
}

/** The value of a tag's attribute `name`, where it has one that is not empty. */
function valueIn(attributes: ReadonlyMap<string, string>, name: string): string | undefined {
  const value = attributes.get(name);
  return value === '' ? undefined : value;
}

/** What a page's HTML says it shows: each record's rendering, and its own. */
function shownIn(html: string): Shown {
  const records = new Map<string, number>();
  let page = -1;
  let deployment: string | undefined;
  for (const tag of tagsOf(html)) {
    const attributes = attributesOf(tag);
    deployment ??= valueIn(attributes, 'data-deployment');
    const revision = valueIn(attributes, 'data-revision');
    if (revision === undefined || !DIGITS.test(revision)) {
      continue;
    }
    const shown = Number(revision);
    const record = valueIn(attributes, 'data-resource');
    if (record !== undefined) {
      // A record rendered twice shows the older of the two.
      records.set(record, Math.min(records.get(record) ?? shown, shown));
    } else if (page === -1) {
      page = shown;
    }
  }
  return { deployment, page, records };
}

/** The revision a page shows `record` at: its own rendering's, or the page's. */
export function shownRevisionOf(shown: Shown, record: string): number {
  return shown.records.get(record) ?? shown.page;
}

/**
 * The oldest revision a page shows of `records`, which are those a delivery waits on; the page's
 * own where it is told of none.
 */
function oldestShown(shown: Shown, records: readonly string[] | undefined): number {
  if (records === undefined || records.length === 0) {
    return shown.page;
  }
  return Math.min(...records.map((record) => shownRevisionOf(shown, record)));
}

/** Waits `ms`, or rejects as soon as the signal aborts, with its reason for the cause. */
async function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  const { promise, reject, resolve } = Promise.withResolvers<undefined>();
  const timer = setTimeout(resolve, ms);
  const abort = (): void => {
    clearTimeout(timer);
    reject(new Error('The wait was given up.', { cause: signal?.reason }));
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await promise;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * GETs `url` and answers its JSON; anything but a 2xx answer is an error naming the status, its
 * body canceled unread: left to come in, it would hold its connection past the request's time limit
 * and its caller's signal, which go with the request.
 */
export async function getJson<T>(url: string, request: SiteRequest): Promise<T> {
  return within(request.timeoutMs, request.signal, async (signal) => {
    const response = await fetch(url, { headers: { ...request.headers }, signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${url}: HTTP ${String(response.status)}`);
    }
    return (await response.json()) as T;
  });
}

/**
 * POSTs `body` as JSON, and answers what the answer's JSON holds — nothing where it holds none.
 * The answer is read whole, and anything but a 2xx one is an error naming the URL and the status,
 * which is what a delivery that will try again reports.
 */
export async function postJson(url: string, body: unknown, request: SiteRequest): Promise<unknown> {
  const { response, text } = await within(request.timeoutMs, request.signal, async (signal) => {
    const answered = await fetch(url, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...request.headers },
      method: 'POST',
      signal,
    });
    return { response: answered, text: await answered.text() };
  });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${String(response.status)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The deployment an answer of the changes route says it came from (`{ deployment }`); none else. */
export function answeredBy(answer: unknown): string | undefined {
  const deployment =
    typeof answer === 'object' && answer !== null
      ? (answer as Readonly<Partial<Record<string, unknown>>>)['deployment']
      : undefined;
  return typeof deployment === 'string' ? deployment : undefined;
}

/** One request for a page, read whole: its status, and what it rendered. */
async function readPage(
  page: string,
  headers: Readonly<Record<string, string>> | undefined,
  signal: AbortSignal,
): Promise<{ readonly ok: boolean; readonly status: number; readonly html: string }> {
  const response = await fetch(page, { cache: 'no-store', headers: { ...headers }, signal });
  return { html: await response.text(), ok: response.ok, status: response.status };
}

/** What `page` shows now, from one request; a page that does not answer 2xx is an error. */
export async function pageShown(page: string, request: SiteRequest): Promise<Shown> {
  const { html, ok, status } = await within(request.timeoutMs, request.signal, async (signal) =>
    readPage(page, request.headers, signal),
  );
  if (!ok) {
    throw new Error(`${page}: HTTP ${String(status)}`);
  }
  return shownIn(html);
}

/**
 * Asks for `page` until it shows `revision` or a later one — of each of `records`, the ones that
 * changed, where it is told them — and throws once the time is up; answers the deployment the page
 * that showed it names, where it names one. The time limit holds within a request as well: a page
 * that never finishes answering is given up on when the wait is over, not when the page decides —
 * and sooner, once the request took the time one may take (`requestTimeoutMs`), so that a page that
 * hangs holds the deliveries after it no longer than any request does. A request that fails before
 * then — one the page answers with a failure too — fails the settle, and an abort of the caller's
 * signal ends it at once — a delivery that is not settled is not acknowledged either way, and is
 * made again.
 */
export async function settle(
  page: string,
  revision: number,
  options: SettleOptions,
): Promise<string | undefined> {
  const { signal } = options;
  const deadline = Date.now() + options.timeoutMs;
  let shown = -1;
  for (;;) {
    const remaining = Math.max(0, deadline - Date.now());
    const limit = Math.min(remaining, options.requestTimeoutMs ?? remaining);
    try {
      const { html, ok, status } = await within(limit, signal, async (limited) =>
        readPage(page, options.headers, limited),
      );
      // A page answered with a failure fails the settle as a request that fails does, at once:
      // asked for again until the time is up, it would hold every delivery after it that long.
      if (!ok) {
        throw new Error(`${page}: HTTP ${String(status)}`);
      }
      const rendered = shownIn(html);
      shown = oldestShown(rendered, options.records);
      if (shown >= revision) {
        return rendered.deployment;
      }
    } catch (error) {
      if (signal?.aborted === true || Date.now() < deadline) {
        throw error;
      }
    }
    // A wait ends where the time does, rather than hold the deliveries after the settle past it, and
    // no request is made once the time is up, which would have none of it left to be answered in.
    const left = deadline - Date.now();
    const wait = options.pollMs ?? DEFAULT_POLL_MS;
    if (left > 0) {
      await pause(Math.min(wait, left), signal);
    }
    if (wait >= left || Date.now() >= deadline) {
      throw new Error(`${page} still shows revision ${String(shown)}, not ${String(revision)}`);
    }
  }
}

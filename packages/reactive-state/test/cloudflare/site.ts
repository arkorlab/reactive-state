import { onTestFinished, vi } from 'vitest';

import { INTERNAL_HEADER } from '../../src/program.ts';

/** A change the site's internal route was sent, with the credentials it came with. */
interface PostedChange {
  readonly body: unknown;
  readonly token: string | null;
  readonly bypass: string | null;
}

/** A request for a page, with the bypass it came with. */
interface PageRead {
  readonly bypass: string | null;
}

/** A page besides the public page: what it is asked, the revision it shows, its answer's status. */
interface OtherPage {
  readonly reads: PageRead[];
  shown: number;
  status: number;
}

/**
 * A stand-in for the application the change log goes to — its internal changes route, and its
 * public page, which shows the counter `main` — answered through a stubbed `fetch`, which the
 * object reaches from the suites' own isolate. A page is stale-while-revalidate, as the
 * application's are: after a change that names its record, it is asked for once more as it was,
 * and from then on shows the change's revision.
 */
interface FakeSite {
  readonly posted: PostedChange[];
  readonly reads: PageRead[];
  /** The revision the public page shows. */
  shown: number;
  /** What the changes route answers with, and the public page. */
  status: number;
  pageStatus: number;
  /** The deployment the site's answers say they came from; none where they say none. */
  deployment: string | undefined;
  /** A page besides the public page, by its path; one the site was not given is a fault. */
  readonly page: (path: string) => OtherPage;
  readonly fetch: ReturnType<typeof vi.fn<typeof fetch>>;
}

/** The header the tests' environment names for the bypass (`REACTIVE_ACCESS_BYPASS_HEADER`). */
const BYPASS_HEADER = 'x-test-access-bypass';
const PUBLIC_PATH = '/public';
/** The record the public page shows. */
const PUBLIC_RECORD = 'counters:main';

/**
 * A page's HTML, which says the revision it was rendered at, as the application's pages do, and the
 * deployment that rendered it where there is one.
 */
function rendered(revision: number, status: number, deployment: string | undefined): Response {
  const by = deployment === undefined ? '' : ` data-deployment="${deployment}"`;
  return new Response(`<main data-revision="${String(revision)}"${by}>page</main>`, {
    headers: { 'Content-Type': 'text/html' },
    status,
  });
}

/**
 * A site for this test: `fetch` stubbed to answer for it, and given back when the test ends. The
 * pages besides the public page are named by their paths, each with the record it shows.
 */
export function fakeSite(others: Readonly<Record<string, string>> = {}): FakeSite {
  const records = new Map([[PUBLIC_PATH, PUBLIC_RECORD], ...Object.entries(others)]);
  const pages = new Map<string, OtherPage>(
    Object.keys(others).map((path) => [path, { reads: [], shown: 0, status: 200 }]),
  );
  /** The revision a page shows from its next request on, by path, once a change named its record. */
  const rendering = new Map<string, number>();
  /** The revision a page shows once it answered the request made of it now. */
  const renderedNext = (path: string, shown: number): number => {
    const next = rendering.get(path) ?? shown;
    rendering.delete(path);
    return next;
  };
  const site: FakeSite = {
    fetch: vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      const bypass = request.headers.get(BYPASS_HEADER);
      if (pathname === '/api/internal/changes' && request.method === 'POST') {
        const body = await request.json<{
          readonly changed?: unknown;
          readonly revision?: unknown;
        }>();
        site.posted.push({ body, bypass, token: request.headers.get(INTERNAL_HEADER) });
        const changed: readonly unknown[] = Array.isArray(body.changed) ? body.changed : [];
        for (const [path, record] of records) {
          if (site.status === 200 && changed.includes(record)) {
            rendering.set(path, Number(body.revision));
          }
        }
        return Response.json({ deployment: site.deployment }, { status: site.status });
      }
      if (pathname === PUBLIC_PATH && request.method === 'GET') {
        site.reads.push({ bypass });
        const answer = rendered(site.shown, site.pageStatus, site.deployment);
        site.shown = renderedNext(pathname, site.shown);
        return answer;
      }
      const page = request.method === 'GET' ? pages.get(pathname) : undefined;
      if (page === undefined) {
        return new Response(null, { status: 404 });
      }
      page.reads.push({ bypass });
      const answer = rendered(page.shown, page.status, site.deployment);
      page.shown = renderedNext(pathname, page.shown);
      return answer;
    }),
    page: (path) => {
      const page = pages.get(path);
      if (page === undefined) {
        throw new Error(`The site has no page ${path}.`);
      }
      return page;
    },
    deployment: undefined,
    pageStatus: 200,
    posted: [],
    reads: [],
    shown: 0,
    status: 200,
  };
  vi.stubGlobal('fetch', site.fetch);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return site;
}

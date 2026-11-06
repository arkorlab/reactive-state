import { db } from '@/db';

export { ExternalAuthority } from './external-store-fixture.ts';

import { authorityObject } from '../../src/cloudflare/index.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../../src/program.ts';
import type { MiddlewareProgram, RouteRegistration } from '../../src/routing.ts';
import { forbidden } from '../../src/server/index.ts';
import { BUILD, operations, programs } from '../support/program.ts';

/**
 * The Worker the Durable Object's suites run in: the authority for the test application — its
 * programs and its server operations, as a compile registers them, and its database through
 * `@/db`, as an application's Durable Object module imports it — and nothing else of its own. Its
 * one public page is `/public`, which shows the counter `main`.
 *
 * Its change log goes out a minute after a commit, where the object's own default is a second: long
 * enough that no alarm fires on its own while a test runs, so that a suite runs each one itself
 * (`runDurableObjectAlarm`) and the real one never races it.
 *
 * It registers two routes, each a shared view as a compile registers one: `/counters/[id]`, whose
 * root shows a counter's count to every visitor and refuses a counter there is not; and
 * `/guarded/[id]`, whose middleware's guard refuses one there is not before its root — the same
 * board, under a name of its own, as a root is one route's — is evaluated.
 */

const counterBoard: ComponentProgram = {
  buildId: BUILD,
  component: 'components/counter-board',
  evaluate: async (props, $) => {
    const counter = await db.counters.get(String(props['id']));
    if (counter === null) {
      forbidden();
    }
    return $.h('p', null, `count: ${String(counter.count)}`);
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** The board `/guarded/[id]` renders: the counters' own, a root of its own. */
const guardedBoard: ComponentProgram = { ...counterBoard, component: 'components/guarded-board' };

const counters: RouteRegistration = {
  blocking: true,
  middleware: [],
  page: 'counters/[id]/page.tsx',
  params: ['id'],
  props: { id: 'id' },
  root: 'components/counter-board',
  route: '/counters/[id]',
  shared: true,
};

const guarded: RouteRegistration = {
  ...counters,
  guarded: true,
  middleware: ['guarded'],
  page: 'guarded/[id]/page.tsx',
  root: guardedBoard.component,
  route: '/guarded/[id]',
};

/** The guard of `/guarded/[id]`'s middleware: a counter there is not is refused. */
const guardedMiddleware: MiddlewareProgram = {
  buildId: BUILD,
  guard: async ({ params }) => {
    if ((await db.counters.get(params['id'] ?? '')) === null) {
      forbidden();
    }
  },
  id: 'guarded',
  protocolVersion: PROTOCOL_VERSION,
};

const application = {
  database: db,
  middleware: { guarded: guardedMiddleware },
  operations,
  programs: [...programs, counterBoard, guardedBoard],
  routes: [counters, guarded],
};

export const TestAuthority = authorityObject(application, {
  deliveryDelayMs: 60_000,
  pages: [{ path: '/public', resources: ['counters:main'] }],
});

/** The same application with no view shared (`shareViews: false`): each rendered for its request. */
export const UnsharedAuthority = authorityObject(
  { ...application, shareViews: false },
  { deliveryDelayMs: 60_000 },
);

/** The same application signing its users in itself (`sessions: 'asserted'`): no demo sign-in. */
export const AssertedAuthority = authorityObject(
  { ...application, sessions: 'asserted' },
  { deliveryDelayMs: 60_000 },
);

/**
 * The Worker's own answer: at `/coded`, the request's body sent back as it is (`encodeBody:
 * 'manual'`) under the `Content-Encoding` `?coding=` says, for `coding.test.ts` to read through
 * workerd's own `fetch`; nothing anywhere else.
 */
// eslint-disable-next-line import-x/no-default-export -- a Worker module's own shape
export default {
  fetch: (request) => {
    const url = new URL(request.url);
    const coding = url.searchParams.get('coding');
    if (coding === null || url.pathname !== '/coded') {
      return new Response(null, { status: 404 });
    }
    return new Response(request.body, {
      encodeBody: 'manual',
      headers: { 'content-encoding': coding, 'content-type': 'text/html' },
    });
  },
} satisfies ExportedHandler;

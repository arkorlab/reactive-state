import { keptLines, type PrefetchLife, prefetchLines } from './emit-host.ts';

/**
 * What a compile writes of a build whose roots the deployment's cache keeps (`--prefetch-cache
 * remote`). A root it keeps has an entry of three functions. The first reads the session inside
 * `'use cache: private'`, of the prefetch's lifetime — a runtime prefetch includes a private cache,
 * where the session source's I/O and a read of the clock outside one would leave the root out of
 * it — and answers it where its roots may be kept (`keptSessionOf`): an application's own before
 * its `expires`. The entry hands what it answered, with the props, to the second, outside that
 * private cache, which renders the root inside `'use cache: remote'`, keyed by the two and tagged
 * by buckets of the session (`keptRootTag`) and of its user (`keptUserTag`): Next.js nests neither
 * of the two caches inside the other. Neither function is exported: a caller could else ask the
 * second for another session's render. Where the first answers none — no session, one past its
 * `expires` — the root is rendered as it comes, nothing of it kept, and `renderRoot` reads the
 * request's session itself. Beside the Server Functions every build writes is `expire`, which a
 * page calls in place of the router's refresh for a session that ended, changed or was refused,
 * and whose answer renders the route again.
 */

/** What the entry of a root the deployment's cache keeps imports of Next.js. */
export const KEPT_IMPORTS: readonly string[] = [
  "import { cacheLife, cacheTag } from 'next/cache';",
  '',
];

/** What a kept root's entry writes of its root. */
export interface KeptRoot {
  /** The component's name, which the entry's default export takes. */
  readonly name: string;
  /** The component's id, as a literal of it. */
  readonly id: string;
  /** The type of the props a page renders the root with; none of a component of no parameter. */
  readonly props: string | undefined;
  /** How long the deployment's cache keeps the render: the prefetch's lifetime. */
  readonly life: PrefetchLife;
  /** The name of the function that keeps it, which no other name of the entry's takes. */
  readonly kept: string;
  /** The name of the function that reads the session it is kept for, which no other name takes. */
  readonly asks: string;
}

/**
 * The body of a kept root's entry, after its imports: the export, the function that reads the
 * session inside the private cache, and the function that keeps the root.
 */
export function keptBody(root: KeptRoot): readonly string[] {
  const { asks, id, kept, life, name, props } = root;
  const asserted = 'session: Parameters<typeof keptRootTag>[0]';
  const exported = props === undefined ? '' : `props: ${props}`;
  const keeping = props === undefined ? asserted : `${asserted}, ${exported}`;
  const handed = props === undefined ? 'session' : 'session, props';
  const field = props === undefined ? 'props: {}' : 'props';
  return [
    `export default async function ${name}(${exported}) {`,
    `  const session = await ${asks}();`,
    '  return session === null',
    `    ? renderRoot({ component: ${id}, elements, ${field}, expire, update, view })`,
    `    : ${kept}(${handed});`,
    '}',
    '',
    "/** The request's session, where the deployment's cache may keep its roots, and none where not: read inside a private cache, which a runtime prefetch includes, so that the session source's I/O and the clock are read there. */",
    `async function ${asks}() {`,
    ...prefetchLines(life),
    '  return keptSessionOf(await requestSession(elements.session));',
    '}',
    '',
    "/** The root as `session` sees it, kept in the deployment's cache by the session and the props: not exported, so that no caller names another session. */",
    `async function ${kept}(${keeping}) {`,
    ...keptLines(life),
    `  return renderRoot({ component: ${id}, elements, ${field}, session, prefetchable: true, expire, update, view });`,
    '}',
    '',
  ];
}

/**
 * The `expire` Server Function (`server-functions.ts`): the kept roots of the session the request
 * is of expired, and the route rendered again in the same answer. It is given nothing, so that no
 * caller chooses what it expires: its own session's bucket (`keptRootTag`).
 */
export const EXPIRE_FUNCTION: readonly string[] = [
  '/**',
  " * The roots the deployment's cache keeps of the caller's session expired, and the route rendered",
  " * again in the same answer: what a page asks for in place of the router's refresh, for a session",
  " * that ended, changed or was refused. Of the request's own session and the others of its tag's",
  ' * bucket: it is given nothing, so no caller names another session.',
  ' */',
  'export async function expire(): Promise<void> {',
  '  await expireKeptRoots(elements.session);',
  '  refresh();',
  '}',
  '',
];

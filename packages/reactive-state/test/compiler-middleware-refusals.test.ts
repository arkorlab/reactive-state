import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import {
  application,
  type Application,
  compiledApp,
  positionOf,
  refusalOf,
  removed,
} from './fixtures/application.ts';

/**
 * What the compile refuses of a route middleware — whatever it cannot split at `await next()` into a
 * guard the authority runs again with the route's params alone, and an envelope the host runs for
 * each request — each where it stands, in words that say why. A guard is never left out: a
 * middleware it cannot split is refused, not run around.
 */

const FILE = 'app/boards/[projectId]/middleware.ts';

/** A source file of `lines`. */
function file(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** A middleware of `parameters` and `body` (lines of it), with the imports a case reads. */
function middleware(parameters: string, ...body: readonly string[]): string {
  return file(
    "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
    "import { requireUser } from '@/auth';",
    "import { requirePublishedProject } from '@/publication';",
    '',
    `export default (async (${parameters}) => {`,
    ...body.map((line) => `  ${line}`),
    '}) satisfies RouteMiddleware<{ projectId: string }>;',
  );
}

/** A guard over the project's routes, of the session's identity. */
const PROJECTS_GUARD: Readonly<Record<string, string>> = {
  'app/projects/middleware.ts': file(
    "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
    "import { requireUser } from '@/auth';",
    '',
    'export default (async (_context, next) => {',
    '  await requireUser();',
    '  return next();',
    '}) satisfies RouteMiddleware;',
  ),
};

interface Refused {
  readonly what: string;
  readonly text: string;
  /** Where in the text the refusal stands. */
  readonly marker: string;
  /** What the reason opens with. */
  readonly reason: string;
  /** The file's path in `src`, where it is not the boards middleware. */
  readonly file?: string;
  /** Other files of the application, by their path in `src`. */
  readonly beside?: Readonly<Record<string, string>>;
}

const REFUSED: readonly Refused[] = [
  {
    marker: 'request.headers',
    reason: 'Where it reads `request`, the guard — what the middleware runs before `next`',
    text: middleware(
      '{ params, request }, next',
      "await requirePublishedProject(request.headers.get('x-project') ?? params.projectId);",
      'return next();',
    ),
    what: 'a guard that reads the request',
  },
  {
    marker: 'context)',
    reason: 'Where it reads `context`, the guard',
    text: middleware(
      'context, next',
      'await requirePublishedProject(String(context));',
      'return next();',
    ),
    what: 'a guard that reads the context whole',
  },
  {
    marker: 'requestId);',
    reason: 'The guard reads `requestId`, which the middleware computes of the request',
    text: middleware(
      '_context, next',
      'const requestId = crypto.randomUUID();',
      'await requirePublishedProject(requestId);',
      'return next();',
    ),
    what: 'a guard that reads what the envelope computes',
  },
  {
    marker: 'startedAt));',
    reason: 'The guard reads `startedAt`, which the middleware computes of the request',
    text: middleware(
      '{ params }, next',
      'const startedAt = Date.now();',
      'const ids = [params.projectId].map((Date) => Date);',
      'await requirePublishedProject(ids.join() + String(startedAt));',
      'return next();',
    ),
    what: 'a guard that reads a constant of the clock, though a callback of the middleware names a parameter `Date`',
  },
  {
    marker: 'user.id',
    reason: "After `next`, the middleware reads `user`, which is the guard's",
    text: middleware(
      '_context, next',
      'const user = await requireUser();',
      'const response = await next();',
      "response.headers.set('X-User', user.id);",
      'return response;',
    ),
    what: 'an after part that reads what the guard computed',
  },
  {
    marker: 'response.text()',
    reason: "After `await next()`, a route middleware reads and sets the response's headers",
    text: middleware(
      '_context, next',
      'const response = await next();',
      'const text = await response.text();',
      "response.headers.set('X-Length', String(text.length));",
      'return response;',
    ),
    what: 'an after part that reads the body',
  },
  {
    marker: "console.log('served');",
    reason: "After `await next()`, a route middleware reads and sets the response's headers",
    text: middleware(
      '_context, next',
      'const response = await next();',
      "console.log('served');",
      'return response;',
    ),
    what: 'an after part that does more than set headers',
  },
  {
    marker: "response.headers.set('X', '1');\n}",
    reason: "After `await next()`, a route middleware reads and sets the response's headers",
    text: middleware(
      '_context, next',
      'const response = await next();',
      "response.headers.set('X', '1');",
    ),
    what: 'an after part that does not return the response',
  },
  {
    marker: 'next();\n})',
    reason: '`next` is called once',
    text: middleware('_context, next', 'await next();', 'return next();'),
    what: '`next` called twice',
  },
  {
    marker: 'next();\n  }',
    reason: '`next` is called once',
    text: middleware(
      '{ params }, next',
      "if (params.projectId !== '') {",
      '  return next();',
      '}',
      "return new Response('none');",
    ),
    what: '`next` called in a condition',
  },
  {
    marker: 'next);',
    reason: '`next` is called once',
    text: middleware('_context, next', 'return Promise.resolve().then(next);'),
    what: '`next` handed on',
  },
  {
    marker: 'async (',
    reason: 'A route middleware calls `next` once, at the top level of its body',
    text: middleware('_context, _next', "return new Response('closed');"),
    what: '`next` never called',
  },
  {
    marker: 'async (',
    reason: 'A route middleware calls `next` once, at the top level of its body',
    text: middleware('_context, _next'),
    what: 'an empty body, which never calls `next`',
  },
  {
    marker: "const late = 'late';",
    reason: 'Nothing follows `return next()`',
    text: middleware('_context, next', 'return next();', "const late = 'late';"),
    what: 'a statement after `return next()`',
  },
  {
    marker: "Response.redirect('https://example.com/')",
    reason:
      'A guard — what a route middleware runs before `next` — answers by `return new Response(body, { status, headers })`',
    text: middleware(
      '{ params }, next',
      'const project = await requirePublishedProject(params.projectId);',
      "if (project.title === '') return Response.redirect('https://example.com/');",
      'return next();',
    ),
    what: 'a guard that answers a response it does not make',
  },
  {
    marker: 'init);',
    reason: "A guard's response is given its status and its headers in an object literal",
    text: middleware(
      '{ params }, next',
      'const init = { status: 403 };',
      'const project = await requirePublishedProject(params.projectId);',
      "if (project.title === '') return new Response('no', init);",
      'return next();',
    ),
    what: 'a response of an init the compile cannot read',
  },
  {
    marker: 'status: 404 }',
    reason: "The response's init gives `status` twice",
    text: middleware(
      '{ params }, next',
      "if (params.projectId === 'closed') return new Response(null, { status: 403, status: 404 });",
      'await requirePublishedProject(params.projectId);',
      'return next();',
    ),
    what: 'a response of an init that gives its status twice',
  },
  {
    marker: "__proto__: 'x'",
    reason:
      "A guard's response headers, in an object literal, are its own properties, each named once",
    text: middleware(
      '{ params }, next',
      "if (params.projectId === 'closed') return new Response(null, { status: 403, headers: { __proto__: 'x' } });",
      'return next();',
    ),
    what: 'response headers of an object literal’s prototype',
  },
  {
    marker: "'x-reason': 'second'",
    reason:
      "A guard's response headers, in an object literal, are its own properties, each named once",
    text: middleware(
      '{ params }, next',
      "if (params.projectId === 'closed') return new Response(null, { status: 403, headers: { 'x-reason': 'first', 'x-reason': 'second' } });",
      'return next();',
    ),
    what: 'response headers of an object literal that names one twice',
  },
  {
    marker: 'vary }',
    reason:
      "A guard's response headers, in an object literal, are its own properties, each named once",
    text: middleware(
      '{ params }, next',
      "const vary = 'cookie';",
      "if (params.projectId === 'closed') return new Response(null, { status: 403, headers: { vary: 'accept', vary } });",
      'return next();',
    ),
    what: 'response headers that name one twice, the second time shorthand',
  },
  {
    marker: "404: 'Not found'",
    reason:
      "A guard's response headers, in an object literal, are read in the order of the object's keys",
    text: middleware(
      '{ params }, next',
      "if (params.projectId === 'closed') return new Response(null, { status: 403, headers: { 'x-reason': 'closed', 404: 'Not found' } });",
      'return next();',
    ),
    what: 'response headers of an object literal that names one by an array index',
  },
  {
    marker: "'4294967294': 'last'",
    reason:
      "A guard's response headers, in an object literal, are read in the order of the object's keys",
    text: middleware(
      '{ params }, next',
      "if (params.projectId === 'closed') return new Response(null, { status: 403, headers: { '01': 'leading', 4294967295: 'past', '4294967294': 'last' } });",
      'return next();',
    ),
    what: 'response headers of an object literal that names one by the last array index, after names of digits that are none: a leading zero, 2³² − 1',
  },
  {
    marker: "statusText: 'No'",
    reason: "A guard's response is given its status and its headers in an object literal",
    text: middleware(
      '{ params }, next',
      'const project = await requirePublishedProject(params.projectId);',
      "if (project.title === '') return new Response('no', { status: 403, statusText: 'No' });",
      'return next();',
    ),
    what: 'a response of a status text',
  },
  {
    marker: "new Blob(['no'])",
    reason: "A guard's response holds text",
    text: middleware(
      '{ params }, next',
      'const project = await requirePublishedProject(params.projectId);',
      "if (project.title === '') return new Response(new Blob(['no']), { status: 403 });",
      'return next();',
    ),
    what: 'a response of a body that is no text',
  },
  {
    marker: '304 }',
    reason: "A guard's response of a status that has no body — 204, 205 or 304 — holds none",
    text: middleware(
      '{ params }, next',
      'const project = await requirePublishedProject(params.projectId);',
      "if (project.title === '') return new Response('', { status: 304 });",
      'return next();',
    ),
    what: 'a response of an empty text, of a status that has no body',
  },
  {
    marker: '204.5 }',
    reason: "A guard's response of a status that has no body — 204, 205 or 304 — holds none",
    text: middleware(
      '{ params }, next',
      'const project = await requirePublishedProject(params.projectId);',
      "if (project.title === '') return new Response('No change', { status: 204.5 });",
      'return next();',
    ),
    what: 'a response of text, of a status `new Response` makes one that has no body of',
  },
  {
    marker: "new Blob(['no']))",
    reason: "A guard's response holds text",
    text: middleware(
      '{ params }, next',
      'const project = await requirePublishedProject(params.projectId);',
      "if (project.title === '') return new Response(project.published ? null : (params.projectId === 'p1' ? 'No' : new Blob(['no'])), { status: 403 });",
      'return next();',
    ),
    what: 'a response of a body that is no text on a branch of a condition',
  },
  {
    marker: '304 }',
    reason: "A guard's response of a status that has no body — 204, 205 or 304 — holds none",
    text: middleware(
      '{ params }, next',
      'const project = await requirePublishedProject(params.projectId);',
      "if (project.title === '') return new Response(project.published ? null : 'Not modified', { status: 304 });",
      'return next();',
    ),
    what: 'a response of text on a branch of a condition, of a status that has no body',
  },
  {
    marker: 'name, ',
    reason: "A guard's response of text names its headers as they are written",
    text: middleware(
      '{ params }, next',
      "const name = 'vary';",
      'const project = await requirePublishedProject(params.projectId);',
      "if (project.title === '') return new Response('no', { headers: [[name, 'cookie']] });",
      'return next();',
    ),
    what: 'a response of text whose header the compile cannot tell from its content type',
  },
  {
    beside: {
      'nonce.ts': file(
        'export function makeNonce(): string {',
        '  return String(Math.random());',
        '}',
      ),
    },
    marker: 'const nonce',
    reason:
      '`nonce`, read by the guard — which the authority runs — and by what the host runs around each request, before `next` or after it, would be computed by each of them',
    text: file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      "import { makeNonce } from '@/nonce';",
      "import { requirePublishedProject } from '@/publication';",
      '',
      'export default (async ({ params }, next) => {',
      '  const nonce = makeNonce();',
      '  await requirePublishedProject(params.projectId + nonce.slice(0, 0));',
      '  const response = await next();',
      "  response.headers.set('X-Nonce', nonce);",
      '  return response;',
      '}) satisfies RouteMiddleware<{ projectId: string }>;',
    ),
    what: 'a constant of an imported call both the guard and what follows `next` read',
  },
  {
    marker: 'crypto.randomUUID() } }',
    reason:
      '`tenant`, read by the guard — which the authority runs — and by what the host runs around each request, before `next` or after it, would be bound by each of them',
    text: file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      "import { requirePublishedProject } from '@/publication';",
      '',
      'export default (async ({ params: { projectId, tenant = crypto.randomUUID() } }, next) => {',
      '  await requirePublishedProject(projectId + tenant.slice(0, 0));',
      '  const response = await next();',
      "  response.headers.set('X-Tenant', tenant);",
      '  return response;',
      '}) satisfies RouteMiddleware<{ projectId: string; tenant?: string }>;',
    ),
    what: 'a default of the context’s pattern of a global both the guard and what follows `next` read',
  },
  {
    marker: 'const flagged',
    reason: '`flagged`, read by the guard',
    text: middleware(
      '{ params }, next',
      "const flagged = process.env['FLAG'] === 'on';",
      "await requirePublishedProject(flagged ? params.projectId : params.projectId + '-off');",
      'const response = await next();',
      "response.headers.set('X-Flag', String(flagged));",
      'return response;',
    ),
    what: 'a constant of a global both the guard and what follows `next` read',
  },
  {
    marker: 'notFound();',
    reason: "The guard reads `notFound`, of React's or Next.js's",
    text: file(
      "import { notFound } from 'next/navigation';",
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      "import { requirePublishedProject } from '@/publication';",
      '',
      'export default (async ({ params }, next) => {',
      '  const project = await requirePublishedProject(params.projectId);',
      "  if (project.title === '') notFound();",
      '  return next();',
      '}) satisfies RouteMiddleware<{ projectId: string }>;',
    ),
    what: 'a guard that reads Next.js',
  },
  {
    marker: 'PublicBoard;',
    reason: '`PublicBoard` is a component, a Client Component or a hook',
    text: file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      "import PublicBoard from '@/components/public-board.reactive';",
      '',
      'export default (async (_context, next) => {',
      '  const rendered = PublicBoard;',
      '  const response = await next();',
      "  response.headers.set('X', String(rendered));",
      '  return response;',
      '}) satisfies RouteMiddleware;',
    ),
    what: 'a middleware that reads a component',
  },
  {
    marker: "import('@/publication')",
    reason: 'A route middleware imports nothing at run time',
    text: middleware(
      '{ params }, next',
      "const { requirePublishedProject: loaded } = await import('@/publication');",
      'await loaded(params.projectId);',
      'return next();',
    ),
    what: 'an import made at run time',
  },
  {
    marker: 'user) => user',
    reason: "`user` is one of the route middleware's own names",
    text: middleware(
      '_context, next',
      'const user = await requireUser();',
      '[user].map((user) => user);',
      'return next();',
    ),
    what: 'a name of the middleware declared again inside it',
  },
  {
    marker: 'user) => user',
    reason: "`user` is one of the route middleware's own names",
    text: middleware(
      '_context, next',
      'const user = await requireUser();',
      'const named: (user: string) => string = (user) => user;',
      'named(user.id);',
      'return next();',
    ),
    what: 'a function whose type names its parameter as it does, declaring a name of the middleware again',
  },
  {
    marker: 'user: string): string {',
    reason: "`user` is one of the route middleware's own names",
    text: middleware(
      '_context, next',
      'const user = await requireUser();',
      'function named(user: string): string;',
      'function named(user: string): string {',
      '  return user;',
      '}',
      'named(user.id);',
      'return next();',
    ),
    what: 'an overload’s implementation declaring a name of the middleware again, as its signature does',
  },
  {
    marker: 'user: string): string {',
    reason: "`user` is one of the route middleware's own names",
    text: middleware(
      '_context, next',
      'const user = await requireUser();',
      'class Named {',
      '  [user: string]: unknown;',
      '  named(user: string): string {',
      '    return user;',
      '  }',
      '}',
      'new Named().named(user.id);',
      'return next();',
    ),
    what: 'a method declaring a name of the middleware again, in a class whose index signature names it too',
  },
  {
    marker: '...context',
    reason: "A route middleware's context is destructured by its props, `params` and `request`",
    text: middleware(
      '{ ...context }, next',
      'await requirePublishedProject(String(context));',
      'return next();',
    ),
    what: 'a context destructured into a rest',
  },
  {
    marker: '...rest',
    reason: "A route middleware's context is destructured by name at every depth",
    text: middleware(
      '{ params: { projectId, ...rest } }, next',
      'await requirePublishedProject(projectId + Object.keys(rest).join());',
      'return next();',
    ),
    what: 'a context’s params destructured into a rest',
  },
  {
    marker: 'request.url',
    reason: 'Where it reads `request`, the guard',
    text: middleware(
      '{ request, params: { projectId = request.url } }, next',
      'await requirePublishedProject(projectId);',
      'return next();',
    ),
    what: 'a default of the context’s pattern the guard binds, of the request',
  },
  {
    marker: 'requirePublishedProject) }',
    reason:
      "A default of the route middleware's context reads `requirePublishedProject`, which runs on the authority alone, where the host binds it",
    text: middleware(
      '{ params: { projectId = String(requirePublishedProject) } }, next',
      'const response = await next();',
      "response.headers.set('X-Project', projectId);",
      'return response;',
    ),
    what: 'a default of the context’s pattern the host binds, of what runs on the authority alone',
  },
  {
    marker: "const HEADER = 'X-Board';",
    reason: 'A route middleware file holds its imports and its `export default` alone',
    text: `${middleware('_context, next', 'return next();')}const HEADER = 'X-Board';\n`,
    what: 'code beside the middleware',
  },
  {
    marker: 'context = {}',
    reason: 'A route middleware takes its context and `next`',
    text: file(
      'export default (async (context = {}, next = () => Promise.resolve(new Response())) => next());',
    ),
    what: 'parameters of defaults',
  },
  {
    marker: 'guard }',
    reason: '`guard` is a name the parts of a route middleware declare themselves',
    text: file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      "import { requirePublishedProject as guard } from '@/publication';",
      '',
      'export default (async ({ params }, next) => {',
      '  await guard(params.projectId);',
      '  return next();',
      '}) satisfies RouteMiddleware<{ projectId: string }>;',
    ),
    what: 'an import under a name the parts declare',
  },
  {
    marker: 'buildId }',
    reason: '`buildId` is a name an output declares itself',
    text: file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      "import { requirePublishedProject as buildId } from '@/publication';",
      '',
      'export default (async ({ params }, next) => {',
      '  await buildId(params.projectId);',
      '  return next();',
      '}) satisfies RouteMiddleware<{ projectId: string }>;',
    ),
    what: 'an import under a name the guard program declares',
  },
  {
    beside: {
      'app/boards/[projectId]/middleware.ts': middleware(
        '{ params }, next',
        'await requirePublishedProject(params.projectId);',
        'return next();',
      ),
    },
    file: 'app/boards/[projectId]/page.tsx',
    marker: '<PublicBoard projectId="p1" />',
    reason:
      '`/boards/[projectId]` renders `components/public-board` without its param `projectId`, of which the guard of `app/boards/[projectId]/middleware.ts` reads its params',
    text: file(
      "import PublicBoard from '@/components/public-board.reactive';",
      '',
      'export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {',
      '  const { projectId: _projectId } = await params;',
      '  return <PublicBoard projectId="p1" />;',
      '}',
    ),
    what: 'a root given too few of the params a guard of its route reads',
  },
  {
    marker: 'const body',
    reason:
      '`const body = await request.text();` runs before `next` for each request, which the host runs ahead of the route, and of the guard the middleware writes before it (`await requirePublishedProject(params.projectId);`)',
    text: middleware(
      '{ params, request }, next',
      'await requirePublishedProject(params.projectId);',
      'const body = await request.text();',
      'const response = await next();',
      "response.headers.set('X-Length', String(body.length));",
      'return response;',
    ),
    what: 'what runs before `next` for each request, written after the guard',
  },
  {
    beside: {
      'app/boards/[projectId]/middleware.ts': middleware(
        '{ params }, next',
        'await requirePublishedProject(params.projectId);',
        'return next();',
      ),
    },
    file: 'app/boards/[projectId]/stats/middleware.ts',
    marker: 'const requestId',
    reason:
      '`const requestId = crypto.randomUUID();` runs before `next` for each request, which the host runs ahead of the route, and of the guard of `app/boards/[projectId]/middleware.ts`, around this middleware',
    text: middleware(
      '_context, next',
      'const requestId = crypto.randomUUID();',
      'const response = await next();',
      "response.headers.set('X-Request', requestId);",
      'return response;',
    ),
    what: 'what runs before `next` for each request, in a middleware inside one with a guard',
  },
  {
    beside: PROJECTS_GUARD,
    file: 'app/projects/[projectId]/page.tsx',
    marker: 'import Project',
    reason:
      '`components/project` is rendered by `projects/[projectId]/page.tsx` under the guard of `app/projects/middleware.ts`, but the page is written in no shape the compile registers a route of',
    text: file(
      "import Project from '@/components/project.reactive';",
      '',
      'export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {',
      '  const { projectId } = await params;',
      '  return <Project projectId={projectId.trim()} filter="all" />;',
      '}',
    ),
    what: 'a root rendered under a guard by a page of no registered shape',
  },
  {
    beside: PROJECTS_GUARD,
    file: 'app/projects/[projectId]/page.tsx',
    marker: 'import Project',
    reason:
      '`components/project` is rendered by `projects/[projectId]/page.tsx` under the guard of `app/projects/middleware.ts`, but the page is written in no shape the compile registers a route of — one reactive root, rendered whatever path the page takes',
    text: file(
      "import Project from '@/components/project.reactive';",
      '',
      'export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {',
      '  const { projectId } = await params;',
      '  return projectId.length > 0 ? <Project projectId={projectId} filter="all" /> : null;',
      '}',
    ),
    what: 'a root rendered under a guard by a page that renders it on some of its paths alone',
  },
  {
    file: 'app/boards/middleware.js',
    marker: 'export',
    reason: 'A route middleware is written as `middleware.ts`',
    text: file('export default async (_context, next) => next();'),
    what: 'a middleware of another extension',
  },
];

describe('what the compile refuses of a route middleware', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const each of apps) {
      await removed(each);
    }
  });

  it.each(REFUSED)('refuses $what, where it stands', async (refused) => {
    const name = refused.file ?? FILE;
    const app = await application({ ...refused.beside, [name]: refused.text });
    apps.push(app);
    const refusal = refusalOf(compiledApp(app, api));
    const at = positionOf(refused.text, refused.marker);

    expect(refusal.fileName).toBe(name);
    expect(refusal.reason.startsWith(refused.reason)).toBe(true);
    expect([refusal.line, refusal.column]).toStrictEqual([at.line, at.column]);
  });
});

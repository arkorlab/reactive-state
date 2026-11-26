import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Compiled, openTypeScript, writeOutputs } from '../src/compiler/index.ts';
import {
  isPlainRoute,
  type MiddlewareRegistration,
  type RegisteredRoute,
  type RouteRegistration,
} from '../src/routing.ts';
import type { RouteMiddleware } from '../src/server/index.ts';
import {
  application,
  type Application,
  compiledApp,
  node,
  output,
  removed,
  variantSource,
} from './fixtures/application.ts';

/**
 * What a compile makes of route middleware: each `middleware.ts` of the
 * app directory found, each route's chain of them, outermost first, and each split at its
 * `await next()` into the guard the authority runs — with the route's params alone, wherever the
 * route's preconditions are checked — and the envelope the host runs around each request: what it
 * computes of the request before `next`, and what it does to the response's headers after it.
 */

/** The files of input M, by their path in `src`. */
const M_FILES = [
  'app/boards/[projectId]/middleware.ts',
  'app/middleware.ts',
  'app/projects/[projectId]/publication/middleware.ts',
  'components/public-board.reactive.tsx',
  'components/publication-settings.reactive.tsx',
] as const;

/** The files of input X, by their path in `src`. */
const X_FILES = ['app/middleware.ts', 'app/projects/middleware.ts'] as const;

const PACKAGE = fileURLToPath(new URL('../', import.meta.url));

async function variantFiles(
  name: string,
  files: readonly string[],
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    files.map(async (each) => [each, await variantSource(name, each)] as const),
  );
  return Object.fromEntries(entries);
}

/** A source file of `lines`. */
function file(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

interface Manifested {
  readonly routes: readonly RegisteredRoute[];
  readonly middleware: readonly MiddlewareRegistration[];
}

function manifestOf(compiled: Compiled, app: Application): Manifested {
  return JSON.parse(output(compiled, app, 'manifest.json')) as Manifested;
}

/** The reactive routes the manifest registers, in its order. */
function reactiveOf(manifest: Manifested): readonly RouteRegistration[] {
  return manifest.routes.flatMap((route) => (isPlainRoute(route) ? [] : [route]));
}

/** Runs `body`, an expression of `registry` — the authority's registry — in a Node of its own. */
function inAuthority(app: Application, body: string): unknown {
  const paths = path.join(import.meta.dirname, '../src/authority/paths.ts');
  const ran = node(
    [
      `import { registerPaths } from ${JSON.stringify(paths)};`,
      `registerPaths(${JSON.stringify(app.tsconfig)});`,
      `const registry = await import(${JSON.stringify(path.join(app.out, 'authority.mts'))});`,
      `process.stdout.write(JSON.stringify(${body}));`,
    ].join('\n'),
    app.root,
  );
  if (ran.status !== 0) {
    throw new Error(ran.stderr);
  }
  return JSON.parse(ran.stdout) as unknown;
}

/** What `next` answers a middleware run as the source holds it (`natively`): the route's response. */
function routeAnswer(): Promise<Response> {
  return Promise.resolve(new Response());
}

/**
 * A throw as a test reads it: what `new Response` throws — a `TypeError`, a `RangeError`, whose
 * message each platform words its own way — by its kind, and anything else as `String` writes it.
 */
function thrownAs(error: unknown): string {
  return error instanceof TypeError || error instanceof RangeError ? error.name : String(error);
}

/** `thrownAs`, as the program a guard is run in writes it (`inAuthority`). */
const THROWN_AS =
  '(error) => (error instanceof TypeError || error instanceof RangeError ? error.name : String(error))';

/**
 * What the boards middleware of `app` answers for each of `asked`, the route's `projectId`, run as
 * the source holds it — `new Response` the platform's — as a guard's descriptor of it reads: its
 * headers by name, as a response holds them; or what it throws (`thrownAs`).
 */
async function natively(app: Application, asked: readonly string[]): Promise<readonly unknown[]> {
  const source = path.join(app.src, 'app/boards/[projectId]/middleware.ts');
  const { default: middleware } = (await import(/* @vite-ignore */ source)) as {
    readonly default: RouteMiddleware<{ projectId: string }>;
  };
  const request = new Request('https://example.com/');
  return Promise.all(
    asked.map(async (projectId) => {
      try {
        const response = await middleware({ params: { projectId }, request }, routeAnswer);
        const headers = Object.fromEntries(response.headers);
        return { body: await response.text(), headers, status: response.status };
      } catch (error) {
        return thrownAs(error);
      }
    }),
  );
}

/**
 * What the application's type check says of the files the compile wrote: its diagnostics of them
 * alone — the package's own sources, which other work changes beside this, are checked by its own.
 */
function diagnosticsOfOutputs(app: Application): readonly string[] {
  const tsc = path.join(PACKAGE, 'node_modules/typescript/bin/tsc');
  const ran = spawnSync(process.execPath, [tsc, '--noEmit', '-p', app.root], {
    cwd: app.root,
    encoding: 'utf8',
  });
  return `${ran.stdout}${ran.stderr}`
    .split('\n')
    .filter((line) => line.startsWith('.reactive/') || line.startsWith('src/'));
}

const BOARDS_GUARD = file(
  '// Generated by @arkorlab/reactive-state from app/boards/[projectId]/middleware.ts. Do not edit: change the middleware and compile it again.',
  "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
  "import { requirePublishedProject } from '@/publication';",
  '',
  'export const protocolVersion = 6;',
  'export const buildId = "b_BUILD";',
  'export const id = "boards/[projectId]";',
  '',
  "export async function guard({ params }: Pick<Parameters<RouteMiddleware<{ projectId: string }>>[0], 'params'>) {",
  '  await requirePublishedProject(params.projectId);',
  '}',
);

const ROOT_ENVELOPE = file(
  '// Generated by @arkorlab/reactive-state from app/middleware.ts. Do not edit: change the middleware and compile it again.',
  '',
  'export const id = "";',
  '',
  'export function before() {',
  "  // An actual request's envelope, never part of a reusable render artifact.",
  '  const requestId = crypto.randomUUID();',
  '  return { requestId };',
  '}',
  '',
  'type Handed = Awaited<ReturnType<typeof before>>;',
  '',
  'export function after(locals: Readonly<Record<string, unknown>>, response: Response): void {',
  '  const { requestId } = locals as Handed;',
  "  response.headers.set('X-V4-Request', requestId);",
  "  response.headers.append('X-V4-Middleware', 'root');",
  '}',
);

describe('the compile of Project Todo v4’s route middleware (M)', () => {
  let api: API;
  let app: Application;
  let compiled: Compiled;
  const read = (name: string): string =>
    output(compiled, app, name).replaceAll(compiled.buildId, 'b_BUILD');

  beforeAll(async () => {
    api = openTypeScript();
    app = await application(await variantFiles('v4-middleware', M_FILES));
    compiled = compiledApp(app, api);
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await removed(app);
  });

  it('finds each middleware of the app directory, and each route’s chain of them, outermost first', () => {
    const manifest = manifestOf(compiled, app);

    expect(compiled.refusals).toStrictEqual([]);
    expect(manifest.middleware).toStrictEqual([
      { envelope: true, guard: false, id: '', identity: false },
      { envelope: true, guard: true, id: 'boards/[projectId]', identity: false },
      { envelope: true, guard: true, id: 'projects/[projectId]/publication', identity: true },
    ]);
    expect(manifest.routes.map(({ middleware, route }) => ({ middleware, route }))).toStrictEqual([
      { middleware: [''], route: '/' },
      { middleware: ['', 'boards/[projectId]'], route: '/boards/[projectId]' },
      { middleware: [''], route: '/projects/[projectId]' },
      {
        middleware: ['', 'projects/[projectId]/publication'],
        route: '/projects/[projectId]/publication',
      },
    ]);
    // The home page renders no reactive root: it is delivered through the app's middleware all
    // the same, which has no guard to ask of it.
    expect(manifest.routes[0]).toStrictEqual({
      file: 'page.tsx',
      middleware: [''],
      params: [],
      plain: 'page',
      route: '/',
    });
    // No guard of the variant's answers a response of its own: no route's delivery asks for one.
    expect(manifest.routes.filter((route) => route.answers === true)).toStrictEqual([]);
    // A write is asked of the guards of a route a middleware of which has one: not of the project's,
    // whose one middleware is an envelope alone.
    expect(
      manifest.routes.filter((route) => route.guarded === true).map(({ route }) => route),
    ).toStrictEqual(['/boards/[projectId]', '/projects/[projectId]/publication']);
  });

  it('shares the board, whose guard reads no identity, and not the settings, whose guard does', () => {
    const [board, , settings] = reactiveOf(manifestOf(compiled, app));

    expect(board).toMatchObject({ root: 'components/public-board', shared: true });
    expect(settings).toMatchObject({
      private:
        "the guard of `app/projects/[projectId]/publication/middleware.ts` reads the session's identity (`requireUser`)",
      shared: false,
    });
  });

  it('writes the boards guard: what it reads of the database before `next`, run with the params', () => {
    expect(read('middleware/app/boards/[projectId].guard.mts')).toBe(BOARDS_GUARD);
  });

  it('writes the publication guard, which reads the session', () => {
    expect(read('middleware/app/projects/[projectId]/publication.guard.mts')).toContain(
      [
        "export async function guard({ params }: Pick<Parameters<RouteMiddleware<{ projectId: string }>>[0], 'params'>) {",
        '  const user = await requireUser();',
        '  await assertOwnsProject(user, params.projectId);',
        '}',
      ].join('\n'),
    );
  });

  it('writes the app’s middleware as an envelope alone: a request id for each request, and its headers', () => {
    expect(read('middleware/app.envelope.ts')).toBe(ROOT_ENVELOPE);
    expect(compiled.outputs.has(path.join(app.out, 'middleware/app.guard.mts'))).toBe(false);
  });

  it('writes what each guarded middleware does after `next`, and nothing of its guard, as its envelope', () => {
    expect(read('middleware/app/boards/[projectId].envelope.ts')).toBe(
      file(
        '// Generated by @arkorlab/reactive-state from app/boards/[projectId]/middleware.ts. Do not edit: change the middleware and compile it again.',
        '',
        'export const id = "boards/[projectId]";',
        '',
        'export function after(_locals: Readonly<Record<string, unknown>>, response: Response): void {',
        "  response.headers.append('X-V4-Middleware', 'boards');",
        '}',
      ),
    );
  });

  it('writes the host’s registry of the envelopes, and the authority’s of the guards, by id', () => {
    const routes = read('routes.ts');
    const registry = read('authority.mts');

    expect(routes).toContain(
      "import * as envelope$app$boards$_projectId_ from './middleware/app/boards/[projectId].envelope';",
    );
    expect(routes).toContain(
      [
        'export const envelopes: Readonly<Record<string, MiddlewareEnvelope>> = {',
        '  "": envelope$app,',
        '  "boards/[projectId]": envelope$app$boards$_projectId_,',
        '  "projects/[projectId]/publication": envelope$app$projects$_projectId_$publication,',
        '};',
      ].join('\n'),
    );
    expect(registry).toContain(
      "import * as guard$app$boards$_projectId_ from './middleware/app/boards/[projectId].guard.mts';",
    );
    // Every middleware, a guard's by its program, and one with none by `null`: none a route names
    // is one the authority was told nothing of.
    expect(registry).toContain(
      [
        'export const middleware: Readonly<Record<string, MiddlewareProgram | null>> = {',
        '  "": null,',
        '  "boards/[projectId]": guard$app$boards$_projectId_,',
        '  "projects/[projectId]/publication": guard$app$projects$_projectId_$publication,',
        '};',
      ].join('\n'),
    );
  });

  it('writes what the application’s type check accepts: guards, envelopes and both registries', () => {
    writeOutputs(compiled.outputs, app.out);

    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('writes guard programs the Node authority loads, each running the application’s own code', () => {
    writeOutputs(compiled.outputs, app.out);
    const loaded = inAuthority(
      app,
      `{
        programs: Object.fromEntries(Object.entries(registry.middleware).map(([id, program]) => [id, program && {
          build: program.buildId === registry.buildId,
          guard: typeof program.guard,
          id: program.id,
          protocolVersion: program.protocolVersion,
        }])),
        refused: await registry.middleware['boards/[projectId]'].guard({ params: { projectId: 'p1' } }).then(
          () => 'went on',
          (error) => error.message,
        ),
      }`,
    ) as { programs: unknown; refused: string };

    expect(loaded.programs).toStrictEqual({
      '': null,
      'boards/[projectId]': {
        build: true,
        guard: 'function',
        id: 'boards/[projectId]',
        protocolVersion: 6,
      },
      'projects/[projectId]/publication': {
        build: true,
        guard: 'function',
        id: 'projects/[projectId]/publication',
        protocolVersion: 6,
      },
    });
    expect(loaded.refused).toContain('is read in the authority alone');
  });

  it('writes envelopes the host runs: a request id of its own for each request, set after `next`', () => {
    writeOutputs(compiled.outputs, app.out);
    const envelope = path.join(app.out, 'middleware/app.envelope.ts');
    const ran = node(
      [
        `const envelope = await import(${JSON.stringify(envelope)});`,
        'const responses = [new Response("shared"), new Response("shared")];',
        'for (const response of responses) {',
        '  envelope.after(await envelope.before({ request: new Request("https://x/"), params: {} }), response);',
        '}',
        'process.stdout.write(JSON.stringify(responses.map((response) => [...response.headers])));',
      ].join('\n'),
      app.root,
    );
    const [first, second] = JSON.parse(ran.stdout) as [string, string][][];

    expect(ran.stderr).toBe('');
    expect(first?.find(([name]) => name === 'x-v4-middleware')).toStrictEqual([
      'x-v4-middleware',
      'root',
    ]);
    expect(first?.find(([name]) => name === 'x-v4-request')?.[1]).toMatch(/^[\da-f-]{36}$/u);
    expect(first?.find(([name]) => name === 'x-v4-request')).not.toStrictEqual(
      second?.find(([name]) => name === 'x-v4-request'),
    );
  });
});

describe('the compile of Project Todo v4’s mixed authorization (X)', () => {
  let api: API;
  let app: Application;
  let compiled: Compiled;

  beforeAll(async () => {
    api = openTypeScript();
    app = await application(await variantFiles('v4-mixed', X_FILES));
    compiled = compiledApp(app, api);
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await removed(app);
  });

  it('finds the projects middleware a guard of the session’s identity, around the settings', () => {
    const manifest = manifestOf(compiled, app);

    expect(compiled.refusals).toStrictEqual([]);
    expect(manifest.middleware).toStrictEqual([
      { envelope: true, guard: false, id: '', identity: false },
      { envelope: true, guard: true, id: 'projects', identity: true },
    ]);
    expect(
      reactiveOf(manifest).map(({ middleware, route, shared }) => ({ middleware, route, shared })),
    ).toStrictEqual([
      { middleware: [''], route: '/boards/[projectId]', shared: true },
      { middleware: ['', 'projects'], route: '/projects/[projectId]', shared: false },
      { middleware: ['', 'projects'], route: '/projects/[projectId]/publication', shared: false },
    ]);
    expect(manifest.routes.filter((route) => isPlainRoute(route))).toStrictEqual([
      { file: 'page.tsx', middleware: [''], params: [], plain: 'page', route: '/' },
    ]);
  });

  it('registers the v3 project page under the projects guard, and names its route in the project’s entry', () => {
    const project = manifestOf(compiled, app).routes.find(
      (each) => each.route === '/projects/[projectId]',
    );

    expect(project).toMatchObject({
      middleware: ['', 'projects'],
      private:
        "`components/project` is given props beside its route's params (`filter`, `selectedId`)",
      props: { projectId: 'projectId' },
      root: 'components/project',
      shared: false,
    });
    expect(output(compiled, app, 'components/project.root.tsx')).toContain(
      'route: "/projects/[projectId]", update, view });',
    );
  });

  it('writes the projects guard, which reads nothing of the context', () => {
    expect(output(compiled, app, 'middleware/app/projects.guard.mts')).toContain(
      ['export async function guard() {', '  await requireUser();', '}'].join('\n'),
    );
  });
});

describe('the compile of what a route middleware computes before `next`, and of what its guard answers', () => {
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

  async function compiledWith(
    middleware: string,
    beside: Readonly<Record<string, string>> = {},
  ): Promise<{ app: Application; compiled: Compiled }> {
    const app = await application({
      ...beside,
      'app/boards/[projectId]/middleware.ts': middleware,
    });
    apps.push(app);
    return { app, compiled: compiledApp(app, api) };
  }

  it('writes an envelope that reads what `before` answered under names the middleware leaves free, whatever the part after `next` declares', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async (_context, next) => {',
        '  const requestId = crypto.randomUUID();',
        '  const response = await next();',
        "  const before = response.headers.get('x-before') ?? '';",
        "  const locals = response.headers.get('x-locals') ?? '';",
        '  const Handed = before + locals;',
        "  response.headers.set('X-Request', requestId + Handed);",
        '  return response;',
        '}) satisfies RouteMiddleware;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const envelope = output(compiled, app, 'middleware/app/boards/[projectId].envelope.ts');

    expect(compiled.refusals).toStrictEqual([]);
    expect(envelope).toContain('type Handed$2 = Awaited<ReturnType<typeof before>>;');
    expect(envelope).toContain('  const { requestId } = locals$2 as Handed$2;');
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('runs what comes before `next` for each request ahead of the guards as the source does: before a guard of its own, and under one of a middleware around it only after `next`', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        "import { requirePublishedProject } from '@/publication';",
        '',
        'export default (async ({ params }, next) => {',
        '  const requestId = crypto.randomUUID();',
        '  await requirePublishedProject(params.projectId);',
        '  const response = await next();',
        "  response.headers.set('X-Request', requestId);",
        '  return response;',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
      {
        'app/boards/[projectId]/stats/middleware.ts': file(
          "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
          '',
          'export default (async (_context, next) => {',
          '  const response = await next();',
          "  response.headers.append('X-Stats', '1');",
          '  return response;',
          '}) satisfies RouteMiddleware;',
        ),
      },
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(output(compiled, app, 'middleware/app/boards/[projectId].envelope.ts')).toContain(
      'const requestId = crypto.randomUUID();',
    );
  });

  const LANGUAGES = file(
    "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
    "import { requirePublishedProject } from '@/publication';",
    '',
    'export default (async ({ params, request }, next) => {',
    '  const id = params.projectId;',
    "  const language = request.headers.get('accept-language') ?? 'en';",
    '  // The publication, of the params alone.',
    '  await requirePublishedProject(id);',
    '  const response = await next();',
    "  if (language !== 'en') {",
    "    response.headers.set('Content-Language', language);",
    '  }',
    "  response.headers.set('X-Board', id);",
    '  return response;',
    '}) satisfies RouteMiddleware<{ projectId: string }>;',
  );

  it('writes a constant of the params alone into each part that reads it, and the request into the envelope alone', async () => {
    const { app, compiled } = await compiledWith(LANGUAGES);
    const read = (name: string): string =>
      output(compiled, app, name).replaceAll(compiled.buildId, 'b_BUILD');

    expect(compiled.refusals).toStrictEqual([]);
    expect(read('middleware/app/boards/[projectId].guard.mts')).toContain(
      [
        "export async function guard({ params }: Pick<Parameters<RouteMiddleware<{ projectId: string }>>[0], 'params'>) {",
        '  const id = params.projectId;',
        '  // The publication, of the params alone.',
        '  await requirePublishedProject(id);',
        '}',
      ].join('\n'),
    );
    expect(read('middleware/app/boards/[projectId].envelope.ts')).toBe(
      file(
        '// Generated by @arkorlab/reactive-state from app/boards/[projectId]/middleware.ts. Do not edit: change the middleware and compile it again.',
        "import type { RouteParams } from '@arkorlab/reactive-state/routing';",
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export const id = "boards/[projectId]";',
        '',
        'export function before(context: { readonly request: Request; readonly params: RouteParams }) {',
        '  const { params, request } = context as Parameters<RouteMiddleware<{ projectId: string }>>[0];',
        '  const id = params.projectId;',
        "  const language = request.headers.get('accept-language') ?? 'en';",
        '  return { id, language };',
        '}',
        '',
        'type Handed = Awaited<ReturnType<typeof before>>;',
        '',
        'export function after(locals: Readonly<Record<string, unknown>>, response: Response): void {',
        '  const { id, language } = locals as Handed;',
        "  if (language !== 'en') {",
        "    response.headers.set('Content-Language', language);",
        '  }',
        "  response.headers.set('X-Board', id);",
        '}',
      ),
    );
  });

  it('writes a constant of literals and the params alone into both parts that read it, however it is written', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        "import { requirePublishedProject } from '@/publication';",
        '',
        'export default (async (context, next) => {',
        '  const { projectId } = context.params;',
        `  const tag = \`board:\${projectId}\`;`,
        "  const labels = { [tag]: projectId.length > 0 ? 'some' : 'none', kind: 'board' };",
        '  await requirePublishedProject(labels[tag] === undefined ? tag : projectId);',
        '  const response = await next();',
        "  response.headers.set('X-Board', labels.kind);",
        '  return response;',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    const guard = output(compiled, app, 'middleware/app/boards/[projectId].guard.mts');
    const envelope = output(compiled, app, 'middleware/app/boards/[projectId].envelope.ts');

    expect(compiled.refusals).toStrictEqual([]);

    for (const part of [guard, envelope]) {
      expect(part).toContain(`const tag = \`board:\${projectId}\`;`);
      expect(part).toContain(
        "const labels = { [tag]: projectId.length > 0 ? 'some' : 'none', kind: 'board' };",
      );
    }
  });

  it('reads the declarations of a constant in their order, each of the names those before it bind', async () => {
    const declared =
      "const key = params.projectId, tag = key + '-board', [first, second = first] = [tag];";
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        "import { requirePublishedProject } from '@/publication';",
        '',
        'export default (async ({ params }, next) => {',
        `  ${declared}`,
        '  await requirePublishedProject(second);',
        '  const response = await next();',
        "  response.headers.set('X-Board', second);",
        '  return response;',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );

    expect(compiled.refusals).toStrictEqual([]);

    const guard = output(compiled, app, 'middleware/app/boards/[projectId].guard.mts');
    const envelope = output(compiled, app, 'middleware/app/boards/[projectId].envelope.ts');

    expect(guard).toContain(declared);
    expect(envelope).toContain(declared);
  });

  it('writes what the application’s type check accepts of the parts it split', async () => {
    const { app, compiled } = await compiledWith(LANGUAGES);
    writeOutputs(compiled.outputs, app.out);

    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('answers a guard’s own response as a descriptor the host makes the response of', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        "import { db } from '@/db';",
        '',
        'export default (async ({ params }, next) => {',
        '  const project = await db.projects.get(params.projectId);',
        '  if (project === null) {',
        "    return new Response('No such board', { status: 404, headers: { 'content-type': 'text/plain', Vary: 'Cookie' } });",
        '  }',
        '  if (!project.published) return new Response(null, { status: 403 });',
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    const guard = output(compiled, app, 'middleware/app/boards/[projectId].guard.mts');

    expect(compiled.refusals).toStrictEqual([]);
    expect(guard).toContain(
      "import type { ResponseDescriptor } from '@arkorlab/reactive-state/routing';",
    );
    expect(guard).toContain(
      "export async function guard({ params }: Pick<Parameters<RouteMiddleware<{ projectId: string }>>[0], 'params'>): Promise<ResponseDescriptor | void> {",
    );
    expect(guard).toContain(
      `    return { body: 'No such board', status: 404, headers: [["content-type", 'text/plain'], ["Vary", 'Cookie']] };`,
    );
    expect(guard).toContain(
      "  if (!project.published) return { body: '', status: 403, headers: [] };",
    );
    expect(manifestOf(compiled, app).middleware).toStrictEqual([
      { envelope: false, guard: true, id: 'boards/[projectId]', identity: false },
    ]);
    // The route records that a guard of it may answer in its place.
    expect(
      manifestOf(compiled, app).routes.find(({ route }) => route === '/boards/[projectId]'),
    ).toMatchObject({
      answers: true,
    });

    writeOutputs(compiled.outputs, app.out);

    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('writes a guard that throws as `new Response` does where a response of text has a computed status of no body, and answers any other', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        "  const code = params.projectId === 'gone' ? 204 : 403;",
        "  if (params.projectId !== 'p1') return new Response('', { status: code });",
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const answered = inAuthority(
      app,
      "await Promise.all(['gone', 'other'].map(async (projectId) => { try { return await registry.middleware['boards/[projectId]'].guard({ params: { projectId } }); } catch (error) { return String(error); } }))",
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual([
      'TypeError: A response of a status that has no body is given text.',
      { body: '', headers: [['content-type', 'text/plain;charset=UTF-8']], status: 403 },
    ]);
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('writes a guard’s response with the status `new Response` makes — WebIDL’s `unsigned short`, then 200 to 599 — throwing as it throws', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        "  const [kind = '', code = ''] = params.projectId.split(' ');",
        "  const status = code === 'big' ? BigInt(403) : JSON.parse(code || '200');",
        "  if (kind === 'none') return new Response(null, { status });",
        "  if (kind === 'text') return new Response('No', { status });",
        "  if (kind === 'computed') return new Response(String(kind), { status });",
        "  if (kind === 'written') return new Response('Gone', { status: 410.5 });",
        "  if (kind === 'past') return new Response(null, { status: 700 });",
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const asked = [
      ...['403.5', '403.9', '599.9', '65939', '-65133', '"403"'].map((code) => `none ${code}`),
      ...['199.9', '-1', '1e21', 'null', 'big'].map((code) => `none ${code}`),
      ...['403.5', '204.5', '700'].flatMap((code) => [`text ${code}`, `computed ${code}`]),
      'written',
      'past',
    ];
    const answered = inAuthority(
      app,
      `await Promise.all(${JSON.stringify(asked)}.map(async (projectId) => { try { return (await registry.middleware['boards/[projectId]'].guard({ params: { projectId } })).status; } catch (error) { return error.name; } }))`,
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual([
      // A fraction cut off, and a number taken modulo 2¹⁶: 65939 and -65133 are 403.
      403,
      403,
      599,
      403,
      403,
      403,
      // 199, 65535 and 0, past what a response may be; and a `BigInt`, no number.
      'RangeError',
      'RangeError',
      'RangeError',
      'RangeError',
      'TypeError',
      // Of text: the status made, then checked for a body — 204 has none — once it may be one.
      403,
      403,
      'TypeError',
      'TypeError',
      'RangeError',
      'RangeError',
      410,
      'RangeError',
    ]);
    expect(output(compiled, app, 'middleware/app/boards/[projectId].guard.mts')).toContain(
      "return { body: 'Gone', status: 410, headers: ",
    );
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('writes a guard’s response of a body that is a condition branch by branch: text where it is text, none where it is none', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        "  const gone = params.projectId === 'gone';",
        "  const moved = params.projectId === 'moved';",
        `  if (params.projectId !== 'p1') return new Response(gone ? 'Gone' : (moved ? null : \`No \${params.projectId}\`), { status: gone ? 410 : 404, headers: { Vary: 'Cookie' } });`,
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const answered = inAuthority(
      app,
      "await Promise.all(['gone', 'moved', 'p2'].map((projectId) => registry.middleware['boards/[projectId]'].guard({ params: { projectId } })))",
    );
    const text = ['content-type', 'text/plain;charset=UTF-8'];

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual([
      { body: 'Gone', headers: [['Vary', 'Cookie'], text], status: 410 },
      { body: '', headers: [['Vary', 'Cookie']], status: 404 },
      { body: 'No p2', headers: [['Vary', 'Cookie'], text], status: 404 },
    ]);
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('writes a guard’s response of a body it computes as what the body holds as the guard runs: text as text, none as none, and anything else thrown for', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        `  const body = params.projectId === 'bytes' ? new Uint8Array([110, 111]) : params.projectId === 'none' ? null : \`No \${params.projectId}\`;`,
        "  if (params.projectId === 'empty') return new Response(body === null ? body : null, { status: 204 });",
        "  if (params.projectId === 'filled') return new Response(body, { status: 204 });",
        "  if (params.projectId !== 'p1') return new Response(body, { status: 403, headers: { Vary: 'Cookie' } });",
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const answered = inAuthority(
      app,
      "await Promise.all(['bytes', 'none', 'p2', 'empty', 'filled'].map(async (projectId) => { try { return await registry.middleware['boards/[projectId]'].guard({ params: { projectId } }); } catch (error) { return String(error); } }))",
    );
    const text = ['content-type', 'text/plain;charset=UTF-8'];

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual([
      "TypeError: A guard's response is given a body that is neither text nor none.",
      { body: '', headers: [['Vary', 'Cookie']], status: 403 },
      { body: 'No p2', headers: [['Vary', 'Cookie'], text], status: 403 },
      { body: '', headers: [], status: 204 },
      'TypeError: A response of a status that has no body is given text.',
    ]);
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('writes a guard’s response as `new Response(body, init)` evaluates it: the body, then the init as it is written', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        '  let step = 0;',
        `  if (params.projectId === 'text') return new Response(\`step \${(step += 1)}\`, { headers: { 'x-step': String((step += 1)) }, status: 400 + (step += 1) });`,
        "  if (params.projectId === 'computed') return new Response(String((step += 1)), { headers: { 'x-step': String((step += 1)) }, status: 400 + (step += 1) });",
        "  if (params.projectId === 'none') return new Response(null, { status: 400 + (step += 1), headers: { 'x-step': String((step += 1)) } });",
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const answered = inAuthority(
      app,
      "await Promise.all(['text', 'computed', 'none'].map((projectId) => registry.middleware['boards/[projectId]'].guard({ params: { projectId } })))",
    );
    const text = ['content-type', 'text/plain;charset=UTF-8'];

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual([
      { body: 'step 1', headers: [['x-step', '2'], text], status: 403 },
      { body: '1', headers: [['x-step', '2'], text], status: 403 },
      { body: '', headers: [['x-step', '2']], status: 401 },
    ]);
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('makes a guard’s response headers as `new Response` converts its init: once every initializer of it is evaluated, a status written after them too, and before that status is made a number', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        "  const [kind = '', made = ''] = params.projectId.split(' ');",
        '  let step = 0;',
        '  const stepped = (given: number): number => {',
        '    step += 1;',
        '    return given;',
        '  };',
        '  const value: unknown = {',
        '    toString: () => {',
        `      if (made === 'thrown') throw new Error(\`thrown at step \${String(step)}\`);`,
        `      return \`step \${String(step)}\`;`,
        '    },',
        '  };',
        "  const code = (made === 'thrown' ? BigInt(403) : 403) as unknown as number;",
        "  const body: unknown = kind === 'computed' ? 'Computed' : null;",
        "  if (kind === 'none') return new Response(null, { headers: { 'x-step': value }, status: stepped(code) });",
        "  if (kind === 'text') return new Response('Text', { headers: [['x-step', value]], status: stepped(code) });",
        "  if (kind === 'computed') return new Response(body, { headers: { 'x-step': value }, status: stepped(code) });",
        "  if (kind === 'condition') return new Response(step === 0 ? 'Text' : null, { headers: { 'x-step': value }, status: stepped(code) });",
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const kinds = ['none', 'text', 'computed', 'condition'];
    const asked = [...kinds, ...kinds.map((kind) => `${kind} thrown`)];
    const answered = inAuthority(
      app,
      `await Promise.all(${JSON.stringify(asked)}.map(async (projectId) => { try { const { headers, ...answer } = await registry.middleware['boards/[projectId]'].guard({ params: { projectId } }); return { ...answer, headers: Object.fromEntries(headers) }; } catch (error) { return (${THROWN_AS})(error); } }))`,
    );
    const text = { 'content-type': 'text/plain;charset=UTF-8', 'x-step': 'step 1' };

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual([
      // A header made text once the status written after it is evaluated: of the step it leaves.
      { body: '', headers: { 'x-step': 'step 1' }, status: 403 },
      { body: 'Text', headers: text, status: 403 },
      { body: 'Computed', headers: text, status: 403 },
      { body: 'Text', headers: text, status: 403 },
      // Thrown for there, before that status — a `BigInt`, which no number is made of — is made one.
      ...kinds.map(() => 'Error: thrown at step 1'),
    ]);
    // What the middleware answers as the source holds it, `new Response` the platform's: the same.
    expect(answered).toStrictEqual(await natively(app, asked));
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('makes a guard’s response headers as `new Response` makes them: their names and values text before its status is made a number, and headers of them once that status is in range', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        "  const [kind = '', made = ''] = params.projectId.split(' ');",
        '  const seconds: Readonly<Record<string, unknown>> = {',
        String.raw`    byte: '\u0100',`,
        "    second: { toString: () => { throw new Error('second pair made text'); } },",
        "    symbol: Symbol('second'),",
        '  };',
        "  const second = seconds[made] ?? 'second';",
        '  const statuses: Readonly<Record<string, unknown>> = { ranged: 700, second: 503 };',
        "  const code = (statuses[made] ?? { valueOf: () => { throw new Error('status made a number'); } }) as number;",
        "  const body: unknown = kind === 'computed' ? 'Computed' : null;",
        "  if (kind === 'none') return new Response(null, { headers: [['Bad Name', 'first'], ['x-second', second]], status: code });",
        "  if (kind === 'text') return new Response('Text', { headers: [['Bad Name', 'first'], ['x-second', second]], status: code });",
        "  if (kind === 'computed') return new Response(body, { headers: [['Bad Name', 'first'], ['x-second', second]], status: code });",
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const kinds = ['none', 'text', 'computed'];
    const asked = ['valued', 'second', 'ranged', 'byte', 'symbol'].flatMap((made) =>
      kinds.map((kind) => `${kind} ${made}`),
    );
    const answered = inAuthority(
      app,
      `await Promise.all(${JSON.stringify(asked)}.map(async (projectId) => { try { return await registry.middleware['boards/[projectId]'].guard({ params: { projectId } }); } catch (error) { return (${THROWN_AS})(error); } }))`,
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual([
      // The status made a number before a header whose name is no token is thrown for,
      ...kinds.map(() => 'Error: status made a number'),
      // a second pair made text before a first that is no header is,
      ...kinds.map(() => 'Error: second pair made text'),
      // and a status past 599 thrown for before it is.
      ...kinds.map(() => 'RangeError'),
      // A character past a byte, and a symbol, thrown for as the pairs are made text: before all.
      ...kinds.map(() => 'TypeError'),
      ...kinds.map(() => 'TypeError'),
    ]);
    // What the middleware answers as the source holds it, `new Response` the platform's: the same.
    expect(answered).toStrictEqual(await natively(app, asked));
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('binds a default of the context’s pattern into both parts where it is computed alike, and into the one that reads it of any other', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        "import { db } from '@/db';",
        '',
        "export default (async ({ params: { projectId, tenant = projectId + '-default', nonce = crypto.randomUUID() } }, next) => {",
        '  await db.projects.get(projectId + tenant);',
        '  const response = await next();',
        "  response.headers.set('X-Tenant', tenant + nonce);",
        '  return response;',
        '}) satisfies RouteMiddleware<{ projectId: string; tenant?: string; nonce?: string }>;',
      ),
    );
    const guard = output(compiled, app, 'middleware/app/boards/[projectId].guard.mts');

    expect(compiled.refusals).toStrictEqual([]);
    expect(guard).toContain("{ params: { projectId, tenant = projectId + '-default' } }");
    expect(guard).not.toContain('randomUUID');
  });

  it('writes the context’s pattern into a part as the middleware wrote it — an object’s default kept — binding and importing what each default it keeps reads', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        "import { db } from '@/db';",
        "import { FALLBACK, SUFFIX } from '@/defaults';",
        '',
        'export default (async ({ params: { projectId, tenant = projectId + SUFFIX } = FALLBACK }, next) => {',
        '  await db.projects.get(tenant);',
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string; tenant?: string }>;',
      ),
      {
        'defaults.ts': file(
          "export const FALLBACK = { projectId: 'none' };",
          "export const SUFFIX = '-tenant';",
        ),
      },
    );
    const guard = output(compiled, app, 'middleware/app/boards/[projectId].guard.mts');
    writeOutputs(compiled.outputs, app.out);

    expect(compiled.refusals).toStrictEqual([]);
    expect(guard).toContain('{ params: { projectId, tenant = projectId + SUFFIX } = FALLBACK }');
    expect(guard).toContain("import { FALLBACK, SUFFIX } from '@/defaults';");
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('writes a string a backslash continues as the middleware wrote it, whatever the indent of its lines', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        "    if (params.projectId === 'busy') return new Response('one \\",
        "    two', { status: 503 });",
        '    return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const answered = inAuthority(
      app,
      "await registry.middleware['boards/[projectId]'].guard({ params: { projectId: 'busy' } })",
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual({
      body: 'one     two',
      headers: [['content-type', 'text/plain;charset=UTF-8']],
      status: 503,
    });
  });

  it('makes a guard’s response headers as `Headers` makes them — a number made text, the whitespace around a value trimmed, a name in lower case — once every one is evaluated, and throws where `Headers` throws', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        '  const wait: unknown = 5;',
        "  if (params.projectId === 'busy') return new Response(null, { status: 503, headers: { 'Retry-After': wait, Vary: ' Cookie ' } });",
        "  if (params.projectId === 'listed') return new Response('Busy', { status: 503, headers: [['Retry-After', wait]] });",
        String.raw`  if (params.projectId === 'broken') return new Response(null, { status: 503, headers: { 'X-Line': 'a\nb' } });`,
        "  if (params.projectId === 'named') return new Response(null, { status: 503, headers: [['Bad Name', 'x']] });",
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const answered = inAuthority(
      app,
      "await Promise.all(['busy', 'listed', 'broken', 'named'].map(async (projectId) => { try { return await registry.middleware['boards/[projectId]'].guard({ params: { projectId } }); } catch (error) { return error instanceof TypeError ? 'TypeError' : String(error); } }))",
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual([
      {
        body: '',
        headers: [
          ['retry-after', '5'],
          ['vary', 'Cookie'],
        ],
        status: 503,
      },
      {
        body: 'Busy',
        headers: [
          ['retry-after', '5'],
          ['content-type', 'text/plain;charset=UTF-8'],
        ],
        status: 503,
      },
      'TypeError',
      'TypeError',
    ]);
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('makes a guard’s response of a status that is `undefined` a 200, whatever its body, as `new Response` takes that member of its init as absent', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        "  const [given = '', kind = ''] = params.projectId.split(' ');",
        "  const status = given === 'unset' ? undefined : 403;",
        "  const body: unknown = kind === 'computed' ? 'Computed' : null;",
        "  if (kind === 'computed') return new Response(body, { status });",
        "  if (params.projectId !== 'open') return new Response(null, { status });",
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const answered = inAuthority(
      app,
      "await Promise.all(['unset', 'set', 'unset computed', 'set computed'].map(async (projectId) => (await registry.middleware['boards/[projectId]'].guard({ params: { projectId } })).status))",
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual([200, 403, 200, 403]);
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('makes a guard’s response of a body of its own named `undefined` as `new Response` makes it: the text it holds, not none', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        "  const undefined = 'Denied';",
        "  if (params.projectId === 'closed') return new Response(undefined, { status: 403 });",
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const answered = inAuthority(
      app,
      "await registry.middleware['boards/[projectId]'].guard({ params: { projectId: 'closed' } })",
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual({
      body: 'Denied',
      headers: [['content-type', 'text/plain;charset=UTF-8']],
      status: 403,
    });
  });

  it('makes a guard’s response by the platform’s own globals where the middleware declares names of theirs, bound where none of its own is in scope', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        "  const Headers = 'h';",
        "  const TypeError = 't';",
        "  const RangeError = 'r';",
        "  const Number = 'n';",
        "  const Math = 'm';",
        "  const String = 's';",
        '  const wait: unknown = 5;',
        '  const statuses: Readonly<Record<string, number>> = { bodiless: 204, busy: 503, range: 99 };',
        '  const status = statuses[params.projectId] ?? 503;',
        "  const body: unknown = params.projectId === 'object' ? {} : 'Busy';",
        "  if (params.projectId === 'names') return new Response([Headers, TypeError, RangeError, Number, Math, String].join(''));",
        "  if (params.projectId !== 'pass') return new Response(body, { status, headers: [['Retry-After', wait]] });",
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const answered = inAuthority(
      app,
      "await Promise.all(['names', 'busy', 'bodiless', 'range', 'object'].map(async (projectId) => { try { return await registry.middleware['boards/[projectId]'].guard({ params: { projectId } }); } catch (error) { return error instanceof globalThis.Error ? error.name + ': ' + error.message : 'none'; } }))",
    );
    const guard = output(compiled, app, 'middleware/app/boards/[projectId].guard.mts');

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual([
      { body: 'htrnms', headers: [['content-type', 'text/plain;charset=UTF-8']], status: 200 },
      {
        body: 'Busy',
        headers: [
          ['retry-after', '5'],
          ['content-type', 'text/plain;charset=UTF-8'],
        ],
        status: 503,
      },
      'TypeError: A response of a status that has no body is given text.',
      "RangeError: A guard's response is given a status that is not between 200 and 599, inclusive: 99",
      "TypeError: A guard's response is given a body that is neither text nor none.",
    ]);
    expect(guard).toContain('const Headers$2 = globalThis.Headers;');
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('refuses a guard that reads an import named `globalThis` where its program binds a global the middleware has a name of its own for', async () => {
    const { compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        "import { db as globalThis } from '@/db';",
        '',
        'export default (async ({ params }, next) => {',
        "  const Headers = 'h';",
        '  const wait: unknown = await globalThis.projects.get(params.projectId);',
        "  if (Headers === 'h') return new Response(null, { status: 503, headers: [['Retry-After', wait]] });",
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );

    expect(compiled.refusals.map((refusal) => refusal.message)).toStrictEqual([
      expect.stringMatching(
        /^app\/boards\/\[projectId\]\/middleware\.ts:2:\d+: The guard reads an import of its own named `globalThis`/u,
      ),
    ]);
  });

  it('makes text of a guard’s response header’s name once, as `new Response` does, where its text is new each time it is asked for', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default (async ({ params }, next) => {',
        '  let asked = 0;',
        "  const name: unknown = { toString: () => ((asked += 1) === 1 ? 'X-First' : 'X-Later') };",
        "  if (params.projectId === 'named') return new Response(null, { status: 503, headers: [[name, 'v']] });",
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    writeOutputs(compiled.outputs, app.out);
    const answered = inAuthority(
      app,
      "await registry.middleware['boards/[projectId]'].guard({ params: { projectId: 'named' } })",
    );
    // What `new Response` makes of the same init: a name just as new each time it is asked for.
    let asked = 0;
    const name = { toString: () => ((asked += 1) === 1 ? 'X-First' : 'X-Later') };
    const native = new Response(null, { headers: [[name as unknown as string, 'v']], status: 503 });

    expect(compiled.refusals).toStrictEqual([]);
    expect(answered).toStrictEqual({ body: '', headers: [...native.headers], status: 503 });
    expect(answered).toStrictEqual({ body: '', headers: [['x-first', 'v']], status: 503 });
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('gives a guard’s response of text the content type `new Response` gives it where the guard names none, and a response of no body none', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        "import { db } from '@/db';",
        '',
        'export default (async ({ params }, next) => {',
        '  const project = await db.projects.get(params.projectId);',
        "  if (project === null) return new Response('Unauthorized', { status: 401 });",
        "  if (project.title === '') return new Response('', { headers: [['Vary', 'Cookie']] });",
        "  if (!project.published) return new Response('{}', { headers: { 'Content-Type': 'application/json' } });",
        '  if (project.title.length > 1) return new Response(undefined, { status: 204 });',
        '  return next();',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );
    const guard = output(compiled, app, 'middleware/app/boards/[projectId].guard.mts');

    expect(compiled.refusals).toStrictEqual([]);
    expect(guard).toContain(
      `return { body: 'Unauthorized', status: 401, headers: [["content-type", "text/plain;charset=UTF-8"]] };`,
    );
    // An empty text is text all the same: `new Response('')` gives it the content type too.
    expect(guard).toContain(
      `return { body: '', headers: [['Vary', 'Cookie'], ["content-type", "text/plain;charset=UTF-8"]], status: 200 };`,
    );
    expect(guard).toContain(
      `return { body: '{}', headers: [["Content-Type", 'application/json']], status: 200 };`,
    );
    expect(guard).toContain("return { body: '', status: 204, headers: [] };");

    writeOutputs(compiled.outputs, app.out);

    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('writes a middleware that answers `next()` alone as neither a guard nor an envelope', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        '',
        'export default async function passing(_context: Parameters<RouteMiddleware>[0], next: () => Promise<Response>) {',
        '  return await next();',
        '}',
      ),
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(manifestOf(compiled, app).middleware).toStrictEqual([
      { envelope: false, guard: false, id: 'boards/[projectId]', identity: false },
    ]);
    expect(
      [...compiled.outputs.keys()].filter((each) => each.includes('/middleware/')),
    ).toStrictEqual([]);
  });

  it('takes no name a type gives for a declaration of the middleware’s names — a parameter of a function’s type, of an interface’s signatures, of an overload or an abstract method, a class’s index — as each is erased with the types', async () => {
    const declared = [
      'type Check = (params: string) => Promise<unknown>;',
      'interface Gate {',
      '  open(check: string): Promise<unknown>;',
      '}',
      'interface Opener {',
      '  (requirePublishedProject: Check): Gate;',
      '}',
      'const check: (request: string) => Promise<unknown> = requirePublishedProject;',
      'const opener: Opener = (checking) => ({ open: (projectId) => checking(projectId) });',
      'function opened(next: string): Promise<unknown>;',
      'function opened(projectId: string): Promise<unknown> {',
      '  return opener(check).open(projectId);',
      '}',
      'abstract class Guard {',
      '  [params: string]: unknown;',
      '  abstract admit(next: string): Promise<unknown>;',
      '}',
      'class BoardGuard extends Guard {',
      '  override admit(projectId: string): Promise<unknown> {',
      '    return opened(projectId);',
      '  }',
      '}',
    ].map((line) => `  ${line}`);
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        "import { requirePublishedProject } from '@/publication';",
        '',
        'export default (async ({ params, request }, next) => {',
        ...declared,
        '  await new BoardGuard().admit(params.projectId);',
        '  const response = await next();',
        "  response.headers.set('X-Guarded', request.method);",
        '  return response;',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );

    expect(compiled.refusals).toStrictEqual([]);

    writeOutputs(compiled.outputs, app.out);

    expect(output(compiled, app, 'middleware/app/boards/[projectId].guard.mts')).toContain(
      declared.join('\n'),
    );
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('writes a constant of the clock before `next` into the envelope, as the request’s, though a callback of the middleware names a parameter `Date`', async () => {
    const { app, compiled } = await compiledWith(
      file(
        "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
        "import { requirePublishedProject } from '@/publication';",
        '',
        'export default (async ({ params }, next) => {',
        '  const startedAt = Date.now();',
        '  const ids = [params.projectId].map((Date) => Date);',
        '  await requirePublishedProject(ids.join());',
        '  const response = await next();',
        "  response.headers.set('X-Started', String(startedAt));",
        '  return response;',
        '}) satisfies RouteMiddleware<{ projectId: string }>;',
      ),
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(output(compiled, app, 'middleware/app/boards/[projectId].envelope.ts')).toContain(
      '  const startedAt = Date.now();',
    );
    expect(output(compiled, app, 'middleware/app/boards/[projectId].guard.mts')).not.toContain(
      'Date.now()',
    );
  });
});

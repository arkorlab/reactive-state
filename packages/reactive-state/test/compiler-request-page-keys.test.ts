import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { Call } from '../src/authority/evaluation.ts';
import type { Core } from '../src/authority/model.ts';
import type { Renderer } from '../src/authority/render.ts';
import { paramsOfProps, viewParamsOf } from '../src/authority/route-registry.ts';
import { guardedBy } from '../src/authority/views.ts';
import { type Compiled, openTypeScript } from '../src/compiler/index.ts';
import { pageRenderOf } from '../src/compiler/page-render.ts';
import { parseModule } from '../src/compiler/typescript.ts';
import { type Json, PROTOCOL_VERSION } from '../src/program.ts';
import type { MiddlewareProgram, RouteParams, RouteRegistration } from '../src/routing.ts';
import { application, type Application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** React's reserved key is validated page syntax without becoming a registered root prop. */
const CASES = [
  {
    id: 'wrapped-key-before',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><PublicBoard key={projectId} projectId={projectId}/></main>;}',
    blocking: true,
  },
  {
    id: 'wrapped-key-after',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><PublicBoard projectId={projectId} key={projectId}/></main>;}',
    blocking: true,
  },
  {
    id: 'nested-wrapper',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><section><PublicBoard key={projectId} projectId={projectId}/></section></main>;}',
    blocking: true,
  },
  {
    id: 'fragment-wrapper',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <><PublicBoard key={projectId} projectId={projectId}/></>;}',
    blocking: true,
  },
  {
    id: 'explicit-closing',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><PublicBoard key={projectId} projectId={projectId}></PublicBoard></main>;}',
    blocking: true,
  },
  {
    id: 'renamed-param',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId:id}=await params;return <main><PublicBoard key={id} projectId={id}/></main>;}',
    blocking: true,
  },
  {
    id: 'literal-key-spread',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><PublicBoard {...{key:projectId}} projectId={projectId}/></main>;}',
    blocking: true,
  },
  {
    id: 'conditional-key-spread',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><PublicBoard {...(true?{key:projectId}:{})} projectId={projectId}/></main>;}',
    blocking: true,
  },
  {
    id: 'search-only-key',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params,searchParams}:{params:Promise<{projectId:string}>;searchParams:Promise<{preview?:string}>}){const {projectId}=await params;const query=await searchParams;return <main><PublicBoard key={query.preview} projectId={projectId}/></main>;}',
    blocking: true,
  },
  {
    id: 'literal-key',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><PublicBoard key="fixed" projectId={projectId}/></main>;}',
    blocking: true,
  },
  {
    id: 'unkeyed-wrapper-pin',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <main><PublicBoard projectId={projectId}/></main>;}',
    blocking: true,
  },
  {
    id: 'search-unkeyed-pin',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params,searchParams}:{params:Promise<{projectId:string}>;searchParams:Promise<{preview?:string}>}){const {projectId}=await params;const query=await searchParams;return <main><PublicBoard projectId={projectId}/></main>;}',
    blocking: true,
  },
  {
    id: 'unkeyed-direct-pin',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <PublicBoard projectId={projectId}/>;}',
    blocking: true,
  },
] as const;
const PAGE = 'app/boards/[projectId]/page.tsx';
const ROUTE = '/boards/[projectId]';
const TIMES = { guard: 1000 } as const;
const MIDDLEWARE = `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
export default (async ({params},next)=>{
  if(params.projectId!=='p1')return new Response('Denied',{status:403});
  return next();
}) satisfies RouteMiddleware<{projectId:string}>;`;

/** The generated literal route registry retains the compiler's exact serialized props. */
function registryRoutes(text: string): readonly RouteRegistration[] {
  const start = text.indexOf('export const routes:');
  const value = text.indexOf(' = ', start) + ' = '.length;
  return JSON.parse(text.slice(value, text.indexOf(';', value))) as RouteRegistration[];
}

/** The actual props React gives a keyed root exclude its key. */
function runtimeProps(projectId: string): Readonly<Record<string, Json>> {
  return createElement(
    (props: { projectId: string }) => createElement('p', null, props.projectId),
    { key: projectId, projectId },
  ).props;
}

/** The compiled route reaches the real guard runner with an authorized or denied parameter. */
async function guardedRoute(route: RouteRegistration, buildId: string, projectId: string) {
  const seen: RouteParams[] = [];
  const middleware: MiddlewareProgram = {
    buildId,
    id: route.middleware[0] ?? '',
    protocolVersion: PROTOCOL_VERSION,
    guard: ({ params }) => {
      seen.push(params);
      return Promise.resolve(
        params['projectId'] === 'p1' ? undefined : { body: 'Denied', headers: [], status: 403 },
      );
    },
  };
  const core = {
    metrics: { guardEvaluations: 0, middlewareReads: 0 },
    routes: {
      routes: new Map([[route.route, route]]),
      middleware: new Map([[middleware.id, middleware]]),
    },
  } as unknown as Core;
  const call = new Call('compiled keyed route', TIMES.guard);
  const renderer = { scope: { call } } as Renderer;
  try {
    const result = await guardedBy(core, renderer, {
      component: route.root,
      props: runtimeProps(projectId),
    });
    return { refused: result.refused, seen, guardEvaluations: core.metrics.guardEvaluations };
  } finally {
    call.close();
  }
}

/** A route selected from the actual manifest and generated host and authority registries. */
function registered(compiled: Compiled, app: Application) {
  const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
    routes: RouteRegistration[];
  };
  const route = manifest.routes.find((each) => each.route === ROUTE);
  if (route === undefined) throw new Error('The board route was not registered.');
  const host = registryRoutes(output(compiled, app, 'routes.ts')).find(
    (each) => each.route === ROUTE,
  );
  const authority = registryRoutes(output(compiled, app, 'authority.mts')).find(
    (each) => each.route === ROUTE,
  );
  return { route, host, authority };
}

describe('request page key readers', () => {
  it.each(CASES)('$id', ({ source, blocking }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'page.tsx', source);
    const found = pageRenderOf(
      parsed.sourceFile,
      (specifier) => specifier === '@/components/public-board.reactive',
    );

    expect({ props: found?.props, given: found?.given, blocking: found?.blocking }).toStrictEqual({
      props: { projectId: 'projectId' },
      given: [],
      blocking,
    });
  });
});

describe('compiled request page keyed roots', () => {
  const { apps, compile } = compilerApplications();
  async function compilePage(source: string) {
    const app = await application({
      [PAGE]: source,
      'app/boards/[projectId]/middleware.ts': MIDDLEWARE,
    });
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);

    return { app, compiled, ...registered(compiled, app) };
  }

  it.each(CASES)('$id', async ({ source, blocking }) => {
    const { route, host, authority, compiled } = await compilePage(source);
    const props = runtimeProps('p1');
    const guard = await guardedRoute(route, compiled.buildId, 'p1');

    expect({
      props: route.props,
      host: host?.props,
      authority: authority?.props,
      blocking: route.blocking,
      guarded: route.guarded,
      params: paramsOfProps(route, props),
      view: viewParamsOf(route, props),
      guard,
    }).toStrictEqual({
      props: { projectId: 'projectId' },
      host: { projectId: 'projectId' },
      authority: { projectId: 'projectId' },
      blocking,
      guarded: true,
      params: { projectId: 'p1' },
      view: { projectId: 'p1' },
      guard: { refused: false, seen: [{ projectId: 'p1' }], guardEvaluations: 1 },
    });
  });

  it.each([
    ['p1', false],
    ['p2', true],
  ] as const)('runs rather than skips the guard for %s', async (projectId, refused) => {
    const first = CASES[0];
    const { route, compiled } = await compilePage(first.source);

    await expect(guardedRoute(route, compiled.buildId, projectId)).resolves.toStrictEqual({
      refused,
      seen: [{ projectId }],
      guardEvaluations: 1,
    });
  });

  it('uses React props without a synthetic key field', () => {
    expect(runtimeProps('p1')).toStrictEqual({ projectId: 'p1' });
  });
});

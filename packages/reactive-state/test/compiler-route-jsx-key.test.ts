import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { Call } from '../src/authority/evaluation.ts';
import type { Core } from '../src/authority/model.ts';
import type { Renderer } from '../src/authority/render.ts';
import { paramsOfProps, viewParamsOf } from '../src/authority/route-registry.ts';
import { guardedBy } from '../src/authority/views.ts';
import { type Compiled, openTypeScript } from '../src/compiler/index.ts';
import { pageShapeOf } from '../src/compiler/page-shape.ts';
import { parseModule } from '../src/compiler/typescript.ts';
import { type Json, PROTOCOL_VERSION } from '../src/program.ts';
import type { MiddlewareProgram, RouteParams, RouteRegistration } from '../src/routing.ts';
import { application, type Application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** React's reserved key is validated page syntax without becoming a registered root prop. */
const CASES = [
  {
    id: 'key-before-prop',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <PublicBoard key={projectId} projectId={projectId} />;}',
    blocking: true,
  },
  {
    id: 'key-after-prop',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <PublicBoard projectId={projectId} key={projectId} />;}',
    blocking: true,
  },
  {
    id: 'renamed-route-param',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId:id}=await params;return <PublicBoard key={id} projectId={id} />;}',
    blocking: true,
  },
  {
    id: 'local-key-name',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId:key}=await params;return <PublicBoard key={key} projectId={key} />;}',
    blocking: true,
  },
  {
    id: 'explicit-closing-root',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <PublicBoard key={projectId} projectId={projectId}></PublicBoard>;}',
    blocking: true,
  },
  {
    id: 'suspended-keyed-root',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nimport {Suspense} from "react";\nexport default function Page({params}:{params:Promise<{projectId:string}>}){return <Suspense fallback={<p>Loading</p>}><Inner params={params}/></Suspense>;}async function Inner({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <PublicBoard key={projectId} projectId={projectId} />;}',
    blocking: false,
  },
  {
    id: 'unkeyed-existing-pin',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <PublicBoard projectId={projectId} />;}',
    blocking: true,
  },
] as const;
const GRAMMAR_PINS = [
  {
    id: 'literal-key',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <PublicBoard key="fixed" projectId={projectId} />;}',
    strict: true,
  },
  {
    id: 'computed-key-value',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <PublicBoard key={projectId+"suffix"} projectId={projectId} />;}',
    strict: true,
  },
  {
    id: 'non-route-identifier',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nconst other="fixed";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <PublicBoard key={other} projectId={projectId} />;}',
    strict: true,
  },
  {
    id: 'literal-key-spread',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <PublicBoard {...{key:projectId}} projectId={projectId} />;}',
    strict: true,
  },
  {
    id: 'duplicate-key',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <PublicBoard key={projectId} key={projectId} projectId={projectId} />;}',
    strict: false,
  },
  {
    id: 'unbound-key',
    source:
      'import PublicBoard from "@/components/public-board.reactive";\nexport default async function Page({params}:{params:Promise<{projectId:string}>}){const {projectId}=await params;return <PublicBoard key={missing} projectId={projectId} />;}',
    strict: false,
  },
];
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

describe('keyed page shape readers', () => {
  it.each(CASES)('$id', ({ source, blocking }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'page.tsx', source);
    const found = pageShapeOf(parsed.sourceFile);

    expect({
      props: found?.props,
      params: found?.destructured,
      blocking: found?.blocking,
    }).toStrictEqual({
      props: { projectId: 'projectId' },
      params: ['projectId'],
      blocking,
    });
  });

  it.each(GRAMMAR_PINS)('preserves the page grammar: $id', ({ source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'page.tsx', source);

    expect(pageShapeOf(parsed.sourceFile)).toBeUndefined();
  });
});

describe('compiled keyed root routes', () => {
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

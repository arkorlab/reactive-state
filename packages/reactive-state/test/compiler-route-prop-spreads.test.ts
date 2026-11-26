import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import type { RegisteredRoute } from '../src/routing.ts';
import {
  application,
  type Application,
  compiledApp,
  output,
  removed,
} from './fixtures/application.ts';

/** JSX overwrite order determines which props still carry their route parameters unchanged. */
const PAGE = 'app/boards/[projectId]/page.tsx';
const MIDDLEWARE = `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
export default (async ({ params }, next) => {
  if (params.projectId !== 'p1') return new Response('Denied', { status: 403 });
  return next();
}) satisfies RouteMiddleware<{ projectId: string }>;
`;

function page(attributes: string): string {
  return `import PublicBoard from '@/components/public-board.reactive';
export default async function Page({ params${attributes.includes('extras') ? ', searchParams' : ''} }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const { projectId } = await params;
  ${attributes.includes('extras') ? 'const extras = await searchParams;' : ''}
  return <PublicBoard ${attributes} />;
}
`;
}

describe('route props after later JSX attributes', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    for (const app of apps) await removed(app);
    api[Symbol.dispose]();
  });

  async function compile(attributes: string) {
    const app = await application({
      [PAGE]: page(attributes),
      'app/boards/[projectId]/middleware.ts': MIDDLEWARE,
    });
    apps.push(app);
    return { app, compiled: compiledApp(app, api) };
  }

  it.each([
    'projectId={projectId} {...{ projectId: "fixed" }}',
    'projectId={projectId} {...(projectId === "p1" ? { projectId: "fixed" } : {})}',
    'projectId={projectId} {...(projectId === "p1" && { projectId: "fixed" })}',
    'projectId={projectId} projectId="fixed"',
  ])('refuses a guarded root whose param is replaced: %s', async (attributes) => {
    const { compiled } = await compile(attributes);

    expect(compiled.refusals).toHaveLength(1);
    expect(compiled.refusals[0]?.reason).toContain('without its param `projectId`');
  });

  it.each([
    ['projectId={projectId} {...{ projectId }}', false],
    ['{...{ projectId }}', false],
    ['projectId="fixed" {...{ projectId }}', false],
    ['projectId={projectId} {...{ projectId, filter: "all" }}', false],
    ['projectId={projectId} {...{ filter: "all" }}', false],
    ['{...{ projectId: "fixed" }} projectId={projectId}', false],
    ['projectId={projectId} {...{ projectId: "fixed" }} projectId={projectId}', false],
    ['{...(projectId === "p1" ? { projectId: "fixed" } : {})} projectId={projectId}', false],
    ['projectId={projectId} {...{}}', false],
    ['projectId="fixed" projectId={projectId}', false],
    ['projectId={projectId}', true],
  ])('preserves the final explicit param mapping: %s', async (attributes, shared) => {
    const { app, compiled } = await compile(attributes);

    expect(compiled.refusals).toStrictEqual([]);

    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      readonly routes: readonly RegisteredRoute[];
    };

    expect(manifest.routes.find((route) => route.route === '/boards/[projectId]')).toMatchObject({
      middleware: ['boards/[projectId]'],
      props: { projectId: 'projectId' },
      root: 'components/public-board',
      shared,
    });
  });

  it.each([
    'projectId={projectId} {...extras}',
    'projectId={projectId} {...{ [projectId]: "fixed" }}',
  ])('keeps unknown later keys outside the guarded page grammar: %s', async (attributes) => {
    const { compiled } = await compile(attributes);

    expect(compiled.refusals).toHaveLength(1);
    expect(compiled.refusals[0]?.reason).toContain(
      'the guard would be left out where the root renders',
    );
  });
});

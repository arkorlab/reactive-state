import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openTypeScript, type Compiled, writeOutputs } from '../src/compiler/index.ts';
import { namesOf } from '../src/compiler/page-shape.ts';
import { parseModule } from '../src/compiler/typescript.ts';
import type { RegisteredRoute } from '../src/routing.ts';
import {
  application,
  type Application,
  compiledApp,
  node,
  output,
  removed,
  source,
  variant,
} from './fixtures/application.ts';

/** Equivalent default import spellings keep the root's route and its middleware guard association. */
const BOARD = 'app/boards/[projectId]/page.tsx';
const PROJECT = 'app/projects/[projectId]/page.tsx';
const ROOT = 'components/public-board';
const ROUTE = '/boards/[projectId]';
const GUARD = `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
export default (async ({ params }, next) => {
  if (params.projectId !== 'p1') return new Response('Denied', { status: 403 });
  return next();
}) satisfies RouteMiddleware<{ projectId: string }>;
`;

/** A page that hands its route param to the imported root. */
function page(imported: string, tag = 'PublicBoard'): string {
  return [
    imported,
    'export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {',
    '  const { projectId } = await params;',
    '  return <RootTag projectId={projectId} />;'.replace('RootTag', () => tag),
    '}',
    '',
  ].join('\n');
}

/** A compile of the fixture with the specified page and middleware, released after its assertions. */
async function withFiles(
  files: Readonly<Record<string, string>>,
  check: (compiled: Compiled, app: Application) => void | Promise<void>,
): Promise<void> {
  const app = await application(files);
  try {
    using api = openTypeScript();
    await check(compiledApp(app, api), app);
  } finally {
    await removed(app);
  }
}

/** The page's route, including a plain route where the compiler failed to associate the root. */
function routeOf(compiled: Compiled, app: Application, route = ROUTE): RegisteredRoute | undefined {
  const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
    readonly routes: readonly RegisteredRoute[];
  };
  return manifest.routes.find((each) => each.route === route);
}

describe('default-value aliases of a page root', () => {
  it.each([
    ["import { default as PublicBoard } from '@/components/public-board.reactive';", 'PublicBoard'],
    [
      "import { 'default' as PublicBoard } from '@/components/public-board.reactive';",
      'PublicBoard',
    ],
    [
      "import { default as PublicBoard } from '../../../components/public-board.reactive';",
      'PublicBoard',
    ],
    [
      "import { default as RenamedBoard } from '@/components/public-board.reactive';",
      'RenamedBoard',
    ],
    [
      "import { type default as BoardType, default as PublicBoard } from '@/components/public-board.reactive';",
      'PublicBoard',
    ],
    ["import PublicBoard from '@/components/public-board.reactive';", 'PublicBoard'],
    [
      "import PublicBoard, { type default as BoardType } from '@/components/public-board.reactive';",
      'PublicBoard',
    ],
  ])('registers the same shared root and guard through %s', async (imported, tag) => {
    await withFiles(
      { [BOARD]: page(imported, tag), 'app/boards/[projectId]/middleware.ts': GUARD },
      (compiled, app) => {
        expect(compiled.refusals).toStrictEqual([]);
        expect(routeOf(compiled, app)).toMatchObject({
          blocking: true,
          middleware: ['boards/[projectId]'],
          props: { projectId: 'projectId' },
          root: ROOT,
          route: ROUTE,
          shared: true,
        });
        expect(output(compiled, app, `${ROOT}.root.tsx`)).toContain('route: "/boards/[projectId]"');
        expect(output(compiled, app, 'middleware/app/boards/[projectId].guard.mts')).toContain(
          "params.projectId !== 'p1'",
        );
      },
    );
  });

  it('recognizes a React default alias around the root inside Suspense', async () => {
    const text = [
      "import { default as React } from 'react';",
      "import { default as PublicBoard } from '@/components/public-board.reactive';",
      'export default function Page({ params }: { params: Promise<{ projectId: string }> }) {',
      '  return <React.Suspense fallback={<p>Loading</p>}><Inner params={params} /></React.Suspense>;',
      '}',
      'async function Inner({ params }: { params: Promise<{ projectId: string }> }) {',
      '  const { projectId } = await params;',
      '  return <PublicBoard projectId={projectId} />;',
      '}',
      '',
    ].join('\n');
    await withFiles(
      { [BOARD]: text, 'app/boards/[projectId]/middleware.ts': GUARD },
      (compiled, app) => {
        expect(compiled.refusals).toStrictEqual([]);
        expect(routeOf(compiled, app)).toMatchObject({ blocking: false, root: ROOT, shared: true });
      },
    );
  });

  it('retains the request-private route mapping and guards for extra props', async () => {
    const text = variant(
      await source(PROJECT),
      "import Project from '@/components/project.reactive';",
      "import { default as Project } from '@/components/project.reactive';",
    );
    await withFiles(
      { [PROJECT]: text, 'app/projects/[projectId]/middleware.ts': GUARD },
      (compiled, app) => {
        expect(compiled.refusals).toStrictEqual([]);
        expect(routeOf(compiled, app, '/projects/[projectId]')).toMatchObject({
          middleware: ['projects/[projectId]'],
          props: { projectId: 'projectId' },
          root: 'components/project',
          shared: false,
        });
        expect(output(compiled, app, 'components/project.root.tsx')).toContain(
          'route: "/projects/[projectId]"',
        );
      },
    );
  });

  it.each([
    "import { default as PublicBoard } from '@/components/public-board.reactive';",
    "import { 'default' as PublicBoard } from '@/components/public-board.reactive';",
    "import PublicBoard from '@/components/public-board.reactive';",
  ])('refuses an unmappable guarded page regardless of default spelling: %s', async (imported) => {
    const text = page(imported).replace(
      'return <PublicBoard projectId={projectId} />;',
      "return projectId === 'p1' && <PublicBoard projectId={projectId} />;",
    );
    await withFiles(
      { [BOARD]: text, 'app/boards/[projectId]/middleware.ts': GUARD },
      (compiled) => {
        expect(compiled.refusals).toHaveLength(1);
        expect(compiled.refusals[0]?.reason).toContain(
          'the guard would be left out where the root renders',
        );
      },
    );
  });

  it('writes a named-default root association into the same registry that executes the guard', async () => {
    await withFiles(
      {
        [BOARD]: page(
          "import { default as PublicBoard } from '@/components/public-board.reactive';",
        ),
        'app/boards/[projectId]/middleware.ts': GUARD,
      },
      (compiled, app) => {
        expect(compiled.refusals).toStrictEqual([]);

        writeOutputs(compiled.outputs, app.out);
        const paths = path.join(import.meta.dirname, '../src/authority/paths.ts');
        const script = [
          `import { registerPaths } from ${JSON.stringify(paths)};`,
          `registerPaths(${JSON.stringify(app.tsconfig)});`,
          `const registry = await import(${JSON.stringify(path.join(app.out, 'authority.mts'))});`,
          `const route = registry.routes.find((each) => each.route === ${JSON.stringify(ROUTE)});`,
          'const guard = registry.middleware[route.middleware[0]].guard;',
          "const answers = await Promise.all(['p1', 'p2'].map((projectId) => guard({ params: { projectId } })));",
          'process.stdout.write(JSON.stringify({ root: route.root, props: route.props, answers }));',
        ].join('\n');
        const ran = node(script, app.root);

        expect(ran).toMatchObject({ status: 0 });
        expect(JSON.parse(ran.stdout)).toMatchObject({
          root: ROOT,
          props: { projectId: 'projectId' },
          answers: [null, { body: 'Denied', status: 403 }],
        });
      },
    );
  });
});

describe('namespace imports of a reactive root', () => {
  it('refuses a namespace root import under a guard when its member render has no supported mapping', async () => {
    await withFiles(
      {
        [BOARD]: page(
          "import * as Board from '@/components/public-board.reactive';",
          'Board.default',
        ),
        'app/boards/[projectId]/middleware.ts': GUARD,
      },
      (compiled) => {
        expect(compiled.refusals).toHaveLength(1);
        expect(compiled.refusals[0]?.reason).toContain(
          'the guard would be left out where the root renders',
        );
      },
    );
  });

  it('keeps a type-only namespace import from making an ordinary page a root render', async () => {
    const text =
      "import type * as Board from '@/components/public-board.reactive';\nexport default function Page() { return <p>Plain page</p>; }\n";
    await withFiles(
      { [BOARD]: text, 'app/boards/[projectId]/middleware.ts': GUARD },
      (compiled, app) => {
        expect(compiled.refusals).toStrictEqual([]);
        expect(routeOf(compiled, app)).toMatchObject({
          plain: 'page',
          middleware: ['boards/[projectId]'],
          route: ROUTE,
        });
        expect(output(compiled, app, `${ROOT}.root.tsx`)).not.toContain(
          'route: "/boards/[projectId]"',
        );
      },
    );
  });
});

describe('default import names of a page', () => {
  it.each([
    ["import Root from './root';", ['Root']],
    ["import { default as Root } from './root';", ['Root']],
    ["import { 'default' as Root } from './root';", ['Root']],
    ["import { type default as Shape, default as Root } from './root';", ['Root']],
    ["import type Root from './root';", []],
    ["import type { default as Root } from './root';", []],
    ["import { type default as Root } from './root';", []],
    ["import { type 'default' as Root } from './root';", []],
    ["import { Root } from './root';", []],
    ["import * as Root from './root';", []],
  ])('keeps only actual default-value bindings: %s', (text, expected) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'page.tsx', text);

    expect([...namesOf(parsed.sourceFile).defaults.keys()]).toStrictEqual(expected);
  });
});

import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const LAYOUT = 'app/boards/layout.tsx';
function layout(statements: string): string {
  return `import type { ReactNode } from 'react';\nexport default function Layout(props: { children: ReactNode }) { ${statements} return <section>{props['children']}</section>; }\n`;
}

describe('query property names and ordinary text around a shared route', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const app of apps) await removed(app);
  });

  async function route(
    text: string,
  ): Promise<{ readonly shared: boolean; readonly private?: string }> {
    const app = await application({ [LAYOUT]: text });
    apps.push(app);
    const compiled = compiledApp(app, api);

    expect(compiled.refusals).toStrictEqual([]);

    const manifest = JSON.parse(
      compiled.outputs.get(path.join(app.out, 'manifest.json')) ?? '{}',
    ) as {
      readonly routes: readonly {
        readonly route: string;
        readonly shared: boolean;
        readonly private?: string;
      }[];
    };
    const found = manifest.routes.find((each) => each.route === '/boards/[projectId]');

    expect(found).toBeDefined();

    return found!;
  }

  it.each([
    "const label = 'searchParams'; void label;",
    'const label = `searchParams`; void label;',
    "const value = { label: 'searchParams' }; void value.label;",
    "const values = ['searchParams']; void values.length;",
    "const { label = 'searchParams' } = { label: 'data' }; void label;",
    "function label() { return 'searchParams'; } void label();",
    "const value = { 'searchParams': 'data' }; void value;",
    'const value = { [`searchParams`]: "data" }; void value;',
  ])('keeps literal content shared: %s', async (statements) => {
    await expect(route(layout(statements))).resolves.toMatchObject({ shared: true });
  });

  it.each([
    'void (props as Record<string, unknown>).searchParams;',
    "void (props as Record<string, unknown>)['searchParams'];",
    'void (props as Record<string, unknown>)[`searchParams`];',
    'const { searchParams } = props as Record<string, unknown>; void searchParams;',
    'const { searchParams: query } = props as Record<string, unknown>; void query;',
    "const { 'searchParams': query } = props as Record<string, unknown>; void query;",
    'const { [`searchParams`]: query } = props as Record<string, unknown>; void query;',
  ])('keeps actual property reads and bindings private: %s', async (statements) => {
    await expect(route(layout(statements))).resolves.toMatchObject({
      private: '`app/boards/layout.tsx` reads `searchParams`',
      shared: false,
    });
  });

  it.each([true, false])(
    'keeps an aliased query selector outside the guarded page shape: %s',
    async (topLevel) => {
      const key = "const KEY = 'searchParams';";
      const text = `import PublicBoard from '@/components/public-board.reactive';
      ${topLevel ? key : ''}
      export default async function Page(props: { params: Promise<{ projectId: string }> }) {
        const { projectId } = await props.params;
        ${topLevel ? '' : key}
        const query = props[KEY];
        return <section data-label={String(query)}><PublicBoard projectId={projectId /* route param */} /></section>;
      }`;
      const middleware = `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
      export default (async ({ params }, next) => {
        if (!params.projectId) return new Response('Denied', { status: 403 });
        return next();
      }) satisfies RouteMiddleware<{ projectId: string }>;`;
      const app = await application({
        'app/boards/[projectId]/page.tsx': text,
        'app/boards/[projectId]/middleware.ts': middleware,
      });
      apps.push(app);
      const compiled = compiledApp(app, api);

      expect(compiled.refusals).toStrictEqual([]);

      const manifest = JSON.parse(
        compiled.outputs.get(path.join(app.out, 'manifest.json')) ?? '{}',
      ) as {
        readonly routes: readonly {
          readonly route: string;
          readonly shared: boolean;
          readonly guarded?: boolean;
          readonly private?: string;
        }[];
      };

      expect(manifest.routes.find((each) => each.route === '/boards/[projectId]')).toMatchObject({
        guarded: true,
        private: 'the page renders more than its root of its params',
        shared: false,
      });
    },
  );
});

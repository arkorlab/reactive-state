import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { NextAdapter } from 'next';
import { describe, expect, it, vi } from 'vitest';

import { createReactiveAdapter } from '../src/next/adapter.ts';
import type * as CompileOnBuild from '../src/next/compile-on-build.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Registration is compiled for real; the adapter reuses exactly that emitted manifest. */
vi.mock(import('../src/next/compile-on-build.ts'), async (importOriginal) => {
  const actual = await importOriginal<typeof CompileOnBuild>();
  return {
    ...actual,
    compileProject: vi.fn((options: CompileOnBuild.ProjectOptions) =>
      Promise.resolve({ ...actual.layoutOf(options), changed: false, compiled: false }),
    ),
  };
});

const CASES = [
  {
    id: 'reported equal dynamic paths',
    names: ['/Admin/[id]', '/admin/[id]'],
    collides: true,
  },
  {
    id: 'reverse source order',
    names: ['/admin/[id]', '/Admin/[id]'],
    collides: true,
  },
  {
    id: 'other delivered route more specific',
    names: ['/hub/[section]/[id]', '/HUB/admin/[id]'],
    collides: true,
  },
  {
    id: 'other delivered route less specific',
    names: ['/hub/admin/[id]', '/HUB/[section]/[id]'],
    collides: true,
  },
  {
    id: 'delivered handler and page',
    names: ['/Admin/[id]', '/admin/[id]'],
    collides: true,
    handler: true,
  },
  {
    id: 'same-case rank ordering',
    names: ['/hub/[section]/[id]', '/hub/admin/[id]'],
    collides: false,
  },
  {
    id: 'disjoint lengths',
    names: ['/Admin/[id]', '/admin/detail/[id]'],
    collides: false,
  },
  {
    id: 'legacy insensitive Kelvin distinction',
    names: ['/k/[id]', '/K/[id]'],
    collides: false,
  },
  {
    id: 'literal pattern characters',
    names: ['/a+b/[id]', '/aXb/[id]'],
    collides: false,
  },
] as const;

/** A native page or GET handler and source-written route middleware under every delivered pattern. */
function filesFor(names: readonly string[], handler: boolean): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const [index, name] of names.entries()) {
    const directory = `app${name}`;
    const endpoint = handler && index === 0 ? 'route.ts' : 'page.tsx';
    files[`${directory}/${endpoint}`] =
      endpoint === 'route.ts'
        ? 'export function GET(){return new Response("native");}\n'
        : 'export default function Page(){return <main>native</main>;}\n';
    const params = name
      .split('/')
      .filter((segment) => segment.startsWith('['))
      .map((segment) => segment.slice(1, -1));
    const shape = params.map((param) => `${param}:string`).join(';');
    files[`${directory}/middleware.ts`] =
      "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\n" +
      "import {requirePublishedProject} from '@/publication';\n" +
      `export default (async({params},next)=>{await requirePublishedProject(params.id);return next();}) satisfies RouteMiddleware<{${shape}}>;\n`;
  }
  return files;
}

/** The actual adapter refusal, where its concrete rewrite case setting is available. */
async function adapterReason(root: string, sensitive: boolean): Promise<string> {
  type Config = Parameters<NonNullable<NextAdapter['modifyConfig']>>[0];
  type Context = Parameters<NonNullable<NextAdapter['modifyConfig']>>[1];

  const config = {
    cacheComponents: false,
    configFile: undefined,
    configFileName: 'next.config.js',
    experimental: { cachedNavigations: false, useCache: false, caseSensitiveRoutes: sensitive },
    pageExtensions: ['tsx', 'ts', 'jsx', 'js'],
    poweredByHeader: true,
  } as unknown as Config;
  const context = {
    nextVersion: '16.4.2',
    phase: 'phase-production-build',
    projectDir: root,
  } as Context;
  try {
    await createReactiveAdapter().modifyConfig?.(config, context);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('compiled delivered route case collisions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES.flatMap((item) => [false, true].map((sensitive) => ({ ...item, sensitive }))))(
    '$id sensitive=$sensitive',
    async ({ names, collides, sensitive, ...item }) => {
      const app = await application(filesFor(names, 'handler' in item));
      apps.push(app);
      const compiled = compile(app);

      expect(compiled.refusals).toStrictEqual([]);
      expect(
        compiled.manifest?.routes
          .filter((route) => names.some((name) => name === route.route))
          .map((route) => route.route)
          .toSorted((first, second) => first.localeCompare(second)),
      ).toStrictEqual([...names].toSorted((first, second) => first.localeCompare(second)));

      await mkdir(app.out, { recursive: true });
      await writeFile(path.join(app.out, 'manifest.json'), output(compiled, app, 'manifest.json'));
      const reason = await adapterReason(app.root, sensitive);
      const collision = expect.stringContaining('case-insensitive delivery rewrite');
      const expected = collides && !sensitive ? collision : '';

      expect(reason).toStrictEqual(expected);
    },
  );
});

import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import type { RouteRegistration } from '../src/routing.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

const require = createRequire(import.meta.url);
const ESM_HEADERS = [
  'next/headers.js?probe',
  'next/headers.js#probe',
  'next/%68eaders.js',
  'next/hea%64ers.js?probe#fragment',
  'next/dist/server/request/coo%6bies.js',
] as const;
const HEADERS = [
  ['next/./headers.js', 'next/headers.js'],
  ['next//headers.js', 'next/headers.js'],
  ['next/dist/server/request/./cookies.js', 'next/dist/server/request/cookies.js'],
  ['next/dist/server/request/../request/cookies.js', 'next/dist/server/request/cookies.js'],
  ['next/dist/esm/server/request/../request/cookies.js', 'next/dist/esm/server/request/cookies.js'],
] as const;

const DIRECTORIES = [
  ['next/dist/server/web/exports/', 'next/dist/server/web/exports/index.js'],
  ['next/dist/server/web/exports/.', 'next/dist/server/web/exports/index.js'],
  ['next/dist/server/web/exports///', 'next/dist/server/web/exports/index.js'],
  ['next/dist/esm/server/web/exports/', 'next/dist/esm/server/web/exports/index.js'],
] as const;

interface Manifest {
  readonly routes: readonly RouteRegistration[];
}

/** A layout that renders what the imported request API answers beside its children. */
function layoutOf(imported: string, expression: string): string {
  return [
    "import type { ReactNode } from 'react';",
    imported,
    'export default async function Layout({ children }: { children?: ReactNode }) {',
    `  const shown = ${expression};`,
    '  return <section data-shown={shown}>{children}</section>;',
    '}',
  ].join('\n');
}

describe('request reads through resolved Next module spellings', () => {
  const { apps, compile } = compilerApplications();

  async function boardWith(files: Readonly<Record<string, string>>): Promise<RouteRegistration> {
    const app = await application(files);
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);

    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as Manifest;
    const board = manifest.routes.find((route) => route.route === '/boards/[projectId]');
    if (board === undefined) throw new Error('No board route was registered.');
    return board;
  }

  it.each(HEADERS)('keeps a cookie read private through %s', async (specifier, canonical) => {
    expect(require.resolve(specifier)).toBe(require.resolve(canonical));

    const board = await boardWith({
      'app/boards/layout.tsx': layoutOf(
        `import { cookies } from '${specifier}';`,
        "(await cookies()).get('private-viewer')?.value ?? ''",
      ),
    });

    expect(board).toMatchObject({ shared: false });
    expect(board.private).toContain('reads the request (`next/headers`)');
  });

  it.each(ESM_HEADERS)('keeps a native ESM cookie read private through %s', async (specifier) => {
    const board = await boardWith({
      'app/boards/layout.jsx': [
        `import { cookies } from '${specifier}';`,
        'export default async function Layout({ children }) {',
        "  const shown = (await cookies()).get('private-viewer')?.value ?? '';",
        '  return <section data-shown={shown}>{children}</section>;',
        '}',
      ].join('\n'),
    });

    expect(board).toMatchObject({ shared: false });
    expect(board.private).toContain('reads the request (`next/headers`)');
  });

  it.each(DIRECTORIES)(
    'keeps a directory barrel request read private: %s',
    async (specifier, canonical) => {
      expect(require.resolve(specifier)).toBe(require.resolve(canonical));

      const board = await boardWith({
        'app/boards/layout.tsx': layoutOf(
          `import { connection } from '${specifier}';`,
          "(await connection(), '')",
        ),
      });

      expect(board).toMatchObject({ shared: false });
      expect(board.private).toContain('reads the request (`connection`)');
    },
  );

  it.each(['next/dist/server/web/exports/', 'next/dist/esm/server/web/exports/'])(
    'keeps a pure directory barrel named export shared: %s',
    async (specifier) => {
      const board = await boardWith({
        'app/boards/layout.tsx': layoutOf(
          `import { NextResponse } from '${specifier}';`,
          'NextResponse.name',
        ),
      });

      expect(board).toMatchObject({ shared: true });
      expect(board.private).toBeUndefined();
    },
  );

  it.each([
    "import server from 'next/server.js';",
    "import { default as server } from 'next/server.js';",
  ])('keeps a default server namespace private: %s', async (imported) => {
    const board = await boardWith({
      'app/boards/layout.tsx': layoutOf(imported, "(await server.connection(), '')"),
    });

    expect(board).toMatchObject({ shared: false });
    expect(board.private).toContain('reads the request (`connection`)');
  });

  it.each([
    "import navigation from 'next/navigation.js';",
    "import { default as navigation } from 'next/navigation.js';",
  ])('keeps a default navigation namespace private: %s', async (imported) => {
    const board = await boardWith({
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { Highlight } from '@/highlight';",
        'export default function Layout({ children }: { children?: ReactNode }) {',
        '  return <section><Highlight />{children}</section>;',
        '}',
      ].join('\n'),
      'highlight.tsx': [
        "'use client';",
        imported,
        'export function Highlight() {',
        "  return <mark>{navigation.useSearchParams().get('private-query')}</mark>;",
        '}',
      ].join('\n'),
    });

    expect(board).toMatchObject({ shared: false });
    expect(board.private).toContain("reads the request's query (`useSearchParams`)");
  });

  it('keeps inline type imports and pure named exports shared', async () => {
    const board = await boardWith({
      'app/boards/layout.tsx': layoutOf(
        [
          "import { type ReadonlyHeaders } from 'next/./headers.js';",
          "import { NextResponse } from 'next//server.js';",
        ].join('\n'),
        "(null as ReadonlyHeaders | null) === null ? NextResponse.name : ''",
      ),
    });

    expect(board).toMatchObject({ shared: true });
    expect(board.private).toBeUndefined();
  });

  it('keeps React server navigation apart from the query-reading client module', async () => {
    const board = await boardWith({
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import * as navigation from 'next/dist/client/components/./navigation.react-server.js';",
        'export default function Layout({ children }: { children?: ReactNode }) {',
        '  return children ?? navigation.notFound();',
        '}',
      ].join('\n'),
    });

    expect(board).toMatchObject({ shared: true });
    expect(board.private).toBeUndefined();
  });
});

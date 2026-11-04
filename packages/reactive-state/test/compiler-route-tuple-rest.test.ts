import { describe, expect, it } from 'vitest';

import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

describe('tuple rest inference in published routes', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      id: 'finite inferred rest error',
      declaration:
        'type Tail<T> = T extends [unknown, ...infer R] ? R : never; type Failure = Tail<[string, Error]>[0];',
      error: true,
      argument: 'new Error("fixed")',
      source:
        'type Tail<T> = T extends [unknown, ...infer R] ? R : never; type Failure = Tail<[string, Error]>[0];\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames(new Error("fixed")); }',
      originalArgumentInvocation: 'frames(new Error("fixed"))',
      routeInvocation: 'label("route")',
    },
    {
      id: 'finite inferred rest data excludes prefix error',
      declaration:
        'type Tail<T> = T extends [unknown, ...infer R] ? R : never; type Failure = Tail<[Error, { stack: string }]>[0];',
      error: false,
      argument: '{ stack: value }',
      source:
        'type Tail<T> = T extends [unknown, ...infer R] ? R : never; type Failure = Tail<[Error, { stack: string }]>[0];\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames({ stack: value }); }',
      originalArgumentInvocation: 'frames({ stack: value })',
      routeInvocation: 'label("route")',
    },
    {
      id: 'native array rest inferred error',
      declaration:
        'type Tail<T> = T extends [unknown, ...infer R] ? R : never; type Failure = Tail<[string, ...Error[]]>[number];',
      error: true,
      argument: 'new Error("fixed")',
      source:
        'type Tail<T> = T extends [unknown, ...infer R] ? R : never; type Failure = Tail<[string, ...Error[]]>[number];\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames(new Error("fixed")); }',
      originalArgumentInvocation: 'frames(new Error("fixed"))',
      routeInvocation: 'label("route")',
    },
    {
      id: 'native array rest data excludes prefix error',
      declaration:
        'type Tail<T> = T extends [unknown, ...infer R] ? R : never; type Failure = Tail<[Error, ...{ stack: string }[]]>[number];',
      error: false,
      argument: '{ stack: value }',
      source:
        'type Tail<T> = T extends [unknown, ...infer R] ? R : never; type Failure = Tail<[Error, ...{ stack: string }[]]>[number];\nfunction frames(error: Failure): string { return error.stack ?? ""; }\nexport function label(value: string) { return value + frames({ stack: value }); }',
      originalArgumentInvocation: 'frames({ stack: value })',
      routeInvocation: 'label("route")',
    },
  ])('$id', async (row) => {
    const children = '{children}';
    const app = await application({
      'domain/error-rest.ts': row.source,
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { label } from '@/domain/error-rest';",
        `export default function Layout({children}:{children:ReactNode}) { return <section data-shown={String(${row.routeInvocation})}>${children}</section>; }`,
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(board).toMatchObject({ shared: !row.error });
  });
});

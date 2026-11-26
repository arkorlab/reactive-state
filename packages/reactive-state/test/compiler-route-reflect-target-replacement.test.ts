import { describe, expect, it } from 'vitest';

import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
import { REFLECT_TARGET_CASES } from './support/reflect-target-cases.ts';

/** Rendered layouts retain written tuple receiver replacements without refusing ordinary data. */
describe('rendered routes with Reflect tuple receiver replacements', () => {
  const { apps, compile } = compilerApplications();

  it.each(REFLECT_TARGET_CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        source,
        [
          `export default function Layout({children}:{children:ReactNode}) { return <section data-shown={String(${invocation})}>`,
          '{children}</section>; }',
        ].join(''),
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const reasons = compiled.refusals.map((item) => item.reason);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(reasons).toStrictEqual([]);
    expect(board).toMatchObject({ shared: !refused });
    expect(board?.private === undefined).toBe(!refused);
  });
});

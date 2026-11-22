import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Modules } from '../src/compiler/modules.ts';
import { Reach } from '../src/compiler/reach.ts';
import { scanRouting } from '../src/compiler/routes.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * The roots a layout renders are the same for every page below it: the compile reads them once for
 * the check of the pages' chains, not once for each page. An application with route middleware reads
 * every page and the layouts around it for this; a root layout's imports are walked as often as the
 * application has pages where it is read for each.
 */

const MIDDLEWARE = `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
export default (async (_context, next) => {
  const response = await next();
  response.headers.set('x-a', '1');
  return response;
}) satisfies RouteMiddleware<Record<string, never>>;
`;

const GUARD = `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
export default (async (_context, next) => {
  if (1 < 0) return new Response('no', { status: 403 });
  return next();
}) satisfies RouteMiddleware<Record<string, never>>;
`;

const PAGE = 'export default function Page() {\n  return <p>page</p>;\n}\n';

describe('the roots a layout renders, for the check of the pages below it', () => {
  let api: API;
  const roots: string[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await Promise.all(roots.map(async (root) => rm(root, { force: true, recursive: true })));
  });

  /**
   * How often a layout of three imports is read for its roots, and what `scanRouting` refuses, of an
   * application of `pages` pages under it and a middleware at `/admin`, and a guard around them all if `guarded`.
   */
  async function scanned(
    pages: number,
    options: { readonly layout: string; readonly guarded: boolean },
  ): Promise<{ readonly reads: number; readonly refusals: readonly string[] }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-wrapper-roots-'));
    roots.push(root);
    const src = path.join(root, 'src');
    await mkdir(path.join(src, 'app', 'admin'), { recursive: true });
    await mkdir(path.join(src, 'ui'), { recursive: true });
    await mkdir(path.join(src, 'components'), { recursive: true });
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );
    await Promise.all(
      ['a', 'b', 'c'].map(async (name) => {
        return writeFile(
          path.join(src, 'ui', `${name}.tsx`),
          `export function ${name.toUpperCase()}() {\n  return <i>${name}</i>;\n}\n`,
        );
      }),
    );
    await writeFile(
      path.join(src, 'components', 'stats.reactive.tsx'),
      'export default function Stats() {\n  return <p>stats</p>;\n}\n',
    );
    await writeFile(path.join(src, 'app', 'layout.tsx'), options.layout);
    await writeFile(path.join(src, 'app', 'admin', 'middleware.ts'), MIDDLEWARE);
    if (options.guarded) {
      await writeFile(path.join(src, 'app', 'middleware.ts'), GUARD);
    }
    await Promise.all(
      Array.from({ length: pages }, async (_, index) => {
        const directory = path.join(src, 'app', `p${String(index)}`);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, 'page.tsx'), PAGE);
      }),
    );
    const spy = vi.spyOn(Reach.prototype, 'renderedComponents');
    const refusals: string[] = [];
    using modules = new Modules(api, src);
    scanRouting({
      appDir: path.join(src, 'app'),
      attempt: <T>(run: () => T): T | undefined => {
        try {
          return run();
        } catch (error) {
          refusals.push(error instanceof Error ? error.message : String(error));
          return undefined;
        }
      },
      components: [],
      database: undefined,
      modules,
      outDir: path.join(root, '.reactive'),
    });
    const reads = spy.mock.calls.length;
    spy.mockRestore();
    return { reads, refusals };
  }

  const SHELL = 'export default function Layout({ children }: { children: React.ReactNode }) {\n';

  const LAYOUT = [
    "import { A } from '@/ui/a';",
    "import { B } from '@/ui/b';",
    "import { C } from '@/ui/c';",
    SHELL,
    '  return <html><body><A /><B /><C />{children}</body></html>;',
    '}',
    '',
  ].join('\n');

  it('reads the imports of a layout once, whatever the number of pages below it', async () => {
    const few = await scanned(2, { guarded: false, layout: LAYOUT });
    const many = await scanned(24, { guarded: false, layout: LAYOUT });

    expect(few.refusals).toStrictEqual([]);
    expect(many.refusals).toStrictEqual([]);
    expect(few.reads).toBeGreaterThan(0);
    expect(many.reads).toBe(few.reads);
  });

  it('still refuses a root a layout renders under a guard no route names', async () => {
    const found = await scanned(3, {
      guarded: true,
      layout: [
        "import Stats from '@/components/stats.reactive';",
        SHELL,
        '  return <html><body><Stats />{children}</body></html>;',
        '}',
        '',
      ].join('\n'),
    });

    expect(found.refusals).toHaveLength(1);
    expect(found.refusals[0]).toContain('`components/stats` is rendered by `app/layout.tsx`');
    expect(found.refusals[0]).toContain('no registered route associates this root');
  });
});

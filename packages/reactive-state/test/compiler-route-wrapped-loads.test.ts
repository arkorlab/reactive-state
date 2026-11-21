import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Modules } from '../src/compiler/modules.ts';
import { scanRouting } from '../src/compiler/routes.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * A page under a guard that renders a reactive root through a module load — `import('…')`,
 * `require('…')` — is refused unless a registered route names the root: where the root renders, the
 * guard would be left out. The specifier is read as the literal it is past parentheses, a cast,
 * `satisfies` and `!`; one the code computes is none the compile can name.
 */

interface Row {
  readonly id: string;
  /** The module load, as the page writes it. */
  readonly load: string;
}

const ROOT = '@/components/stats.reactive';

/** The one literal specifier, however it is written around: refused under a guard. */
const LITERAL: readonly Row[] = [
  { id: 'import', load: `import('${ROOT}')` },
  { id: 'import-of-a-template', load: `import(\`${ROOT}\`)` },
  { id: 'import-in-parentheses', load: `import(('${ROOT}'))` },
  { id: 'import-in-two-parentheses', load: `import((('${ROOT}')))` },
  { id: 'import-of-a-template-in-parentheses', load: `import((\`${ROOT}\`))` },
  { id: 'import-cast', load: `import('${ROOT}' as string)` },
  { id: 'import-satisfies', load: `import('${ROOT}' satisfies string)` },
  { id: 'import-non-null', load: `import('${ROOT}'!)` },
  { id: 'require', load: `require('${ROOT}')` },
  { id: 'require-in-parentheses', load: `require(('${ROOT}'))` },
  { id: 'require-cast', load: `require('${ROOT}' as string)` },
];

/** A specifier the code computes: no module the compile can name. */
const COMPUTED: readonly Row[] = [
  { id: 'element-of-an-array', load: `import([ '${ROOT}' ][0])` },
  { id: 'concatenation', load: `import('@/components/' + 'stats.reactive')` },
];

const MIDDLEWARE = `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
export default (async ({ params }, next) => {
  if (params.projectId === 'z') return new Response('no', { status: 403 });
  return next();
}) satisfies RouteMiddleware<{ projectId: string }>;
`;

const pageOf = (load: string): string =>
  `export default async function Page() {\n  const { default: Stats } = await ${load};\n  return <Stats />;\n}\n`;

const STATS = 'export default function Stats() {\n  return <p>stats</p>;\n}\n';

describe('a page under a guard that renders a root through a load of a module', () => {
  let api: API;
  const roots: string[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await Promise.all(roots.map(async (root) => rm(root, { force: true, recursive: true })));
  });

  /** What `scanRouting` refuses of an application whose one page, under a guard if `guarded`, loads the root. */
  async function refusals(row: Row, guarded: boolean): Promise<readonly string[]> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-wrapped-loads-'));
    roots.push(root);
    const src = path.join(root, 'src');
    const directory = path.join(src, 'app', 'boards', '[projectId]', 'extra');
    await mkdir(directory, { recursive: true });
    await mkdir(path.join(src, 'components'), { recursive: true });
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );
    await writeFile(path.join(src, 'components', 'stats.reactive.tsx'), STATS);
    await writeFile(path.join(directory, 'page.tsx'), pageOf(row.load));
    await writeFile(
      path.join(src, 'app', 'boards', '[projectId]', guarded ? 'middleware.ts' : 'unused.ts'),
      MIDDLEWARE,
    );
    const found: string[] = [];
    using modules = new Modules(api, src);
    scanRouting({
      appDir: path.join(src, 'app'),
      attempt: <T>(run: () => T): T | undefined => {
        try {
          return run();
        } catch (error) {
          found.push(error instanceof Error ? error.message : String(error));
          return undefined;
        }
      },
      components: [],
      database: undefined,
      modules,
      outDir: path.join(root, '.reactive'),
    });
    return found;
  }

  it.each(LITERAL)('refuses a root loaded by a literal specifier: $id', async (row) => {
    const found = await refusals(row, true);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('is rendered by');
    expect(found[0]).toContain('the guard would be left out');
  });

  it.each(LITERAL)('takes the same load where no guard is around: $id', async (row) => {
    await expect(refusals(row, false)).resolves.toStrictEqual([]);
  });

  it.each(COMPUTED)('names no root by a specifier the code computes: $id', async (row) => {
    await expect(refusals(row, true)).resolves.toStrictEqual([]);
  });
});

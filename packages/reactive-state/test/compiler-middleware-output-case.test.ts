import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileApp } from '../src/compiler/index.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * The compile writes a route middleware's guard and envelope at the path of its route
 * (`middleware/app/Admin/[id].guard.mts`), so two routes that differ in case alone, each with a
 * route middleware, are two outputs that differ in case alone. They are no two files the compile
 * names over each other: each is of a directory of the application's own, and where the file system
 * keeps no case (macOS, Windows) the two directories are one and the application has one route.
 * Which of such routes are one to a request is Next.js's to say, by its `caseSensitiveRoutes`, and
 * the adapter's to refuse, by the delivery rewrite it writes; the compile writes both, as it did
 * before it refused two outputs that differ in case alone.
 *
 * An output of a route middleware that another output of the build shares its name with, in the
 * case it is written in or but for case — a `'use server'` module's stub — is refused as any two
 * are: that module is not of the route's directory, and where no case is kept the stub and the
 * envelope are one file.
 *
 * Each row compiles a small application through `compileApp` and reads what it refuses and writes.
 * The rows of two routes write two directories of the application's that differ in case alone:
 * they run where the temporary directory keeps case, and are skipped where it keeps none.
 */

const api = openTypeScript();
const dirs: string[] = [];

/** Whether the temporary directory keeps the case of a name: of the files `a` and `A`, it holds two. */
function keepsCase(): boolean {
  const probe = mkdtempSync(path.join(tmpdir(), 'reactive-state-case-probe-'));
  try {
    writeFileSync(path.join(probe, 'a'), '');
    return !existsSync(path.join(probe, 'A'));
  } finally {
    rmSync(probe, { force: true, recursive: true });
  }
}

const KEEPS_CASE = keepsCase();

const DATABASE = `import { boolean, database, table, text } from '@arkorlab/reactive-state/server';
export const db = database({
  todos: table({ projectId: text({ maxLength: 64 }), title: text({ maxLength: 200 }), completed: boolean() }),
});
`;

/** A page of Next.js's own, of no state. */
const PAGE = 'export default function Page() {\n  return <main>native</main>;\n}\n';

/** A route handler of Next.js's own. */
const HANDLER = "export function GET() {\n  return new Response('native');\n}\n";

/** A route middleware that answers before the route does: the compile writes a guard of it. */
const GUARD = [
  "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
  'export default (async ({ params }, next) => {',
  "  if (params.id === '') {",
  '    return new Response(null, { status: 404 });',
  '  }',
  '  return next();',
  '}) satisfies RouteMiddleware<{ id: string }>;',
  '',
].join('\n');

/** A route middleware that writes into what the route answered: the compile writes an envelope of it. */
const ENVELOPE = [
  "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
  'export default (async (_context, next) => {',
  '  const response = await next();',
  "  response.headers.set('x-checked', 'yes');",
  '  return response;',
  '}) satisfies RouteMiddleware;',
  '',
].join('\n');

/** A `'use server'` module of one function. */
const ACTIONS = [
  "'use server';",
  'export async function save(form: FormData): Promise<void> {',
  '  void form;',
  '}',
  '',
].join('\n');

/** A component that submits the `'use server'` module `specifier` names. */
function submitting(specifier: string): string {
  return [
    "import { useReactiveState } from 'framework/react';",
    `import { save } from '${specifier}';`,
    'export default function Board() {',
    '  const [count] = useReactiveState(0);',
    '  return <form action={save}><button type="submit">{count}</button></form>;',
    '}',
    '',
  ].join('\n');
}

/** The Kelvin sign, which `toLowerCase` writes as the letter `k`. */
const KELVIN = '\u{212A}';

interface Compiled {
  /** What the build writes, by its path from the output directory. */
  readonly written: readonly string[];
  readonly refusals: readonly string[];
}

/** The build of the application of `files` (under `src`). */
function compiled(files: Readonly<Record<string, string>>): Compiled {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-middleware-output-case-'));
  dirs.push(root);
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  );
  const source = path.join(root, 'src');
  const sources = Object.entries({ 'db.ts': DATABASE, ...files });
  for (const [name, content] of sources) {
    mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    writeFileSync(path.join(source, name), content);
  }
  mkdirSync(path.join(source, 'app'), { recursive: true });
  const result = compileApp({
    api,
    appDir: path.join(source, 'app'),
    outDir: path.join(root, '.reactive'),
    srcDir: source,
  });
  return {
    refusals: result.refusals.map((refusal) => refusal.message),
    written: [...result.outputs.keys()]
      .map((file) => path.relative(path.join(root, '.reactive'), file))
      .toSorted((a, b) => a.localeCompare(b)),
  };
}

describe('what the compile writes of route middleware, where routes differ in case alone', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('two routes that differ in case alone, each with a route middleware, are written', () => {
    it.skipIf(!KEEPS_CASE)('a guard of each', () => {
      const { refusals, written } = compiled({
        'app/Admin/[id]/middleware.ts': GUARD,
        'app/Admin/[id]/page.tsx': PAGE,
        'app/admin/[id]/middleware.ts': GUARD,
        'app/admin/[id]/page.tsx': PAGE,
      });

      expect(refusals).toStrictEqual([]);
      expect(written).toContain('middleware/app/Admin/[id].guard.mts');
      expect(written).toContain('middleware/app/admin/[id].guard.mts');
    });

    it.skipIf(!KEEPS_CASE)('an envelope of each', () => {
      const { refusals, written } = compiled({
        'app/Admin/[id]/middleware.ts': ENVELOPE,
        'app/Admin/[id]/page.tsx': PAGE,
        'app/admin/[id]/middleware.ts': ENVELOPE,
        'app/admin/[id]/page.tsx': PAGE,
      });

      expect(refusals).toStrictEqual([]);
      expect(written).toContain('middleware/app/Admin/[id].envelope.ts');
      expect(written).toContain('middleware/app/admin/[id].envelope.ts');
    });

    it.skipIf(!KEEPS_CASE)('a route handler and a page', () => {
      const { refusals, written } = compiled({
        'app/Admin/[id]/middleware.ts': GUARD,
        'app/Admin/[id]/route.ts': HANDLER,
        'app/admin/[id]/middleware.ts': GUARD,
        'app/admin/[id]/page.tsx': PAGE,
      });

      expect(refusals).toStrictEqual([]);
      expect(written).toContain('middleware/app/Admin/[id].guard.mts');
      expect(written).toContain('middleware/app/admin/[id].guard.mts');
    });

    it.skipIf(!KEEPS_CASE)('a letter and the Kelvin sign, which lower case writes alike', () => {
      const { refusals, written } = compiled({
        'app/k/[id]/middleware.ts': GUARD,
        'app/k/[id]/page.tsx': PAGE,
        [`app/${KELVIN}/[id]/middleware.ts`]: GUARD,
        [`app/${KELVIN}/[id]/page.tsx`]: PAGE,
      });

      expect(refusals).toStrictEqual([]);
      expect(written).toContain('middleware/app/k/[id].guard.mts');
      expect(written).toContain(`middleware/app/${KELVIN}/[id].guard.mts`);
    });
  });

  describe('what shares a name with a route middleware’s output is as it was', () => {
    it('a `use server` module named as a route’s envelope is, but for case, is refused', () => {
      const { refusals, written } = compiled({
        'app/boards/middleware.ts': ENVELOPE,
        'app/boards/page.tsx': PAGE,
        'components/Board.reactive.tsx': submitting('@/Middleware/app/boards.envelope'),
        'Middleware/app/boards.envelope.ts': ACTIONS,
      });

      expect(refusals).toStrictEqual([
        "middleware/app/boards.envelope.ts:1:1: Two of what the compile writes, `Middleware/app/boards.envelope.ts` and `middleware/app/boards.envelope.ts`, are one file where the file system keeps no case (macOS, Windows): rename the module of the application's that takes the name.",
      ]);
      expect(written).toStrictEqual([]);
    });

    it('a `use server` module named as a route’s envelope is, in its case, is refused', () => {
      const { refusals } = compiled({
        'app/boards/middleware.ts': ENVELOPE,
        'app/boards/page.tsx': PAGE,
        'components/Board.reactive.tsx': submitting('@/middleware/app/boards.envelope'),
        'middleware/app/boards.envelope.ts': ACTIONS,
      });

      expect(refusals).toStrictEqual([
        "middleware/app/boards.envelope.ts:1:1: Two of what the compile writes are `middleware/app/boards.envelope.ts`: rename the module of the application's that takes the name.",
      ]);
    });

    it('two routes that differ in more than case, each with a route middleware', () => {
      const { refusals, written } = compiled({
        'app/admin/[id]/middleware.ts': GUARD,
        'app/admin/[id]/page.tsx': PAGE,
        'app/admins/[id]/middleware.ts': GUARD,
        'app/admins/[id]/page.tsx': PAGE,
      });

      expect(refusals).toStrictEqual([]);
      expect(written).toContain('middleware/app/admin/[id].guard.mts');
      expect(written).toContain('middleware/app/admins/[id].guard.mts');
    });
  });
});

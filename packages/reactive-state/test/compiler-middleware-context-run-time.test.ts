import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readMiddleware } from '../src/compiler/middleware.ts';
import { Modules } from '../src/compiler/modules.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * A route middleware imports nothing at run time and does not read its module's URL: its parts are
 * written into other modules. A default or a computed key of the context's pattern is run by the
 * part that binds a name of it, so it is held to the same: where the host binds it, `import.meta.url`
 * would be the URL of the host's module, and `import(…)` would name a path relative to it.
 */

interface Row {
  readonly id: string;
  /** The context parameter. */
  readonly context: string;
  /** The statements of the middleware's body, around `next`. */
  readonly body: string;
}

const HOST_READS =
  "  const response = await next();\n  response.headers.set('x-label', String(label));\n  return response;";
const GUARD_READS =
  "  if (label === 'z') return new Response(null, { status: 403 });\n  return next();";

/** A default or a key the part binds that reads its module's URL or imports: refused. */
const REFUSED: readonly Row[] = [
  {
    body: HOST_READS,
    context: '{ params: { label = import.meta.url } }',
    id: 'host-binds-a-default-of-the-module-url',
  },
  {
    body: HOST_READS,
    context: "{ params: { [import.meta.url]: label = 'z' } }",
    id: 'host-binds-a-computed-key-of-the-module-url',
  },
  {
    body: HOST_READS,
    context: '{ params: { a: { label = import.meta.url } = {} } }',
    id: 'host-binds-a-default-within-a-pattern',
  },
  {
    body: HOST_READS,
    context: "{ params: { label = import('node:path') } }",
    id: 'host-binds-a-default-that-imports',
  },
  {
    body: GUARD_READS,
    context: '{ params: { label = import.meta.url } }',
    id: 'guard-binds-a-default-of-the-module-url',
  },
];

/** What reads neither: taken. */
const TAKEN: readonly Row[] = [
  { body: HOST_READS, context: "{ params: { label = 'z' } }", id: 'a-default-of-a-literal' },
  { body: HOST_READS, context: '{ params: { label } }', id: 'no-default' },
];

describe('a default of a route middleware’s context that imports or reads its module’s URL', () => {
  let api: API;
  const roots: string[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await Promise.all(roots.map(async (root) => rm(root, { force: true, recursive: true })));
  });

  /** What `readMiddleware` refuses of the middleware, or `undefined`. */
  async function refused(row: Row): Promise<string | undefined> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-context-run-time-'));
    roots.push(root);
    const src = path.join(root, 'src');
    const directory = path.join(src, 'app', 'boards', '[projectId]');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );
    const file = path.join(directory, 'middleware.ts');
    await writeFile(
      file,
      `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (${row.context}, next) => {\n${row.body}\n}) satisfies RouteMiddleware<{ projectId: string }>;\n`,
    );
    using modules = new Modules(api, src);
    try {
      readMiddleware({ file, id: 'boards/[projectId]', modules });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it.each(REFUSED)('refuses what a part binds that imports or reads the URL: $id', async (row) => {
    await expect(refused(row)).resolves.toContain('imports nothing at run time');
  });

  it.each(TAKEN)('takes what reads neither: $id', async (row) => {
    await expect(refused(row)).resolves.toBeUndefined();
  });
});

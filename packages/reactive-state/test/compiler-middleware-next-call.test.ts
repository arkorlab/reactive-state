import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readMiddleware } from '../src/compiler/middleware.ts';
import { Modules } from '../src/compiler/modules.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * A route middleware calls `next` once, at the top level of its body, as `const response = await
 * next();` or `return next();`: parentheses around the call or around the `await` do not change what
 * it is, and what binds no response — `const response = next();`, a `let` — is not the split.
 */

interface Row {
  readonly id: string;
  /** The statements of the middleware's body. */
  readonly body: string;
}

const HEADER = "  response.headers.set('x-a', 'a');\n  return response;";

/** The spellings of the one call of `next`: taken. */
const SPLIT: readonly Row[] = [
  { body: `  const response = await next();\n${HEADER}`, id: 'await-next' },
  { body: `  const response = (await next());\n${HEADER}`, id: 'parenthesized-await' },
  { body: `  const response = ((await next()));\n${HEADER}`, id: 'doubly-parenthesized-await' },
  { body: `  const response = await (next());\n${HEADER}`, id: 'await-of-a-parenthesized-call' },
  { body: `  const response = (await (next()));\n${HEADER}`, id: 'both-parenthesized' },
  {
    body: `  const response: Response = (await next());\n${HEADER}`,
    id: 'typed-and-parenthesized',
  },
  { body: '  return next();', id: 'return-next' },
  { body: '  return (next());', id: 'return-parenthesized-next' },
];

/** What binds no response, or no constant: refused. */
const REFUSED: readonly Row[] = [
  { body: `  const response = next();\n${HEADER}`, id: 'no-await' },
  { body: `  const response = (next());\n${HEADER}`, id: 'no-await-parenthesized' },
  { body: `  let response = (await next());\n${HEADER}`, id: 'let' },
  { body: `  const response = (await next()) as Response;\n${HEADER}`, id: 'cast' },
];

describe('the call of next of a route middleware', () => {
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-next-call-'));
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
      `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params }, next) => {\n${row.body}\n}) satisfies RouteMiddleware<{ projectId: string }>;\n`,
    );
    using modules = new Modules(api, src);
    try {
      readMiddleware({ file, id: 'boards/[projectId]', modules });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it.each(SPLIT)('splits at the call however it is parenthesized: $id', async (row) => {
    await expect(refused(row)).resolves.toBeUndefined();
  });

  it.each(REFUSED)('refuses what binds no awaited response: $id', async (row) => {
    await expect(refused(row)).resolves.toContain('`next` is called once');
  });
});

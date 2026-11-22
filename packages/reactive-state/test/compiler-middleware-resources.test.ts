import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readMiddleware } from '../src/compiler/middleware.ts';
import { Modules } from '../src/compiler/modules.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * A resource a route middleware declares with `using` or `await using` at the scope of its own body
 * is disposed as the middleware returns, after the route has run. The guard written for it returns
 * before the route starts, so a declaration before `next` is refused; one within a block that ends
 * before `next` is disposed there, where the source disposes it.
 */

const LEASE =
  'export function acquireLease(): { readonly id: number; [Symbol.dispose](): void } {\n  return { id: 1, [Symbol.dispose]() {} };\n}\nexport function check(lease: { readonly id: number }): void {\n  void lease;\n}\n';

const IMPORTS = "import { acquireLease, check } from '@/lib/lease';";

interface Row {
  readonly id: string;
  /** The statements of the middleware's body, around `next`. */
  readonly body: string;
}

/** A resource of the body's own scope before `next`: refused. */
const HELD: readonly Row[] = [
  {
    body: '  using lease = acquireLease();\n  return await next();',
    id: 'using-return-await-next',
  },
  {
    body: "  using lease = acquireLease();\n  const response = await next();\n  response.headers.set('x-lease', 'held');\n  return response;",
    id: 'using-then-response',
  },
  { body: '  await using lease = acquireLease();\n  return await next();', id: 'await-using' },
  {
    body: '  check(acquireLease());\n  using lease = acquireLease();\n  check(lease);\n  return await next();',
    id: 'using-after-another-statement',
  },
  {
    body: '  using first = acquireLease(), second = acquireLease();\n  return await next();',
    id: 'using-two-resources',
  },
];

/** What holds no resource across `next`, which is taken as before. */
const TAKEN: readonly Row[] = [
  {
    body: '  {\n    using lease = acquireLease();\n    check(lease);\n  }\n  return await next();',
    id: 'using-in-a-block-that-ends',
  },
  {
    body: '  {\n    await using lease = acquireLease();\n    check(lease);\n  }\n  return await next();',
    id: 'await-using-in-a-block-that-ends',
  },
  {
    body: '  if (acquireLease().id > 1) {\n    using lease = acquireLease();\n    check(lease);\n  }\n  return await next();',
    id: 'using-in-an-if',
  },
  {
    body: '  const lease = acquireLease();\n  check(lease);\n  return await next();',
    id: 'const-only',
  },
  { body: '  return await next();', id: 'no-resource' },
];

describe('a resource a route middleware holds across next', () => {
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-resources-'));
    roots.push(root);
    const src = path.join(root, 'src');
    const directory = path.join(src, 'app', 'boards', '[projectId]');
    await mkdir(directory, { recursive: true });
    await mkdir(path.join(src, 'lib'), { recursive: true });
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );
    await writeFile(path.join(src, 'lib', 'lease.ts'), LEASE);
    const file = path.join(directory, 'middleware.ts');
    await writeFile(
      file,
      `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\n${IMPORTS}\nexport default (async (_context, next) => {\n${row.body}\n}) satisfies RouteMiddleware<{ projectId: string }>;\n`,
    );
    using modules = new Modules(api, src);
    try {
      readMiddleware({ file, id: 'boards/[projectId]', modules });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it.each(HELD)('refuses a declaration of a resource before next: $id', async (row) => {
    await expect(refused(row)).resolves.toContain('holds a resource until the middleware returns');
  });

  it('refuses a resource declared after next, as before', async () => {
    const reason = await refused({
      body: '  const response = await next();\n  using lease = acquireLease();\n  check(lease);\n  return response;',
      id: 'using-after-next',
    });

    expect(reason).toContain('After `await next()`');
    expect(reason).not.toContain('holds a resource');
  });

  it.each(TAKEN)('takes what holds no resource across next: $id', async (row) => {
    await expect(refused(row)).resolves.toBeUndefined();
  });
});

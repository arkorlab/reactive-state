import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Statement } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readMiddleware } from '../src/compiler/middleware.ts';
import { Modules } from '../src/compiler/modules.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * A constant of a route middleware's params alone that nothing reads runs where the request is,
 * written into the host's part before `next` as it stands: the constants of the params it reads are
 * written there too, where the guard reads them as well. Written without them, it reads a name the
 * part does not bind, and throws for every request.
 */

interface Row {
  readonly id: string;
  /** The statements of the middleware's body, around `next`. */
  readonly body: string;
}

const GUARD = '  if (a === 1) return new Response(null, { status: 403 });\n  return next();';

/** An unread constant of one the guard reads: both parts hold the one it reads. */
const BOUND: readonly Row[] = [
  { body: `  const a = 1;\n  const b = a;\n${GUARD}`, id: 'one-constant' },
  { body: `  const a = 1;\n  const b = a;\n  const c = b + 1;\n${GUARD}`, id: 'a-chain-of-two' },
  { body: `  const a = 1;\n  const { b } = { b: a };\n${GUARD}`, id: 'destructured' },
  {
    body: `  const a = 1;\n  const b = a + params.projectId.length;\n${GUARD}`,
    id: 'reads-the-context-too',
  },
  { body: `  const a: number = 1;\n  const b: typeof a = a;\n${GUARD}`, id: 'reads-it-in-a-type' },
];

/** What an unread constant reads, which no part can compute twice alike: refused. */
const REFUSED: readonly Row[] = [
  {
    body: `  const a = params.projectId.toUpperCase();\n  const b = a;\n  if (a === 'P1') return new Response(null, { status: 403 });\n  return next();`,
    id: 'reads-a-call-the-guard-reads',
  },
];

/** What was taken and ran as written: no constant of the guard's an unread one reads. */
const ALONE: readonly Row[] = [
  {
    body: `  const b = 7;\n${GUARD.replace('a === 1', "params.projectId === 'z'")}`,
    id: 'a-literal',
  },
  {
    body: `  const id = params.projectId;\n  const label = 'x-' + id;\n  if (id === 'p1') return new Response('no', { status: 403 });\n  return next();`,
    id: 'reads-a-constant-the-guard-reads-too',
  },
  {
    body: `  const a = 1;\n  const b = a;\n  const response = await next();\n  response.headers.set('x-a', String(a));\n  return response;`,
    id: 'a-constant-only-the-host-reads',
  },
];

describe('a constant of a route middleware’s params that nothing reads', () => {
  let api: API;
  const roots: string[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await Promise.all(roots.map(async (root) => rm(root, { force: true, recursive: true })));
  });

  /** What each part holds of the middleware, by its statements' text, and what `readMiddleware` refuses. */
  async function split(row: Row): Promise<{
    readonly before: readonly string[];
    readonly guard: readonly string[];
    readonly refused: string | undefined;
  }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-unread-constants-'));
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
      const read = readMiddleware({ file, id: 'boards/[projectId]', modules });
      const { sourceFile } = read.names;
      const texts = (statements: readonly Statement[]): readonly string[] =>
        statements.map((statement) => statement.getText(sourceFile));
      return {
        before: texts(read.before?.statements ?? []),
        guard: texts(read.guard?.statements ?? []),
        refused: undefined,
      };
    } catch (error) {
      return {
        before: [],
        guard: [],
        refused: error instanceof Error ? error.message : String(error),
      };
    }
  }

  it.each(BOUND)('writes what an unread constant reads into the host’s part: $id', async (row) => {
    const found = await split(row);

    expect(found.refused).toBeUndefined();
    expect(found.before.some((text) => text.startsWith('const a'))).toBe(true);
    expect(found.guard.some((text) => text.startsWith('const a'))).toBe(true);
    expect(found.before.some((text) => /^const (?:\{ )?b\b/u.test(text))).toBe(true);
  });

  it.each(REFUSED)('refuses what both parts would compute of their own: $id', async (row) => {
    const found = await split(row);

    expect(found.refused).toContain('read by the guard');
  });

  it.each(ALONE)('keeps what an unread constant read before: $id', async (row) => {
    const found = await split(row);

    expect(found.refused).toBeUndefined();
  });
});

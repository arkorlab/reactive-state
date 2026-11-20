import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readMiddleware } from '../src/compiler/middleware.ts';
import { Modules } from '../src/compiler/modules.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * A name of a route middleware's context that the middleware assigns before `next` is assigned in
 * the guard, which the authority runs; the host binds it as the context gave it and hands that to
 * the part after `next`. A middleware that assigns a name and a part of the host reads it is
 * refused; a name the guard alone reads, a constant of its own and a name of no context are taken.
 */

interface Row {
  readonly id: string;
  /** The context parameter. */
  readonly context?: string;
  /** The statements of the middleware's body, around `next`. */
  readonly body: string;
}

const AFTER =
  "  const response = await next();\n  response.headers.set('x-id', projectId);\n  return response;";

/** A name the middleware assigns before `next` that the host reads: refused. */
const ASSIGNED: readonly Row[] = [
  { body: `  projectId = projectId.toLowerCase();\n${AFTER}`, id: 'assigned-read-after-next' },
  { body: `  projectId += '-x';\n${AFTER}`, id: 'compound-assignment' },
  { body: `  [projectId] = [projectId.toLowerCase()];\n${AFTER}`, id: 'array-pattern-assignment' },
  {
    body: `  ({ projectId } = { projectId: projectId.trim() });\n${AFTER}`,
    id: 'object-pattern-assignment',
  },
  {
    body: `  if (projectId.length > 3) projectId = projectId.slice(0, 3);\n${AFTER}`,
    id: 'assigned-in-a-branch',
  },
  {
    body: `  for (projectId of ['a']) {\n    void projectId;\n  }\n${AFTER}`,
    id: 'assigned-by-a-loop-head',
  },
  {
    body: `  projectId = projectId.trim();\n  const note = projectId + '!';\n  const response = await next();\n  response.headers.set('x-note', note);\n  return response;`,
    id: 'read-by-a-constant-the-host-reads',
  },
  {
    body: `  projectId = projectId.trim();\n  const agent = request.headers.get('user-agent') ?? projectId;\n  const response = await next();\n  response.headers.set('x-agent', agent);\n  return response;`,
    context: '{ params: { projectId }, request }',
    id: 'read-by-a-statement-of-the-host-before-next',
  },
];

/** What is no name of the context assigned and read by the host, which is taken as before. */
const TAKEN: readonly Row[] = [
  {
    body: `  projectId = projectId.trim();\n  if (projectId === '') return new Response('no', { status: 404 });\n  return next();`,
    id: 'assigned-and-read-by-the-guard-alone',
  },
  { body: AFTER, id: 'read-by-the-host-and-assigned-nowhere' },
  {
    body: `  const id = projectId.trim();\n  if (id === '') return new Response('no', { status: 404 });\n  const response = await next();\n  response.headers.set('x-id', projectId);\n  return response;`,
    id: 'a-constant-of-its-own-assigned-nowhere',
  },
  {
    body: `  let local = 'a';\n  local = 'b';\n  void local;\n${AFTER}`,
    id: 'a-name-that-is-no-name-of-the-context',
  },
];

describe('a name of the context that a route middleware assigns before next', () => {
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-reassigned-'));
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
      `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (${row.context ?? '{ params: { projectId } }'}, next) => {\n${row.body}\n}) satisfies RouteMiddleware<{ projectId: string }>;\n`,
    );
    using modules = new Modules(api, src);
    try {
      readMiddleware({ file, id: 'boards/[projectId]', modules });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it.each(ASSIGNED)('refuses a name assigned before next that the host reads: $id', async (row) => {
    await expect(refused(row)).resolves.toContain(
      "is a name of the route middleware's context, assigned before `next`",
    );
  });

  it.each(TAKEN)('takes what the host does not read of an assigned name: $id', async (row) => {
    await expect(refused(row)).resolves.toBeUndefined();
  });
});

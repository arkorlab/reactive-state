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

/**
 * A name the host assigns, in a constant only the host evaluates: the host's part binds the context's
 * names by a `const` where the middleware declares its type, and the guard binds its own.
 */
const HOST_ASSIGNED: readonly Row[] = [
  {
    body: `  const normalized = (projectId = projectId.trim());\n  const response = await next();\n  response.headers.set('x-norm', normalized);\n  return response;`,
    id: 'constant-of-the-host-read-after-next',
  },
  {
    body: `  const normalized = (projectId = projectId.trim());\n  const response = await next();\n  return response;`,
    id: 'constant-of-the-host-nobody-reads',
  },
  {
    body: `  const noise = (projectId += '-x');\n  const response = await next();\n  return response;`,
    id: 'compound-assignment-in-a-constant-nobody-reads',
  },
  {
    body: `  const [seen] = [(projectId = 'q')];\n  const response = await next();\n  response.headers.set('x-seen', seen);\n  return response;`,
    id: 'assignment-in-a-literal-of-a-constant',
  },
  {
    body: `  const seen = (projectId = request.headers.get('x-id') ?? 'none');\n  const response = await next();\n  return response;`,
    context: '{ params: { projectId }, request }',
    id: 'constant-of-the-request-nobody-reads',
  },
  {
    body: `  const normalized = (projectId = projectId.trim());\n  if (projectId === 'x') return new Response('no', { status: 403 });\n  const response = await next();\n  response.headers.set('x-norm', normalized);\n  return response;`,
    id: 'assigned-by-the-host-and-read-by-the-guard',
  },
];

/** A target of a pattern's assignment: the name it assigns, not a key, a computed key or a default. */
const TARGETS: readonly Row[] = [
  {
    body: `  ({ a: projectId } = { a: 'q' });\n${AFTER}`,
    id: 'value-side-of-a-property',
  },
  { body: `  [projectId = 'q'] = [];\n${AFTER}`, id: 'left-of-a-default-in-an-array' },
  { body: `  ({ a: projectId = 'q' } = {});\n${AFTER}`, id: 'left-of-a-default-in-an-object' },
  { body: `  ({ ...projectId } = { a: 'q' });\n${AFTER}`, id: 'rest-of-an-object' },
  { body: `  [...projectId] = ['q'];\n${AFTER}`, id: 'rest-of-an-array' },
  { body: `  [, projectId] = ['q', 'r'];\n${AFTER}`, id: 'element-after-a-hole' },
  { body: `  [[projectId]] = [['q']];\n${AFTER}`, id: 'nested-array' },
  { body: `  ({ a: { b: projectId } } = { a: { b: 'q' } });\n${AFTER}`, id: 'nested-object' },
  { body: `  [(projectId)] = ['q'];\n${AFTER}`, id: 'parenthesized-target' },
];

/** What a pattern's assignment only reads of a name of the context: a key, a computed key, a default. */
const ONLY_READ: readonly Row[] = [
  {
    body: `  let x = 'a';\n  ({ projectId: x } = { projectId: 'q' });\n  void x;\n${AFTER}`,
    id: 'key',
  },
  {
    body: `  let x = 'a';\n  ({ [projectId]: x } = { q: 'q' });\n  void x;\n${AFTER}`,
    id: 'computed-key',
  },
  {
    body: `  let x = 'a';\n  [x = projectId] = [];\n  void x;\n${AFTER}`,
    id: 'default-in-an-array',
  },
  {
    body: `  let x = 'a';\n  ({ a: x = projectId } = {});\n  void x;\n${AFTER}`,
    id: 'default-in-an-object',
  },
  {
    body: `  let x = 'a';\n  ({ x = projectId } = {});\n  void x;\n${AFTER}`,
    id: 'default-of-a-shorthand',
  },
  { body: `  let x = 'a';\n  [x] = [projectId];\n  void x;\n${AFTER}`, id: 'value-assigned' },
  {
    body: `  const holder = { projectId: 'a' };\n  holder.projectId = 'q';\n${AFTER}`,
    id: 'member-written',
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

/**
 * A name the middleware assigns after `next`, in a constant or an argument of a header's call: the host's
 * part there binds the names it reads by a `const`, which the assignment would throw at.
 */
const ASSIGNED_AFTER: readonly Row[] = [
  {
    body: "  const response = await next();\n  const normalized = (projectId = projectId.trim() + '!');\n  response.headers.set('x-id', normalized);\n  return response;",
    id: 'assigned-in-a-constant',
  },
  {
    body: "  const response = await next();\n  response.headers.set('x-id', (projectId = 'z'));\n  return response;",
    id: 'assigned-in-an-argument',
  },
  {
    body: "  const response = await next();\n  const n = (projectId += '-x');\n  response.headers.set('x-id', n);\n  return response;",
    id: 'compound-assignment',
  },
  {
    body: "  const response = await next();\n  const n = ([projectId] = ['z']);\n  response.headers.set('x-id', String(n));\n  return response;",
    id: 'array-pattern-assignment',
  },
  {
    body: "  const response = await next();\n  const f = () => (projectId = 'z');\n  response.headers.set('x-id', f());\n  return response;",
    id: 'assigned-in-a-function-of-a-constant',
  },
  {
    body: "  const response = await next();\n  const n = projectId === 'p1' ? (projectId = 'z') : 'k';\n  response.headers.set('x-id', n);\n  return response;",
    id: 'assigned-in-a-branch-of-a-constant',
  },
  {
    body: "  const response = await next();\n  const c = (params = { projectId: 'q' });\n  response.headers.set('x-id', c.projectId);\n  return response;",
    context: '{ params }',
    id: 'a-name-of-the-context-that-holds-the-params',
  },
];

/** What assigns no name of the context after `next`: taken. */
const READ_AFTER: readonly Row[] = [
  { body: AFTER, id: 'a-name-only-read' },
  {
    body: "  const response = await next();\n  const n = (params.projectId = 'z');\n  response.headers.set('x-id', n);\n  return response;",
    context: '{ params }',
    id: 'a-member-written',
  },
  {
    body: "  const response = await next();\n  const n = projectId + '!';\n  response.headers.set('x-id', n);\n  return response;",
    id: 'a-new-value-of-its-own',
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

  it.each(HOST_ASSIGNED)('refuses a name the host assigns before next: $id', async (row) => {
    await expect(refused(row)).resolves.toContain(
      "is a name of the route middleware's context, assigned before `next`",
    );
  });

  it.each(TARGETS)('refuses a name a pattern assigns through: $id', async (row) => {
    await expect(refused(row)).resolves.toContain(
      "is a name of the route middleware's context, assigned before `next`",
    );
  });

  it.each(ONLY_READ)('takes a name a pattern’s assignment only reads: $id', async (row) => {
    await expect(refused(row)).resolves.toBeUndefined();
  });

  it.each(TAKEN)('takes what the host does not read of an assigned name: $id', async (row) => {
    await expect(refused(row)).resolves.toBeUndefined();
  });

  it.each(ASSIGNED_AFTER)('refuses a name assigned after next: $id', async (row) => {
    await expect(refused(row)).resolves.toContain(
      "is a name of the route middleware's context, assigned after `next`",
    );
  });

  it.each(READ_AFTER)(
    'takes a name only read, or a value of its own, after next: $id',
    async (row) => {
      await expect(refused(row)).resolves.toBeUndefined();
    },
  );
});

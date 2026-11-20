import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Modules } from '../src/compiler/modules.ts';
import { scanRouting } from '../src/compiler/routes.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * What a route middleware's guard keeps between calls (`Facts.kept`), which makes the routes it
 * guards private: the guard's own statements, and the defaults and computed keys of the context's
 * pattern it binds, which run each time the guard does.
 */

/** A module holding one object, and no function that writes it. */
const COUNTER = 'export const counter = { value: 0 };\n';

/** A module whose function writes what the module holds each time it is called. */
const TICKET =
  'let issued = 0;\nexport function nextTicket(): string {\n  issued += 1;\n  return String(issued);\n}\n';

/** A module whose function reads its argument alone. */
const PURE = 'export const pure = (text: string): string => text + text;\n';

const DENY = "  if (ticket === '3') return new Response('full', { status: 403 });";

interface Row {
  readonly id: string;
  /** The middleware's context parameter. */
  readonly context: string;
  readonly body: string;
  readonly imports: string;
  readonly kept: string | undefined;
  readonly untracked: string | undefined;
}

const COUNTER_IMPORT = "import { counter } from '@/lib/counter';";

/** The defaults and computed keys of the context's pattern that write what a module holds. */
const WRITING: readonly Row[] = [
  {
    body: DENY,
    context: '{ params: { ticket = String(++counter.value) } }',
    id: 'default-increment',
    imports: COUNTER_IMPORT,
    kept: 'counter',
    untracked: undefined,
  },
  {
    body: DENY,
    context: '{ params: { ticket = (counter.value = 3, "3") } }',
    id: 'default-assignment',
    imports: COUNTER_IMPORT,
    kept: 'counter',
    untracked: undefined,
  },
  {
    body: DENY,
    context: '{ params: { [String(++counter.value)]: ticket = "0" } }',
    id: 'computed-key-write',
    imports: COUNTER_IMPORT,
    kept: 'counter',
    untracked: undefined,
  },
  {
    body: DENY,
    context: '{ params: { ticket = [1].map((value) => counter.value += value).join() } }',
    id: 'arrow-in-default',
    imports: COUNTER_IMPORT,
    kept: 'counter',
    untracked: undefined,
  },
];

/** What the guard reaches as before: a default that writes nothing, and what was refused already. */
const CONTROLS: readonly Row[] = [
  {
    body: DENY,
    context: '{ params: { ticket = "0" } }',
    id: 'literal-default',
    imports: '',
    kept: undefined,
    untracked: undefined,
  },
  {
    body: "  if (ticket === projectId) return new Response('same', { status: 403 });",
    context: '{ params: { ticket = "0", projectId } }',
    id: 'default-beside-a-param',
    imports: '',
    kept: undefined,
    untracked: undefined,
  },
  {
    body: DENY,
    context: '{ params: { ticket = pure("x") } }',
    id: 'pure-imported-call',
    imports: "import { pure } from '@/lib/pure';",
    kept: undefined,
    untracked: undefined,
  },
  {
    body: DENY,
    context: '{ params: { ticket = String(counter.value) } }',
    id: 'default-reads-an-import',
    imports: COUNTER_IMPORT,
    kept: undefined,
    untracked: undefined,
  },
  {
    body: `  counter.value += 1;\n  if (counter.value === 3) return new Response('full', { status: 403 });`,
    context: '{ params }',
    id: 'write-in-a-statement',
    imports: COUNTER_IMPORT,
    kept: 'counter',
    untracked: undefined,
  },
  {
    body: DENY,
    context: '{ params: { ticket = String(Date.now()) } }',
    id: 'default-reads-the-clock',
    imports: '',
    kept: undefined,
    untracked: 'Date',
  },
  {
    body: DENY,
    context: '{ params: { ticket = nextTicket() } }',
    id: 'imported-writer',
    imports: "import { nextTicket } from '@/lib/ticket';",
    kept: 'issued',
    untracked: undefined,
  },
];

function middlewareOf(row: Row): string {
  return `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
${row.imports}
export default (async (${row.context}, next) => {
${row.body}
  return next();
}) satisfies RouteMiddleware<{ projectId: string }>;
`;
}

describe('the facts of a route middleware guard', () => {
  let api: API;
  const roots: string[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await Promise.all(roots.map(async (root) => rm(root, { force: true, recursive: true })));
  });

  /** The guard of the one middleware an application holds, as `scanRouting` reads it. */
  async function guardOf(row: Row): Promise<{
    readonly refusals: readonly string[];
    readonly guard: boolean;
    readonly kept: string | undefined;
    readonly untracked: string | undefined;
  }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-guard-defaults-'));
    roots.push(root);
    const src = path.join(root, 'src');
    const directory = path.join(src, 'app', 'boards', '[projectId]');
    await mkdir(directory, { recursive: true });
    await mkdir(path.join(src, 'lib'), { recursive: true });
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );
    await writeFile(path.join(src, 'lib', 'counter.ts'), COUNTER);
    await writeFile(path.join(src, 'lib', 'ticket.ts'), TICKET);
    await writeFile(path.join(src, 'lib', 'pure.ts'), PURE);
    await writeFile(path.join(directory, 'middleware.ts'), middlewareOf(row));
    const refusals: string[] = [];
    using modules = new Modules(api, src);
    const routing = scanRouting({
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
    const [compiled] = routing.middleware;
    return {
      guard: compiled?.registration.guard === true,
      kept: compiled?.facts.kept,
      refusals,
      untracked: compiled?.facts.untracked,
    };
  }

  it.each(WRITING)(
    'keeps what a default or a computed key of the context writes: $id',
    async (row) => {
      const found = await guardOf(row);

      expect(found.refusals).toStrictEqual([]);
      expect(found.guard).toBe(true);
      expect(found.kept).toBe(row.kept);
      expect(found.untracked).toBe(row.untracked);
    },
  );

  it.each(CONTROLS)('answers as before: $id', async (row) => {
    const found = await guardOf(row);

    expect(found.refusals).toStrictEqual([]);
    expect(found.guard).toBe(true);
    expect(found.kept).toBe(row.kept);
    expect(found.untracked).toBe(row.untracked);
  });
});

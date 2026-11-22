import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Modules } from '../src/compiler/modules.ts';
import { Reach } from '../src/compiler/reach.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * What a page reaches as the server renders it, of a Client Component it renders: a module it loads
 * by a name the code computes, `import(name)`, is an input nothing tracks wherever it runs as the
 * server renders — but not in the code of the browser alone, an event's handler or an effect, which
 * the server's render does not run, and `firstIn` leaves out.
 */

interface Row {
  readonly id: string;
  /** The body of the Client Component, a function `Lab` of a prop `name`. */
  readonly body: string;
  readonly imports?: string;
}

const HEAD = "import { useEffect } from 'react';\n";

/** An import the browser alone runs: the server's render reads none. */
const BROWSER: readonly Row[] = [
  {
    body: 'return <button onClick={async () => { await import("./locales/" + name); }}>x</button>;',
    id: 'handler-of-a-button',
  },
  {
    body: 'return <button onClick={async () => { await import(name); }}>x</button>;',
    id: 'handler-of-a-button-by-a-name',
  },
  {
    body: 'useEffect(() => { void import(name); }, []);\n  return <p>x</p>;',
    id: 'callback-of-an-effect',
  },
  {
    body: 'const load = async () => import(name);\n  return <button onClick={load}>x</button>;',
    id: 'function-only-a-handler-reaches',
  },
];

/** An import the server's render runs, or that is no import by a name: read as before. */
const RENDERED: readonly Row[] = [
  { body: 'void import(name);\n  return <p>x</p>;', id: 'in-the-render' },
  {
    body: 'const load = () => import(name);\n  void load();\n  return <p>x</p>;',
    id: 'function-the-render-calls',
  },
  {
    body: 'return <Button onClick={async () => { await import(name); }}>x</Button>;',
    id: 'handler-of-a-component',
  },
  {
    body: 'void import(name);\n  return <button onClick={async () => { await import(name); }}>x</button>;',
    id: 'in-the-render-and-in-a-handler',
  },
];

const LITERAL: readonly Row[] = [
  {
    body: "return <button onClick={async () => { await import('./locales/en.json'); }}>x</button>;",
    id: 'literal-in-a-handler',
  },
  { body: 'return <p>x</p>;', id: 'no-import' },
];

describe('a Client Component’s import by a name the code computes', () => {
  let api: API;
  const roots: string[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await Promise.all(roots.map(async (root) => rm(root, { force: true, recursive: true })));
  });

  /** What the page of a Client Component reaches as the server renders it: an input nothing tracks. */
  async function untracked(row: Row): Promise<string | undefined> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-browser-imports-'));
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
    const page = path.join(root, 'page.tsx');
    await writeFile(
      page,
      'import Lab from \'./lab\';\nexport default function Page() {\n  return <Lab name="x" />;\n}\n',
    );
    await writeFile(
      path.join(root, 'lab.tsx'),
      `'use client';\n${HEAD}${row.imports ?? ''}\nconst Button = (props: { onClick: () => void; children: string }) => <button {...props} />;\nexport default function Lab({ name }: { name: string }) {\n  ${row.body}\n}\n`,
    );
    using modules = new Modules(api, root);
    return new Reach(modules, undefined).renderedFacts(page).untracked;
  }

  it.each(BROWSER)('leaves what the browser alone runs: $id', async (row) => {
    await expect(untracked(row)).resolves.toBeUndefined();
  });

  it.each(RENDERED)('reads what the server renders runs: $id', async (row) => {
    await expect(untracked(row)).resolves.toBe('import()');
  });

  it.each(LITERAL)('reads no import by a name where none is: $id', async (row) => {
    await expect(untracked(row)).resolves.toBeUndefined();
  });
});

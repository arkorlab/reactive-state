import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Modules } from '../src/compiler/modules.ts';
import { Reach } from '../src/compiler/reach.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * What a file reaches by a load at run time — `import('./x')`, `require('./x')` — written as a literal
 * (`loadsOf`): the module it names is walked as an import's is, and a reactive component it names is
 * one the file renders, as a route's guards are associated with it. A literal written past parentheses,
 * an `as`, `satisfies`, `!` or an assertion in angle brackets names the same module; one the code
 * computes names none, and a `require` of the file's own is no load of CommonJS's.
 */

interface Row {
  readonly id: string;
  /** The text of the module, with `ROOT` the specifier of the component. */
  readonly source: string;
}

const ROOT = '@/components/stats.reactive';

const loadOf = (load: string): string => `export const panel = ${load};\n`;

/** A load of the component, however the specifier is written around: the component is reached. */
const NAMED: readonly Row[] = [
  { id: 'import', source: loadOf(`import('${ROOT}')`) },
  { id: 'import-of-a-template', source: loadOf(`import(\`${ROOT}\`)`) },
  { id: 'import-in-parentheses', source: loadOf(`import(('${ROOT}'))`) },
  { id: 'import-in-two-parentheses', source: loadOf(`import((('${ROOT}')))`) },
  { id: 'import-cast', source: loadOf(`import('${ROOT}' as string)`) },
  { id: 'import-satisfies', source: loadOf(`import('${ROOT}' satisfies string)`) },
  { id: 'import-non-null', source: loadOf(`import('${ROOT}'!)`) },
  { id: 'import-angle-bracket', source: loadOf(`import(<string>'${ROOT}')`) },
  { id: 'import-angle-bracket-in-parentheses', source: loadOf(`import((<string>'${ROOT}'))`) },
  { id: 'import-template-cast', source: loadOf(`import(\`${ROOT}\` as string)`) },
  { id: 'require', source: loadOf(`require('${ROOT}')`) },
  { id: 'require-in-parentheses', source: loadOf(`require(('${ROOT}'))`) },
  { id: 'require-cast', source: loadOf(`require('${ROOT}' as string)`) },
  { id: 'require-angle-bracket', source: loadOf(`require(<string>'${ROOT}')`) },
];

/** A specifier the code computes, or a `require` that is not CommonJS's: no component is reached. */
const NONE: readonly Row[] = [
  { id: 'element-of-an-array', source: loadOf(`import([ '${ROOT}' ][0])`) },
  { id: 'concatenation', source: loadOf("import('@/components/' + 'stats.reactive')") },
  {
    id: 'angle-bracket-of-a-name',
    source: `export const panel = (name: string) => import(<string>name);\n`,
  },
  {
    id: 'a-require-of-its-own',
    source: `const require = (name: string): string => name;\nexport const panel = require(('${ROOT}'));\n`,
  },
  { id: 'no-load', source: 'export const panel = 1;\n' },
];

describe('the components a file reaches by a load at run time written as a literal', () => {
  let api: API;
  const roots: string[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await Promise.all(roots.map(async (root) => rm(root, { force: true, recursive: true })));
  });

  /** The ids of the reactive components `lib/panels.ts` renders, as the route check reads them. */
  async function reached(row: Row): Promise<readonly string[]> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-reach-wrapped-loads-'));
    roots.push(root);
    const src = path.join(root, 'src');
    await mkdir(path.join(src, 'lib'), { recursive: true });
    await mkdir(path.join(src, 'components'), { recursive: true });
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );
    await writeFile(
      path.join(src, 'components', 'stats.reactive.tsx'),
      'export default function Stats() {\n  return <p>stats</p>;\n}\n',
    );
    const panels = path.join(src, 'lib', 'panels.ts');
    await writeFile(panels, row.source);
    using modules = new Modules(api, src);
    return [...new Reach(modules, undefined).renderedComponents([panels], true)];
  }

  it.each(NAMED)('reaches the component it names: $id', async (row) => {
    await expect(reached(row)).resolves.toStrictEqual(['components/stats']);
  });

  it.each(NONE)('reaches no component: $id', async (row) => {
    await expect(reached(row)).resolves.toStrictEqual([]);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ModuleKind, Modules } from '../src/compiler/modules.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

interface Case {
  readonly expected: ModuleKind;
  readonly id: string;
  readonly source: string;
}

/**
 * A module the authority alone runs: it reads `server-only`, which no browser code may import.
 */
const SERVER =
  "import 'server-only';\nexport type T = { readonly a: number };\nexport const value = 1;\n";

/**
 * With `verbatimModuleSyntax`, `import { type T } from './server'` is written `import {} from
 * './server'` and the module runs (Node 26 runs it too), so only a declaration of `import type` or
 * `export type` is erased. A module that imports, or re-exports from, another through inline `type`
 * specifiers alone depends on it as it depends on any import.
 */
const CASES: readonly Case[] = [
  {
    expected: 'server',
    id: 'inline-type-specifier-alone-imports-server-module',
    source: "import { type T } from './server.ts';\nexport const x: T | undefined = undefined;\n",
  },
  {
    expected: 'server',
    id: 'two-inline-type-specifiers-import-server-module',
    source:
      "import { type T, type T as U } from './server.ts';\nexport const x: T | U | undefined = undefined;\n",
  },
  {
    expected: 'server',
    id: 'inline-type-specifier-reexport-from-server-module',
    source: "export { type T } from './server.ts';\n",
  },
  {
    expected: 'server',
    id: 'inline-type-specifier-beside-a-value-imports-server-module-pin',
    source: "import { type T, value } from './server.ts';\nexport const x: T | number = value;\n",
  },
  {
    expected: 'server',
    id: 'empty-named-imports-run-server-module-pin',
    source: "import {} from './server.ts';\nexport const x = 1;\n",
  },
  {
    expected: 'shared',
    id: 'import-type-declaration-is-erased-pin',
    source: "import type { T } from './server.ts';\nexport const x: T | undefined = undefined;\n",
  },
  {
    expected: 'shared',
    id: 'export-type-declaration-is-erased-pin',
    source: "export type { T } from './server.ts';\n",
  },
  {
    expected: 'shared',
    id: 'inline-type-specifier-from-shared-module-pin',
    source: "import { type S } from './other.ts';\nexport const x: S | undefined = undefined;\n",
  },
];

describe('modules a module imports through inline type specifiers alone', () => {
  let api: API;
  let directory: string;

  beforeAll(() => {
    api = openTypeScript();
    directory = mkdtempSync(path.join(os.tmpdir(), 'rs-inline-type-dependencies-'));
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'server.ts'), SERVER, 'utf8');
    writeFileSync(path.join(directory, 'other.ts'), 'export type S = number;\n', 'utf8');
    writeFileSync(
      path.join(directory, 'unsettled.ts'),
      'export const stamp = Math.random();\nexport type S = number;\n',
      'utf8',
    );
    writeFileSync(
      path.join(directory, 'reads-type-of-unsettled.ts'),
      "import { type S } from './unsettled.ts';\nexport const x: S | undefined = undefined;\n",
      'utf8',
    );
    writeFileSync(
      path.join(directory, 'reads-type-declaration-of-unsettled.ts'),
      "import type { S } from './unsettled.ts';\nexport const x: S | undefined = undefined;\n",
      'utf8',
    );
  });

  afterAll(() => {
    rmSync(directory, { force: true, recursive: true });
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ expected, id, source }) => {
    writeFileSync(path.join(directory, `${id}.ts`), source, 'utf8');
    using modules = new Modules(api, directory);

    expect(modules.kindOf(path.join(directory, `${id}.ts`))).toBe(expected);
  });

  it('inline-type-specifier-from-unsettled-module-is-unsettled', () => {
    using modules = new Modules(api, directory);

    expect(modules.unsettledOf(path.join(directory, 'reads-type-of-unsettled.ts'))).toMatch(
      /unsettled\.ts/u,
    );
  });

  it('import-type-declaration-of-unsettled-module-stays-settled-pin', () => {
    using modules = new Modules(api, directory);

    expect(
      modules.unsettledOf(path.join(directory, 'reads-type-declaration-of-unsettled.ts')),
    ).toBeUndefined();
  });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Modules } from '../src/compiler/modules.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * What a module of no directive is follows what it loads as it runs when the specifier is written as a
 * literal (`runtimeLoads`), as what it imports does: a module that loads one of the authority's is the
 * authority's, which a hook — the browser's — may not read, and what it loads is read, so that the
 * build's id holds it. A specifier written past parentheses, an `as`, `satisfies`, `!` or an assertion
 * in angle brackets names the same module; one the code computes names none.
 */

interface Row {
  readonly id: string;
  /** The load, as the module writes it, of `./secret`. */
  readonly load: string;
}

/** A load of `./secret`, however the specifier is written around: the module it names is read. */
const NAMED: readonly Row[] = [
  { id: 'import', load: "import('./secret')" },
  { id: 'import-of-a-template', load: 'import(`./secret`)' },
  { id: 'import-in-parentheses', load: "import(('./secret'))" },
  { id: 'import-in-two-parentheses', load: "import((('./secret')))" },
  { id: 'import-cast', load: "import('./secret' as string)" },
  { id: 'import-satisfies', load: "import('./secret' satisfies string)" },
  { id: 'import-non-null', load: "import('./secret'!)" },
  { id: 'import-angle-bracket', load: "import(<string>'./secret')" },
  { id: 'import-angle-bracket-in-parentheses', load: "import((<string>'./secret'))" },
  { id: 'import-two-assertions', load: "import(<string>('./secret' as string))" },
  { id: 'import-template-cast', load: 'import(`./secret` as string)' },
  { id: 'require', load: "require('./secret')" },
  { id: 'require-in-parentheses', load: "require(('./secret'))" },
  { id: 'require-cast', load: "require('./secret' as string)" },
  { id: 'require-angle-bracket', load: "require(<string>'./secret')" },
];

/** A specifier the code computes, or none: no module the compile can name. */
const COMPUTED: readonly Row[] = [
  { id: 'element-of-an-array', load: "import([ './secret' ][0])" },
  { id: 'concatenation', load: "import('./sec' + 'ret')" },
  { id: 'a-name', load: 'import(name)' },
  { id: 'a-template-with-a-substitution', load: ['import(`./$', '{name}`)'].join('') },
  { id: 'angle-bracket-of-a-name', load: 'import(<string>name)' },
  { id: 'no-argument', load: 'require()' },
];

/** A module of the authority's: it reads a built-in module of Node. */
const SECRET =
  "import { readFileSync } from 'node:fs';\nexport const secret = (): string => readFileSync('/', 'utf8');\n";

describe('the module a load at run time names, written as a literal', () => {
  let api: API;
  const roots: string[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await Promise.all(roots.map(async (root) => rm(root, { force: true, recursive: true })));
  });

  /** What `Modules` reads of `lib/loader.ts`, which loads `./secret` by `load`, and the files it read. */
  async function read(
    row: Row,
  ): Promise<{ readonly kind: string; readonly files: readonly string[] }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-wrapped-loads-'));
    roots.push(root);
    const src = path.join(root, 'src');
    await mkdir(path.join(src, 'lib'), { recursive: true });
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );
    await writeFile(path.join(src, 'lib', 'secret.ts'), SECRET);
    const loader = path.join(src, 'lib', 'loader.ts');
    await writeFile(loader, `export const load = (name: string) => ${row.load};\n`);
    using modules = new Modules(api, src);
    const kind = modules.kindOf(loader);
    return { files: [...modules.sources().keys()].map((file) => path.basename(file)), kind };
  }

  it.each(NAMED)('reads the module it names, and is the authority’s: $id', async (row) => {
    const found = await read(row);

    expect(found.kind).toBe('server');
    expect(found.files).toContain('secret.ts');
  });

  it.each(COMPUTED)('names no module of the application: $id', async (row) => {
    const found = await read(row);

    expect(found.kind).toBe('package');
    expect(found.files).not.toContain('secret.ts');
  });
});

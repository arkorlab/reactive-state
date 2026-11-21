import { afterEach, describe, expect, it } from 'vitest';

import { type Application, checkOf, cleanUp } from './support/shared-imports.ts';

/**
 * A module both parts of a split middleware load is evaluated once in the authority and once in
 * the host (`checkSharedImports`), whatever the parts name it by: a package's `exports` may give one
 * file two specifiers (`state-package`, `state-package/state`), and a built-in two (`process`,
 * `node:process`). The check keys a package's module by the files its specifier resolves to, and by
 * the specifier itself, so two spellings of one module are one.
 */

const STATE =
  'let count = 0;\nexport const bump = () => ++count;\nexport const current = () => count;\n';
const OTHER = 'export const current = () => 0;\n';
const REFUSED = 'is read by both the guard and the envelope';

/** The files of the package `state-package`, whose `package.json` is `manifest`. */
function pkg(
  manifest: Record<string, unknown>,
  others: Record<string, string> = {},
): Record<string, string> {
  return {
    'node_modules/state-package/index.mjs': STATE,
    'node_modules/state-package/package.json': JSON.stringify({
      name: 'state-package',
      type: 'module',
      version: '1.0.0',
      ...manifest,
    }),
    ...Object.fromEntries(
      Object.entries(others).map(([name, text]) => [`node_modules/state-package/${name}`, text]),
    ),
  };
}

/** A middleware whose guard reads `bump` of one specifier and whose envelope reads `current` of another. */
function direct(files: Record<string, string>, guard: string, envelope: string): Application {
  return {
    envelope: ['current'],
    files,
    guard: ['bump'],
    middleware: `import { bump } from '${guard}';\nimport { current } from '${envelope}';\nexport default {};\n`,
  };
}

/** A middleware whose parts read helpers that load `guarded` and `enveloped` as they run. */
function loaded(files: Record<string, string>, guarded: string, enveloped: string): Application {
  return {
    envelope: ['seen'],
    files: {
      ...files,
      'lib/a.ts': `export async function counted(): Promise<unknown> { return import('${guarded}'); }\n`,
      'lib/b.ts': `export async function seen(): Promise<unknown> { return import('${enveloped}'); }\n`,
    },
    guard: ['counted'],
    middleware:
      "import { counted } from '@/lib/a';\nimport { seen } from '@/lib/b';\nexport default {};\n",
  };
}

const TWO_SPELLINGS = { '.': './index.mjs', './state': './index.mjs' };

describe('the modules the parts of a split middleware name differently', () => {
  afterEach(cleanUp);

  it.each([
    {
      id: 'two subpaths of one file',
      application: direct(pkg({ exports: TWO_SPELLINGS }), 'state-package', 'state-package/state'),
    },
    {
      id: 'the subpath first and the package second',
      application: direct(pkg({ exports: TWO_SPELLINGS }), 'state-package/state', 'state-package'),
    },
    {
      id: 'a subpath with conditions and one without',
      application: direct(
        pkg({
          exports: {
            '.': { default: './index.mjs', import: './index.mjs' },
            './state': './index.mjs',
          },
        }),
        'state-package',
        'state-package/state',
      ),
    },
    {
      id: 'the package and a path to its file, with no `exports`',
      application: direct(pkg({ main: './index.mjs' }), 'state-package', 'state-package/index.mjs'),
    },
    {
      id: 'a package each helper loads under another subpath',
      application: loaded(pkg({ exports: TWO_SPELLINGS }), 'state-package', 'state-package/state'),
    },
    {
      id: 'a built-in each helper loads, spelled with `node:` and without',
      application: loaded({}, 'node:process', 'process'),
    },
  ])('refuses $id', ({ application }) => {
    expect(checkOf(application)).toContain(REFUSED);
  });

  it.each([
    {
      id: 'two subpaths of two files',
      application: direct(
        pkg({ exports: { '.': './index.mjs', './state': './other.mjs' } }, { 'other.mjs': OTHER }),
        'state-package',
        'state-package/state',
      ),
    },
    {
      id: 'the package and a path to another of its files',
      application: direct(
        pkg({ main: './index.mjs' }, { 'other.mjs': OTHER }),
        'state-package',
        'state-package/other.mjs',
      ),
    },
    {
      id: 'two built-ins each helper loads',
      application: loaded({}, 'node:process', 'node:crypto'),
    },
    {
      id: 'a package and a built-in each helper loads',
      application: loaded(pkg({ exports: TWO_SPELLINGS }), 'state-package', 'node:process'),
    },
  ])('takes $id', ({ application }) => {
    expect(checkOf(application)).toBe('taken');
  });
});

/**
 * A file the application's package names by a `#` import (`#helper`) and a module reaches by a path
 * (`./helper`, an alias of the `tsconfig.json`) is one module, whichever the walk meets first: it is
 * read once, and what it imports is reached whichever name reached it.
 */
const COUNTER =
  'let count = 0;\nexport function bump(): number { return ++count; }\nexport function current(): number { return count; }\n';

const ALIASED = {
  'lib/cyclic.ts':
    "import { bump } from './state';\nimport { viaMid } from '#mid';\nexport const viaCycle = (): number => bump() + viaMid();\n",
  'lib/dynamic.ts':
    "export async function viaDynamic(): Promise<unknown> { return import('#helper'); }\n",
  'lib/helper.ts':
    "import { bump } from './state';\nexport function viaHelper(): number { return bump(); }\n",
  'lib/mid-cyclic.ts':
    "import { viaCycle } from './cyclic';\nexport const viaMid = (): number => viaCycle();\n",
  'lib/mid.ts': "import { viaHelper } from './helper';\nexport const viaMid = viaHelper;\n",
  'lib/other.ts': 'export function other(): number { return 1; }\n',
  'lib/state.ts': COUNTER,
  'package.json': JSON.stringify({
    imports: {
      '#cyclic': './lib/cyclic.ts',
      '#helper': './lib/helper.ts',
      '#mid': './lib/mid-cyclic.ts',
      '#other': './lib/other.ts',
    },
    name: 'application',
  }),
};

const IMPORTS = {
  alias: "import { viaHelper as a } from '#helper';",
  cyclic: "import { viaCycle as k } from '#cyclic';",
  dynamic: "import { viaDynamic as d } from '@/lib/dynamic';",
  mid: "import { viaMid as b } from '@/lib/mid';",
  other: "import { other as o } from '#other';",
  paths: "import { viaHelper as c } from '@/lib/helper';",
  state: "import { current } from '@/lib/state';",
};

/** The middleware whose guard reads `reading` of `lines`, and whose envelope reads `current` of the state. */
function aliased(lines: readonly (keyof typeof IMPORTS)[], guard: readonly string[]): Application {
  return {
    envelope: ['current'],
    files: ALIASED,
    guard,
    middleware: `${lines.map((line) => IMPORTS[line]).join('\n')}\nexport default {};\n`,
  };
}

describe('a file named by a `#` import and by a path', () => {
  afterEach(cleanUp);

  it.each([
    {
      id: 'the `#` import first, a module that imports it by a path second',
      application: aliased(['alias', 'mid', 'state'], ['a', 'b']),
    },
    {
      id: 'a module that imports it by a path first, the `#` import second',
      application: aliased(['mid', 'alias', 'state'], ['b', 'a']),
    },
    {
      id: 'the `#` import first, an alias of the tsconfig second',
      application: aliased(['alias', 'paths', 'state'], ['a', 'c']),
    },
    {
      id: 'an alias of the tsconfig first, the `#` import second',
      application: aliased(['paths', 'alias', 'state'], ['c', 'a']),
    },
    {
      id: 'a load of the `#` import first, a module that imports it by a path second',
      application: aliased(['dynamic', 'mid', 'state'], ['d', 'b']),
    },
    { id: 'the `#` import alone', application: aliased(['alias', 'state'], ['a']) },
    {
      id: 'files that import each other by `#` imports and by paths',
      application: aliased(['cyclic', 'state'], ['k']),
    },
  ])('refuses $id, where the envelope reads what it imports', ({ application }) => {
    expect(checkOf(application)).toContain(REFUSED);
  });

  it.each([
    {
      id: 'the `#` import first, the envelope reading the file by a path',
      application: {
        envelope: ['c'],
        files: ALIASED,
        guard: ['a'],
        middleware: `${IMPORTS.alias}\n${IMPORTS.paths}\nexport default {};\n`,
      },
    },
    {
      id: 'the envelope reading the `#` import, the guard reading the file by a path',
      application: {
        envelope: ['a'],
        files: ALIASED,
        guard: ['c'],
        middleware: `${IMPORTS.alias}\n${IMPORTS.paths}\nexport default {};\n`,
      },
    },
  ])('refuses $id', ({ application }) => {
    expect(checkOf(application)).toContain(REFUSED);
  });

  it('takes a guard that reads no import of the middleware, whatever the envelope reads', () => {
    expect(checkOf(aliased(['alias', 'state'], []))).toBe('taken');
  });

  it.each([
    {
      id: 'the `#` import and another, the envelope reading the state',
      application: aliased(['other', 'state'], ['o']),
    },
    {
      id: 'a module that imports it by a path, with the state read by neither',
      application: {
        envelope: ['o'],
        files: ALIASED,
        guard: ['b'],
        middleware: `${IMPORTS.mid}\n${IMPORTS.other}\nexport default {};\n`,
      },
    },
  ])('takes $id', ({ application }) => {
    expect(checkOf(application)).toBe('taken');
  });
});

/**
 * A specifier may name more files than one — a package's `exports` names a file for each condition,
 * the ones Node reads and the ones a worker does — and two specifiers may name some of the same: each
 * is the module a part reaches, so a file one names that another has already named is one it reaches
 * still, and every file of it is recorded, not those that no other has named.
 */
/** `{ "node": node, "default": fallback }`, in that order, which is the order Node reads them in. */
function conditions(node: string, fallback: string): Record<string, string> {
  return Object.fromEntries([
    ['node', node],
    ['default', fallback],
  ]);
}

const MIXED = {
  exports: {
    '.': './common.mjs',
    './mixed': conditions('./common.mjs', './state.mjs'),
    './state': './state.mjs',
  },
};

/** The package whose root is `common.mjs` and whose state is `state.mjs`. */
function mixed(): Record<string, string> {
  return pkg(MIXED, { 'common.mjs': 'export const common = () => 1;\n', 'state.mjs': STATE });
}

/** The middleware whose guard reads `names` of the package's specifiers and whose envelope reads its state. */
function overlapping(guard: readonly string[]): Application {
  return {
    envelope: ['current'],
    files: mixed(),
    guard,
    middleware: [
      "import { common } from 'state-package';",
      "import { common as mixedCommon } from 'state-package/mixed';",
      "import { current } from 'state-package/state';",
      'export default {};',
      '',
    ].join('\n'),
  };
}

/** A local helper the `#` imports of the application name by one condition each, the state among them. */
function overlappingLocal(guard: readonly string[]): Application {
  return {
    envelope: ['current'],
    files: {
      'lib/common.ts': 'export const common = (): number => 1;\n',
      'lib/state.ts': COUNTER,
      'package.json': JSON.stringify({
        imports: {
          '#common': './lib/common.ts',
          '#mixed': conditions('./lib/common.ts', './lib/state.ts'),
        },
        name: 'application',
      }),
    },
    guard,
    middleware: [
      "import { common } from '#common';",
      "import { common as mixedCommon } from '#mixed';",
      "import { current } from '@/lib/state';",
      'export default {};',
      '',
    ].join('\n'),
  };
}

describe('specifiers that name some of the same files', () => {
  afterEach(cleanUp);

  it.each([
    {
      id: 'the package first and a subpath that names it and another file second',
      application: overlapping(['common', 'mixedCommon']),
    },
    {
      id: 'the subpath first and the package second',
      application: overlapping(['mixedCommon', 'common']),
    },
    { id: 'the subpath alone', application: overlapping(['mixedCommon']) },
    {
      id: 'local files of the application, the `#` import of one file first',
      application: overlappingLocal(['common', 'mixedCommon']),
    },
    {
      id: 'local files of the application, the `#` import of two files first',
      application: overlappingLocal(['mixedCommon', 'common']),
    },
  ])('refuses $id, where the envelope reads the state', ({ application }) => {
    expect(checkOf(application)).toContain(REFUSED);
  });

  it.each([
    { id: 'the package alone', application: overlapping(['common']) },
    { id: 'the local `#` import of one file alone', application: overlappingLocal(['common']) },
  ])('takes $id, where the envelope reads the state', ({ application }) => {
    expect(checkOf(application)).toBe('taken');
  });
});

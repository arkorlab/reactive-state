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

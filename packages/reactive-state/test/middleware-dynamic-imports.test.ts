import { afterEach, describe, expect, it } from 'vitest';

import { type Application, checkOf, cleanUp } from './support/shared-imports.ts';

/**
 * A module both parts of a split middleware load is evaluated once in the authority, for the
 * guard, and once in the host, for the envelope, so state it holds does not carry what the guard
 * changes into the envelope (`checkSharedImports`). A module a file loads as it runs —
 * `await import('./state')`, wherever it is written — is as much a module of the part that reaches
 * the file as one it imports at the top: the check reads it so, and a module loaded under a name
 * the file computes, which no walk can read, as the same module for any two parts that reach one.
 */

const STATE =
  'let count = 0;\nexport function bump(): number { return ++count; }\nexport function current(): number { return count; }\n';
const OTHER = 'export function other(): number { return 1; }\n';

/** A helper module that exports `name`, a function that loads `loaded` as it runs and calls `use` of it. */
function helper(name: string, loaded: string, use: string): string {
  return `export async function ${name}(): Promise<number> { const { ${use} } = await import(${loaded}); return ${use}(); }\n`;
}

const MIDDLEWARE = [
  "import { counted } from '@/lib/a';",
  "import { seen } from '@/lib/b';",
  'export default {};',
  '',
].join('\n');

/** The application: the middleware's guard reads `counted` of a helper, its envelope `seen` of another. */
function application(files: Record<string, string>): Application {
  return { envelope: ['seen'], files, guard: ['counted'], middleware: MIDDLEWARE };
}

const REFUSED = 'is read by both the guard and the envelope';

describe('the modules a split middleware loads as it runs', () => {
  afterEach(cleanUp);

  it.each([
    {
      id: 'a module each helper loads',
      files: {
        'lib/a.ts': helper('counted', "'./state'", 'bump'),
        'lib/b.ts': helper('seen', "'./state'", 'current'),
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a module the guard’s helper loads and the envelope’s imports',
      files: {
        'lib/a.ts': helper('counted', "'./state'", 'bump'),
        'lib/b.ts':
          "import { current } from './state';\nexport function seen(): number { return current(); }\n",
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a module named by a template with no substitution',
      files: {
        'lib/a.ts': helper('counted', '`./state`', 'bump'),
        'lib/b.ts': helper('seen', '`./state`', 'current'),
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a load written in a function of a function',
      files: {
        'lib/a.ts':
          "export function counted(): () => Promise<unknown> { return () => import('./state'); }\n",
        'lib/b.ts':
          "export function seen(): () => Promise<unknown> { return () => import('./state'); }\n",
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a package each helper loads',
      files: {
        'lib/a.ts': helper('counted', "'left-pad'", 'bump'),
        'lib/b.ts': helper('seen', "'left-pad'", 'current'),
      },
    },
    {
      id: 'a module loaded under a name each helper computes',
      files: {
        'lib/a.ts':
          "const name = './state';\nexport async function counted(): Promise<unknown> { return import(name); }\n",
        'lib/b.ts':
          "const name = './state';\nexport async function seen(): Promise<unknown> { return import(name); }\n",
        'lib/state.ts': STATE,
      },
    },
  ])('refuses $id', ({ files }) => {
    expect(checkOf(application(files))).toContain(REFUSED);
  });

  it.each([
    {
      id: 'a module only the guard’s helper loads',
      files: {
        'lib/a.ts': helper('counted', "'./state'", 'bump'),
        'lib/b.ts': 'export function seen(): number { return 1; }\n',
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a module only the envelope’s helper loads',
      files: {
        'lib/a.ts': 'export function counted(): number { return 1; }\n',
        'lib/b.ts': helper('seen', "'./state'", 'current'),
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'two helpers that load modules of their own',
      files: {
        'lib/a.ts': helper('counted', "'./state'", 'bump'),
        'lib/b.ts': helper('seen', "'./other'", 'other'),
        'lib/state.ts': STATE,
        'lib/other.ts': OTHER,
      },
    },
    {
      id: 'a module loaded under a name only the guard’s helper computes',
      files: {
        'lib/a.ts':
          "const name = './state';\nexport async function counted(): Promise<unknown> { return import(name); }\n",
        'lib/b.ts': 'export function seen(): number { return 1; }\n',
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a type that names a module, no load',
      files: {
        'lib/a.ts':
          "export type State = typeof import('./state');\nexport function counted(): number { return 1; }\n",
        'lib/b.ts':
          "export type State = typeof import('./state');\nexport function seen(): number { return 1; }\n",
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'helpers that load nothing',
      files: {
        'lib/a.ts': 'export function counted(): number { return 1; }\n',
        'lib/b.ts': 'export function seen(): number { return 1; }\n',
      },
    },
  ])('takes $id', ({ files }) => {
    expect(checkOf(application(files))).toBe('taken');
  });
});

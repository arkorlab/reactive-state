import { afterEach, describe, expect, it } from 'vitest';

import { type Application, checkOf, cleanUp } from './support/shared-imports.ts';

/**
 * A module a file loads as it runs with CommonJS's `require('./state')` is as much a module of the
 * part that reaches the file as one it imports at the top, or loads with `import('./state')`: both
 * parts of a split middleware that reach one are refused, as they are for a static import
 * (`checkSharedImports`). A module loaded under a name the file computes — `require(name)`,
 * `require(require.resolve('./state'))` — stands for one module the same wherever it is written.
 */

const STATE =
  'let count = 0;\nexport function bump(): number { return ++count; }\nexport function current(): number { return count; }\n';
const REFUSED = 'is read by both the guard and the envelope';

/** The helper `lib/<file>.ts`, which exports `name`, with `body` as the text of the file. */
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

/** A helper whose `name` loads `module` by `load` and calls `use` of it. */
function loading(name: string, load: string, use: string): string {
  return `export function ${name}(): number { return ${load}.${use}(); }\n`;
}

describe('the modules a split middleware loads with require', () => {
  afterEach(cleanUp);

  it.each([
    {
      id: 'a call at the top of each helper',
      files: {
        'lib/a.ts': `const state = require('./state');\n${loading('counted', 'state', 'bump')}`,
        'lib/b.ts': `const state = require('./state');\n${loading('seen', 'state', 'current')}`,
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a call in a function of each helper',
      files: {
        'lib/a.ts': loading('counted', "require('./state')", 'bump'),
        'lib/b.ts': loading('seen', "require('./state')", 'current'),
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a module the guard’s helper requires and the envelope’s imports',
      files: {
        'lib/a.ts': loading('counted', "require('./state')", 'bump'),
        'lib/b.ts':
          "import { current } from './state';\nexport function seen(): number { return current(); }\n",
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a module named by a template with no substitution',
      files: {
        'lib/a.ts': loading('counted', 'require(`./state`)', 'bump'),
        'lib/b.ts': loading('seen', 'require(`./state`)', 'current'),
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a module named by `module.require`',
      files: {
        'lib/a.ts': loading('counted', "module.require('./state')", 'bump'),
        'lib/b.ts': loading('seen', "module.require('./state')", 'current'),
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a package each helper requires',
      files: {
        'lib/a.ts': loading('counted', "require('left-pad')", 'bump'),
        'lib/b.ts': loading('seen', "require('left-pad')", 'current'),
      },
    },
    {
      id: 'a module required under a name each helper computes',
      files: {
        'lib/a.ts':
          "const name = String('./state');\nexport function counted(): number { return require(name).bump(); }\n",
        'lib/b.ts':
          "const name = String('./state');\nexport function seen(): number { return require(name).current(); }\n",
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a module required by the path `require.resolve` answers',
      files: {
        'lib/a.ts': loading('counted', "require(require.resolve('./state'))", 'bump'),
        'lib/b.ts': loading('seen', "require(require.resolve('./state'))", 'current'),
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a module each helper imports with `import state = require()`',
      files: {
        'lib/a.ts': `import state = require('./state');\n${loading('counted', 'state', 'bump')}`,
        'lib/b.ts': `import state = require('./state');\n${loading('seen', 'state', 'current')}`,
        'lib/state.ts': STATE,
      },
    },
  ])('refuses $id', ({ files }) => {
    expect(checkOf(application(files))).toContain(REFUSED);
  });

  it.each([
    {
      id: 'a module only the guard’s helper requires',
      files: {
        'lib/a.ts': loading('counted', "require('./state')", 'bump'),
        'lib/b.ts': 'export function seen(): number { return 1; }\n',
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'two helpers that require modules of their own',
      files: {
        'lib/a.ts': loading('counted', "require('./state')", 'bump'),
        'lib/b.ts': loading('seen', "require('./other')", 'current'),
        'lib/state.ts': STATE,
        'lib/other.ts': STATE,
      },
    },
    {
      id: 'a path that `require.resolve` answers and nothing is loaded by',
      files: {
        'lib/a.ts':
          "const path = require.resolve('./state');\nexport function counted(): number { return path.length; }\n",
        'lib/b.ts':
          "const path = require.resolve('./state');\nexport function seen(): number { return path.length; }\n",
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a module required under a name only the guard’s helper computes',
      files: {
        'lib/a.ts':
          "const name = String('./state');\nexport function counted(): number { return require(name).bump(); }\n",
        'lib/b.ts': 'export function seen(): number { return 1; }\n',
        'lib/state.ts': STATE,
      },
    },
    {
      id: 'a method named require of another object',
      files: {
        'lib/a.ts':
          "const registry = { require: (name: string) => name };\nexport function counted(): number { return registry.require('./state').length; }\n",
        'lib/b.ts':
          "const registry = { require: (name: string) => name };\nexport function seen(): number { return registry.require('./state').length; }\n",
        'lib/state.ts': STATE,
      },
    },
  ])('takes $id', ({ files }) => {
    expect(checkOf(application(files))).toBe('taken');
  });
});

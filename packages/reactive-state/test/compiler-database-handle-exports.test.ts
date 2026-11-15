import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type DatabaseExport,
  databaseNames,
  databaseUseIn,
} from '../src/compiler/database-handle.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATABASE: DatabaseExport = {
  file: '/app/src/db.ts',
  name: 'db',
};

const MODULES: Readonly<Record<string, string>> = {
  './other': '/app/src/other.ts',
  '@/db': '/app/src/db.ts',
};

/** Resolves test module specifiers to canonical file paths. */
function resolveModule(specifier: string): string | undefined {
  return MODULES[specifier];
}

interface Case {
  readonly expected: string | undefined;
  readonly fileName?: string;
  readonly id: string;
  readonly source: string;
}

/**
 * Re-export specifiers, namespace re-exports, local export aliases, type-only exports, and import
 * attributes do not read a local database binding, while local value exports and direct re-exports
 * from the database module still report a handle use.
 */
const CASES: readonly Case[] = [
  {
    expected: undefined,
    id: 'reexport-same-name-from-other-module',
    source: "import { db } from '@/db';\ntype Schema = typeof db;\nexport { db } from './other';",
  },
  {
    expected: undefined,
    id: 'reexport-renamed-to-handle-from-other-module',
    source:
      "import { db } from '@/db';\ntype Schema = typeof db;\nexport { other as db } from './other';",
  },
  {
    expected: undefined,
    id: 'reexport-handle-name-as-alias-from-other-module',
    source:
      "import { db } from '@/db';\ntype Schema = typeof db;\nexport { db as other } from './other';",
  },
  {
    expected: undefined,
    id: 'reexport-unrelated-database-export-as-handle',
    source:
      "import { db } from '@/db';\ntype Schema = typeof db;\nexport { LABEL as db } from '@/db';",
  },
  {
    expected: undefined,
    id: 'reexport-namespace-as-handle-from-other-module',
    source: "import { db } from '@/db';\ntype Schema = typeof db;\nexport * as db from './other';",
  },
  {
    expected: undefined,
    id: 'local-export-unrelated-value-aliased-to-handle',
    source:
      "import { db } from '@/db';\ntype Schema = typeof db;\nconst label = 'board';\nexport { label as db };",
  },
  {
    expected: undefined,
    id: 'local-export-unrelated-value-aliased-to-namespace',
    source:
      "import * as store from '@/db';\nexport const label = store.LABEL;\nexport { label as store };",
  },
  {
    expected: undefined,
    id: 'local-type-only-export-declaration-of-handle',
    source: "import { db } from '@/db';\nexport type { db };",
  },
  {
    expected: undefined,
    id: 'local-inline-type-export-specifier-of-handle',
    source: "import { db } from '@/db';\nexport { type db as DatabaseHandle };",
  },
  {
    expected: undefined,
    id: 'import-attribute-key-matching-handle-name',
    source:
      "import { db } from '@/db';\nimport data from './other' with { db: 'json' };\ntype Schema = typeof db;\nexport const loaded = data;",
  },
  {
    expected: undefined,
    fileName: '/app/src/db.ts',
    id: 'own-module-type-export-does-not-bind-handle',
    source:
      'const Schema = { items: [] as string[] };\nexport const db = {};\nexport type { Schema as db };\nexport const count = Schema.items.length;',
  },
  {
    expected: 'db',
    id: 'local-value-export-of-handle-pin',
    source: "import { db } from '@/db';\nexport { db };",
  },
  {
    expected: 'db',
    id: 'local-aliased-value-export-of-handle-pin',
    source: "import { db } from '@/db';\nexport { db as publicDb };",
  },
  {
    expected: 'database',
    id: 'local-aliased-import-value-export-pin',
    source: "import { db as database } from '@/db';\nexport { database as publicDb };",
  },
  {
    expected: 'db',
    id: 'local-value-export-of-database-namespace-pin',
    source: "import * as store from '@/db';\nexport { store as databaseModule };",
  },
  {
    expected: 'db',
    id: 'direct-reexport-from-database-module-pin',
    source: "export { db as publicDb } from '@/db';",
  },
  {
    expected: 'db',
    id: 'namespace-reexport-from-database-module-pin',
    source: "export * as store from '@/db';",
  },
  {
    expected: undefined,
    fileName: '/app/src/db.ts',
    id: 'own-module-value-export-of-handle-pin',
    source: 'const handle = {};\nexport { handle as db };',
  },
];

describe('database handle use across export and re-export forms', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `databaseUseIn` with the handles `databaseNames` binds in `source`. */
  function useIn(source: string, fileName = '/app/src/module.ts'): string | undefined {
    using parsed = parseModule(api, fileName, source);
    const handles = databaseNames(parsed.sourceFile, DATABASE, resolveModule);
    return databaseUseIn(parsed.sourceFile, {
      database: DATABASE,
      handles,
      resolve: resolveModule,
    });
  }

  it.each(CASES)('$id', ({ expected, fileName, source }) => {
    expect(useIn(source, fileName)).toBe(expected);
  });
});

import {
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isVariableStatement,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AppInput, type CompiledComponent, emitRegistry } from '../src/compiler/emit-app.ts';
import type { OperationModule } from '../src/compiler/operations.ts';
import { NO_ROUTING, type Routing } from '../src/compiler/routes.ts';
import { bindingIdentifiers } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The authority's registry imports the application's database and exports its own names — `buildId`,
 * `programs`, `operations`, `database`, `routes`, `middleware`, and `sessions` where the host has a
 * session: a database the application exports under one of them is imported under a name of its own,
 * where the registry would otherwise declare the name twice and not load. So is one exported under a name
 * with a `$` in it: every name the registry generates — `program$…`, `operations$…`, `guard$…`,
 * `database$` — has one.
 */

/** The names the application may export its database as: ordinary ones, and each the registry takes. */
const TAKEN: readonly string[] = [
  'buildId',
  'database',
  'middleware',
  'operations',
  'programs',
  'routes',
  'sessions',
  'MiddlewareProgram',
  'RouteRegistration',
];

const ORDINARY: readonly string[] = ['db', 'store', 'appDatabase', 'sessionDatabase', 'program'];

/** The names the registry generates for the richest input: each one the database may be exported as. */
const GENERATED: readonly string[] = [
  'program$stats',
  'program$a_b',
  'program$a_b$2',
  'operations$stats',
  'guard$boards',
];

/** Names of that shape the registry generates none of: imported under a name of their own all the same. */
const SHAPED: readonly string[] = ['database$', 'a$b'];

/**
 * Components of the ids `stats`, `a_b` and `a-b` (which share a name), an operation module of the id
 * `stats` and a guard at `boards`: what the registry generates its names of.
 */
function richInputOf(name: string): AppInput {
  const components = ['stats', 'a_b', 'a-b'].map(
    (id) => ({ component: { id } }) as unknown as CompiledComponent,
  );
  const operation: OperationModule = {
    exports: ['go'],
    fileName: 'stats.ts',
    id: 'stats',
    written: "'./stats.ts'",
  };
  const routing = {
    middleware: [{ path: 'middleware/boards', registration: { guard: true, id: 'boards' } }],
    plain: [],
    roots: new Map(),
    routes: [],
  } as unknown as Routing;
  return { ...inputOf(name), components, operations: [operation], routing };
}

function inputOf(name: string): AppInput {
  return {
    buildId: 'b',
    classes: new Map(),
    components: [],
    database: { name, specifier: '@/db' },
    hooks: [],
    host: { session: { name: 'session', specifier: '@/session' } },
    operations: [],
    routing: NO_ROUTING,
  };
}

describe('the database the authority’s registry imports', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Every name the registry binds at its top level, once for each time it binds it. */
  function bound(text: string): readonly string[] {
    using file = parseModule(api, 'authority.mts', text);
    return file.sourceFile.statements.flatMap((statement) => {
      if (isVariableStatement(statement)) {
        return statement.declarationList.declarations.flatMap((declaration) =>
          bindingIdentifiers(declaration.name).map((each) => each.text),
        );
      }
      if (!isImportDeclaration(statement)) {
        return [];
      }
      const clause = statement.importClause;
      const named = clause?.namedBindings;
      const defaulted = clause?.name === undefined ? [] : [clause.name.text];
      if (named !== undefined && isNamespaceImport(named)) {
        return [...defaulted, named.name.text];
      }
      return [
        ...defaulted,
        ...(named !== undefined && isNamedImports(named)
          ? named.elements.map((each) => each.name.text)
          : []),
      ];
    });
  }

  it.each(TAKEN)('imports a database exported as %s under a name of its own', (name) => {
    const text = emitRegistry(inputOf(name));
    const names = bound(text);

    expect(names.filter((each, index) => names.indexOf(each) !== index)).toStrictEqual([]);
    expect(text).toContain(`import { ${name} as database$ } from '@/db';`);
    expect(text).toContain('export const database = database$;');
  });

  it.each([...GENERATED, ...SHAPED])(
    'imports a database exported as %s under a name of its own',
    (name) => {
      const text = emitRegistry(richInputOf(name));
      const names = bound(text);

      expect(names.filter((each, index) => names.indexOf(each) !== index)).toStrictEqual([]);
      expect(text).toContain(`import { ${name} as database$ } from '@/db';`);
    },
  );

  it('writes no generated name of a shape the rule does not alias the database for', () => {
    const names = bound(emitRegistry(richInputOf('db')));
    const own = new Set([...TAKEN, 'db']);

    for (const generated of GENERATED) {
      expect(names).toContain(generated);
    }

    expect(names).toContain('database');
    expect(names).toContain('db');
    expect(names.filter((each) => !own.has(each) && !each.includes('$'))).toStrictEqual([]);
  });

  it.each(ORDINARY)('imports a database exported as %s by that name, as it did', (name) => {
    const text = emitRegistry(inputOf(name));

    expect(text).toContain(`import { ${name} } from '@/db';`);
    expect(text).toContain(`export const database = ${name};`);
  });

  it('imports a default export of the database as it did', () => {
    const text = emitRegistry(inputOf('default'));

    expect(text).toContain("import database$ from '@/db';");
    expect(text).toContain('export const database = database$;');
  });
});

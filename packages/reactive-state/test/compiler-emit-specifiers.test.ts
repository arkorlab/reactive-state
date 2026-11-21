import { isImportDeclaration, isStringLiteral } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type AppInput,
  type CompiledComponent,
  emitElements,
  emitRegistry,
  relativeSpecifier,
} from '../src/compiler/emit-app.ts';
import type { OperationModule } from '../src/compiler/operations.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The specifiers the generated modules import each other by are written from the paths of the
 * application's files: a name in a path with an apostrophe in it is escaped, not left to end the
 * literal, so the module parses and imports the file its path names. The spelling of any other path
 * is the one the application writes imports in, single quotes.
 */

/** A path that asks for no escape, and the names that do. */
const IDS: readonly { readonly id: string; readonly quoted: string }[] = [
  { id: 'components/stats', quoted: "'" },
  { id: "components/it's/stats", quoted: '"' },
  { id: "components/rock'n'roll", quoted: '"' },
  { id: String.raw`components/back\slash`, quoted: '"' },
];

/** A component as far as the registry and the elements read it: its id, and whether it has a client part. */
function componentOf(id: string): CompiledComponent {
  return {
    component: { id, returned: {} },
    sides: { refs: { modules: new Map() } },
  } as unknown as CompiledComponent;
}

function operationOf(id: string): OperationModule {
  return { exports: ['go'], fileName: `${id}.ts`, id, written: `'./${id}.ts'` };
}

function inputOf(id: string): AppInput {
  return {
    buildId: 'b',
    classes: new Map(),
    components: [componentOf(id)],
    database: { name: 'db', specifier: '@/db' },
    hooks: [],
    operations: [operationOf(id)],
  };
}

describe('the specifiers of the generated modules', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The specifier of each import declaration of `text`. */
  function specifiersOf(text: string): readonly string[] {
    using file = parseModule(api, 'generated.ts', text);
    return file.sourceFile.statements.flatMap((statement) => {
      return isImportDeclaration(statement) && isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : [];
    });
  }

  it.each(IDS)('writes an import of a relative path: $id', ({ id, quoted }) => {
    const specifier = relativeSpecifier('/out/a/b.ts', `/out/${id}`);

    expect(specifier.startsWith(quoted)).toBe(true);
    expect(specifiersOf(`import x from ${specifier};`)).toStrictEqual([`../${id}`]);
  });

  it.each(IDS)('writes the import of a program in the registry: $id', ({ id }) => {
    const specifiers = specifiersOf(emitRegistry(inputOf(id)));

    expect(specifiers).toContain(`./${id}.authority.mts`);
  });

  it.each(IDS)('writes the imports of a client part and a stub in the elements: $id', ({ id }) => {
    const specifiers = specifiersOf(emitElements(inputOf(id)));

    expect(specifiers).toContain(`./${id}.client`);
    expect(specifiers).toContain(`./${id}`);
  });

  it('keeps the spelling of a path that asks for no escape', () => {
    expect(relativeSpecifier('/out/a/b.ts', '/out/elements')).toBe("'../elements'");
    expect(emitRegistry(inputOf('components/stats'))).toContain(
      "from './components/stats.authority.mts';",
    );
    expect(emitElements(inputOf('components/stats'))).toContain(
      "from './components/stats.client';",
    );
  });
});

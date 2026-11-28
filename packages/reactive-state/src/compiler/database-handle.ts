import path from 'node:path';

import {
  type ElementAccessExpression,
  type ExportSpecifier,
  type Identifier,
  type ImportDeclaration,
  isCallExpression,
  isElementAccessExpression,
  isExportAssignment,
  isExportDeclaration,
  isExportSpecifier,
  isIdentifier,
  isImportAttribute,
  isImportClause,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isNamedExports,
  isNamespaceExport,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableStatement,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { bindingIdentifiers, freeReads } from './scope.ts';
import { isConstant } from './statements.ts';

/**
 * The application's database, as a route's judgement reads the code that writes through it: a
 * write through a table of it — `db.todos.delete(id)` — is a commit the authority tracks, which
 * makes the views that read the table anew, and no state a module keeps between calls (`reach.ts`).
 * The handle is known by its module and its export: the module's own declaration of it, an import
 * of it by any name, and a `const` of either, which nothing assigns anew; a module that exports it
 * again is none of it. And what Next.js renders may use it nowhere (`databaseUseIn`): only the
 * authority's evaluation answers it, so any read of it there — by those names, by its module read
 * whole, or exported again or loaded — is taken for a call of it.
 */

/**
 * The application's database, as the compile names it (`<specifier>#<export>`): the module it is
 * exported of, and the export.
 */
export interface DatabaseExport {
  /** The module's file, resolved as the authority's registry imports it. */
  readonly file: string;
  /** The name it is exported by: `db` of `@/db#db`. */
  readonly name: string;
}

/** How the names a file holds the database by are read of each of its statements. */
interface Reading {
  readonly database: DatabaseExport;
  /** Whether the file is the database's own module. */
  readonly own: boolean;
  /** The file a specifier of the file's names, as the compile resolves the file's imports. */
  readonly resolve: (specifier: string) => string | undefined;
}

/**
 * The names `statement`, an import of values, binds `exported` to: `db`, and `database` of
 * `{ db as database }`.
 */
function importedAs(statement: ImportDeclaration, exported: string): readonly string[] {
  const clause = statement.importClause;
  if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) {
    return [];
  }
  const named = clause.namedBindings;
  const own = exported === 'default' && clause.name !== undefined ? [clause.name.text] : [];
  if (named === undefined || isNamespaceImport(named)) {
    return own;
  }
  const bound = named.elements.filter(
    (each) => !each.isTypeOnly && (each.propertyName ?? each.name).text === exported,
  );
  return [...own, ...bound.map((each) => each.name.text)];
}

/**
 * The name `statement`, of the database's own module, declares the export `exported` by: `db` of
 * `export const db = …` and of `export const { db } = …`, `handle` of `export { handle as db }`, `db`
 * of `export default db`.
 */
function ownName(statement: Statement, exported: string): readonly string[] {
  if (isVariableStatement(statement)) {
    const exportedHere =
      statement.modifiers?.some((each) => each.kind === SyntaxKind.ExportKeyword) === true;
    const declared = statement.declarationList.declarations.flatMap((each) =>
      bindingIdentifiers(each.name),
    );
    return exportedHere && declared.some((name) => name.text === exported) ? [exported] : [];
  }
  if (isExportAssignment(statement)) {
    const value = unwrapped(statement.expression);
    return exported === 'default' && !statement.isExportEquals && isIdentifier(value)
      ? [value.text]
      : [];
  }
  const clause =
    isExportDeclaration(statement) &&
    !statement.isTypeOnly &&
    statement.moduleSpecifier === undefined
      ? statement.exportClause
      : undefined;
  return clause !== undefined && isNamedExports(clause)
    ? clause.elements
        .filter((each) => !each.isTypeOnly && each.name.text === exported)
        .map((each) => (each.propertyName ?? each.name).text)
    : [];
}

/**
 * The names `statement` binds the database to: an import of it, or, in the database's own module,
 * its declaration.
 */
function boundIn(statement: Statement, reading: Reading): readonly string[] {
  const { database } = reading;
  if (
    isImportDeclaration(statement) &&
    isStringLiteral(statement.moduleSpecifier) &&
    reading.resolve(statement.moduleSpecifier.text) === database.file
  ) {
    return importedAs(statement, database.name);
  }
  return reading.own ? ownName(statement, database.name) : [];
}

/**
 * Adds to `names` each `const` of `sourceFile`'s top level that holds one of them, as written or
 * wrapped — `(db)`, `db as Database`, `db satisfies Database` — in turn: what no write assigns
 * anew, as one could a `let`'s.
 */
function addConstants(sourceFile: SourceFile, names: Set<string>): void {
  const constants = sourceFile.statements.flatMap((statement) => {
    return isVariableStatement(statement) && isConstant(statement, sourceFile)
      ? statement.declarationList.declarations
      : [];
  });
  for (let grown = true; grown;) {
    grown = false;
    for (const { initializer, name } of constants) {
      const held = initializer === undefined ? undefined : unwrapped(initializer);
      if (
        held !== undefined &&
        isIdentifier(name) &&
        !names.has(name.text) &&
        isIdentifier(held) &&
        names.has(held.text)
      ) {
        names.add(name.text);
        grown = true;
      }
    }
  }
}

/**
 * The names `sourceFile` holds the application's database by: its declaration's, where the file is
 * its module; each an import of it binds, under any name, of a specifier `resolve` resolves to its
 * module, as the compile resolves the file's imports; and a `const` of one, in turn.
 */
export function databaseNames(
  sourceFile: SourceFile,
  database: DatabaseExport,
  resolve: (specifier: string) => string | undefined,
): ReadonlySet<string> {
  const reading: Reading = {
    database,
    own: path.resolve(sourceFile.fileName) === path.resolve(database.file),
    resolve,
  };
  const names = new Set(sourceFile.statements.flatMap((statement) => boundIn(statement, reading)));
  addConstants(sourceFile, names);
  return names;
}

/** Whether `node` reads a member by its name, or by text in brackets: `db.todos`, `db['todos']`. */
function isMember(node: Node): node is ElementAccessExpression | PropertyAccessExpression {
  return (
    isPropertyAccessExpression(node) ||
    (isElementAccessExpression(node) && literalName(node) !== undefined)
  );
}

/**
 * Whether `node` calls a method of a table of what `root` names — `db.todos.delete(id)`,
 * `db['todos'].delete(id)` — writing through it, not into it: an assignment to a member of it, or
 * a `delete` of one, writes the handle itself.
 */
export function callsTable(node: Node, root: Identifier): boolean {
  if (!isCallExpression(node)) {
    return false;
  }
  const method = unwrapped(node.expression);
  const table = isMember(method) ? unwrapped(method.expression) : undefined;
  return table !== undefined && isMember(table) && unwrapped(table.expression) === root;
}

/** What a file's use of the application's database is read with. */
export interface Holding {
  readonly database: DatabaseExport;
  /** The names the file holds the handle by (`databaseNames`). */
  readonly handles: ReadonlySet<string>;
  /** The file a specifier of the file's names, as the compile resolves the file's imports. */
  readonly resolve: (specifier: string) => string | undefined;
}

/** Whether `specifier`, written as it is, names the database's module, as `holding` resolves it. */
function namesModule(specifier: Node | undefined, holding: Holding): boolean {
  return (
    specifier !== undefined &&
    (isStringLiteral(specifier) || isNoSubstitutionTemplateLiteral(specifier)) &&
    holding.resolve(specifier.text) === holding.database.file
  );
}

/**
 * The names `sourceFile` imports the database's module by whole: `store` of `import * as store
 * from '@/db'`, whose member of the database's export is the handle.
 */
function namespacesOf(sourceFile: SourceFile, holding: Holding): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    const clause =
      isImportDeclaration(statement) && namesModule(statement.moduleSpecifier, holding)
        ? statement.importClause
        : undefined;
    const named =
      clause?.phaseModifier === SyntaxKind.TypeKeyword ? undefined : clause?.namedBindings;
    if (named !== undefined && isNamespaceImport(named)) {
      names.add(named.name.text);
    }
  }
  return names;
}

/**
 * The members read past `node`, by a name or by text in brackets, past what wraps it alike
 * (`useOf`): `todos` and `findMany` of `db` in `db.todos.findMany(query)`.
 */
function membersPast(node: Node): readonly string[] {
  const names: string[] = [];
  let { at, parent } = useOf(node);
  while (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === at
  ) {
    const name = isPropertyAccessExpression(parent) ? parent.name.text : literalName(parent);
    if (name === undefined) {
      break;
    }
    names.push(name);
    ({ at, parent } = useOf(parent));
  }
  return names;
}

/**
 * Whether `read`, within `specifier`, names an exported alias, a re-export's binding, or a type
 * alone — not a value of `sourceFile`'s own that `specifier` reads (`export { db }`, `export { db
 * as store }`).
 */
function isListedExport(read: Identifier, specifier: ExportSpecifier): boolean {
  const declaration = specifier.parent.parent;
  return (
    specifier.isTypeOnly ||
    !isExportDeclaration(declaration) ||
    declaration.isTypeOnly ||
    declaration.moduleSpecifier !== undefined ||
    (specifier.propertyName ?? specifier.name) !== read
  );
}

/** Whether `read` names what an import or an export lists, not a value it reads. */
function isListed(read: Identifier): boolean {
  const { parent } = read;
  if (isExportSpecifier(parent)) {
    return isListedExport(read, parent);
  }
  return (
    isImportSpecifier(parent) ||
    isImportClause(parent) ||
    isNamespaceImport(parent) ||
    isNamespaceExport(parent) ||
    isImportAttribute(parent) ||
    isImportEqualsDeclaration(parent)
  );
}

/**
 * Whether `read`, in the database's own module, is the module's export of it: `export { db }`,
 * `export default db` — no use of it.
 */
function isOwnExport(read: Identifier): boolean {
  const { parent } = useOf(read);
  return isExportSpecifier(read.parent) || isExportAssignment(parent);
}

/**
 * The use `read`, a read of a name `sourceFile` holds the database or its module by, makes of it,
 * as the code writes it: the handle and the members read of it — `db.todos.findMany` of a call,
 * `db.todos` of a table held by another name, `db` of the handle handed on — and of the module, the
 * member of the database's export, `db.todos` of `store.db.todos`; none of another member of the
 * module, `store.schema`.
 */
function useAt(
  read: Identifier,
  holding: Holding,
  namespaces: ReadonlySet<string>,
): string | undefined {
  const members = membersPast(read);
  if (holding.handles.has(read.text)) {
    return [read.text, ...members].join('.');
  }
  if (!namespaces.has(read.text)) {
    return undefined;
  }
  const [exported, ...past] = members;
  return exported === undefined || exported === holding.database.name
    ? [holding.database.name, ...past].join('.')
    : undefined;
}

/**
 * Whether `sourceFile` exports the database's module again, or its handle — `export * from '@/db'`,
 * `export { db } from '@/db'` — or loads the module as it runs, `import('@/db')`: what hands the
 * handle to code that reads it by a name no file of the application's imports it by.
 */
function handsModuleOn(sourceFile: SourceFile, holding: Holding): boolean {
  const reexports = sourceFile.statements.some((statement) => {
    if (
      !isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !namesModule(statement.moduleSpecifier, holding)
    ) {
      return false;
    }
    const clause = statement.exportClause;
    return (
      clause === undefined ||
      !isNamedExports(clause) ||
      clause.elements.some(
        (each) =>
          !each.isTypeOnly && (each.propertyName ?? each.name).text === holding.database.name,
      )
    );
  });
  let loads = false;
  const visit = (node: Node): void => {
    if (!loads) {
      loads =
        isCallExpression(node) &&
        node.expression.kind === SyntaxKind.ImportKeyword &&
        namesModule(node.arguments[0], holding);
      node.forEachChild(visit);
    }
  };
  if (!reexports) {
    sourceFile.forEachChild(visit);
  }
  return reexports || loads;
}

/**
 * The first use `sourceFile` makes of the application's database, as the code writes it (`useAt`):
 * a read of a name it holds the handle by (`databaseNames`) — a call through it, a table or the
 * handle held by another name or handed on, `const todos = db.todos`, `load(db)` — or of its
 * module, imported whole, by the database's export; or the module, or the handle, exported again
 * or loaded (`handsModuleOn`). Only an evaluation of the authority answers the handle — a
 * component's server part, a server operation, a guard — and what Next.js renders throws of a call
 * of it, wherever the code makes it: a read the compile does not follow to a call is taken for one.
 * None of a name a scope around the read declares again (`freeReads`), nor, in the database's own
 * module, of its export of it.
 */
export function databaseUseIn(sourceFile: SourceFile, holding: Holding): string | undefined {
  const own = path.resolve(sourceFile.fileName) === path.resolve(holding.database.file);
  const namespaces = namespacesOf(sourceFile, holding);
  for (const read of freeReads(sourceFile)) {
    const use = isListed(read) ? undefined : useAt(read, holding, namespaces);
    if (use !== undefined && !(own && isOwnExport(read))) {
      return use;
    }
  }
  return handsModuleOn(sourceFile, holding) ? holding.database.name : undefined;
}

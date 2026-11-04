import {
  type FunctionDeclaration,
  type Identifier,
  isClassDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isNamedExports,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import type { Fail } from './errors.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * A module of custom hooks as a module: what it declares at its top level, what it exports, and
 * what it may hold where its copy is written — declarations, and nothing that runs as it loads.
 */

/** Refuses what a module of hooks cannot hold where its copy is written: a re-export of a path, an effect. */
export function checkModuleStatement(statement: Statement, fail: Fail): void {
  if (isExpressionStatement(statement) && !isStringLiteral(statement.expression)) {
    fail(
      'A module of custom hooks declares its hooks and what they use, and runs nothing as it loads: its copy runs in the browser, where an effect would run on its own.',
      statement,
    );
  }
  if (
    isImportEqualsDeclaration(statement) ||
    (isExportAssignment(statement) && statement.isExportEquals)
  ) {
    fail(
      "A module of custom hooks is an ES module, as its copy is: CommonJS's import and export have no place in it.",
      statement,
    );
  }
  if (
    isExportDeclaration(statement) &&
    statement.moduleSpecifier !== undefined &&
    isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text.startsWith('.')
  ) {
    fail(
      `\`${statement.moduleSpecifier.text}\` is a relative path, which names another module from where the copy is written: name it by a path of the application's, as \`@/…\`.`,
      statement.moduleSpecifier,
    );
  }
}

/** The name a function declaration is exported under, if it is: its own, or `default`. */
function exportedAs(fn: FunctionDeclaration): string | undefined {
  const kinds = new Set(fn.modifiers?.map((modifier) => modifier.kind));
  if (fn.name === undefined || !kinds.has(SyntaxKind.ExportKeyword)) {
    return undefined;
  }
  return kinds.has(SyntaxKind.DefaultKeyword) ? 'default' : fn.name.text;
}

/** What an `export { … }` of local names exports, by the name each is exported under. */
function listedExports(statement: Statement): readonly (readonly [string, string])[] {
  if (
    !isExportDeclaration(statement) ||
    statement.moduleSpecifier !== undefined ||
    statement.exportClause === undefined ||
    !isNamedExports(statement.exportClause)
  ) {
    return [];
  }
  return statement.exportClause.elements.flatMap((element) => {
    const local = element.propertyName ?? element.name;
    return isIdentifier(local) && isIdentifier(element.name)
      ? [[element.name.text, local.text] as const]
      : [];
  });
}

/** The names a module exports its functions by, each with the function's own name. */
export function exportsOf(statements: readonly Statement[]): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const statement of statements) {
    const exported = isFunctionDeclaration(statement) ? exportedAs(statement) : undefined;
    if (
      exported !== undefined &&
      isFunctionDeclaration(statement) &&
      statement.name !== undefined
    ) {
      found.set(exported, statement.name.text);
    }
    for (const [name, local] of listedExports(statement)) {
      found.set(name, local);
    }
  }
  return found;
}

/** The names a top-level statement of a module declares. */
export function declaredAtTop(statement: Statement): readonly Identifier[] {
  if (isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingIdentifiers(declaration.name),
    );
  }
  if (
    isFunctionDeclaration(statement) ||
    isClassDeclaration(statement) ||
    isInterfaceDeclaration(statement) ||
    isTypeAliasDeclaration(statement) ||
    isEnumDeclaration(statement)
  ) {
    return statement.name === undefined ? [] : [statement.name];
  }
  return [];
}

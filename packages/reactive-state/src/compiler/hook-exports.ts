import {
  type FunctionDeclaration,
  type Identifier,
  isClassDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isExpressionStatement,
  isExternalModuleReference,
  isFunctionDeclaration,
  isIdentifier,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNamedExports,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isVariableStatement,
  type ModuleDeclaration,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { Fail } from './errors.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * A module of custom hooks as a module: what it declares at its top level, what it exports, and
 * what it may hold where its copy is written — declarations, and nothing that runs as it loads.
 */

/**
 * The statements that declare, of which a module of hooks is made — a variable, a function, a class,
 * a type, an enum, a namespace, an import, an export — and the empty one, which runs nothing.
 */
const DECLARING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ClassDeclaration,
  SyntaxKind.EmptyStatement,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.ExportAssignment,
  SyntaxKind.ExportDeclaration,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ImportDeclaration,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.ModuleDeclaration,
  SyntaxKind.NamespaceExportDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.VariableStatement,
]);

/** Refuses what a module of hooks cannot hold where its copy is written: a re-export of a path, an effect. */
export function checkModuleStatement(statement: Statement, fail: Fail): void {
  const effect = effectOf(statement);
  if (effect !== undefined) {
    fail(
      'A module of custom hooks declares its hooks and what they use, and runs nothing as it loads: its copy runs in the browser, where an effect would run on its own.',
      effect,
    );
  }
  if (
    (isImportEqualsDeclaration(statement) &&
      isExternalModuleReference(statement.moduleReference)) ||
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

/**
 * What of `statement` runs as the module loads for what it does, and declares nothing: itself, an
 * expression — but a directive's text, `'use client'` — or any other statement but a declaration
 * (`DECLARING`): a condition, a loop, a block, a label, a `throw`; or such a statement of a
 * namespace's body. None of a declaration, whose initializer makes what it declares.
 */
function effectOf(statement: Statement): Statement | undefined {
  if (isModuleDeclaration(statement)) {
    for (const each of namespaceBody(statement)) {
      const effect = effectOf(each);
      if (effect !== undefined) {
        return effect;
      }
    }
    return undefined;
  }
  if (isExpressionStatement(statement)) {
    return isStringLiteral(statement.expression) ? undefined : statement;
  }
  return DECLARING.has(statement.kind) ? undefined : statement;
}

/** What a namespace's body holds: its statements, or the namespace within it, `namespace A.B {}`. */
function namespaceBody(namespace: ModuleDeclaration): readonly Statement[] {
  const { body } = namespace;
  if (body !== undefined && isModuleDeclaration(body)) {
    return [body];
  }
  return body !== undefined && isModuleBlock(body) ? body.statements : [];
}

/** The name a function declaration is exported under, if it is: its own, or `default`. */
function exportedAs(fn: FunctionDeclaration): string | undefined {
  const kinds = new Set(fn.modifiers?.map((modifier) => modifier.kind));
  if (fn.name === undefined || !kinds.has(SyntaxKind.ExportKeyword)) {
    return undefined;
  }
  return kinds.has(SyntaxKind.DefaultKeyword) ? 'default' : fn.name.text;
}

/**
 * What an `export { … }` of local names exports, by the name each is exported under: none of a type
 * alone, `export type { … }`, `{ type name }`, which exports nothing that runs.
 */
function listedExports(statement: Statement): readonly (readonly [string, string])[] {
  if (
    !isExportDeclaration(statement) ||
    statement.isTypeOnly ||
    statement.moduleSpecifier !== undefined ||
    statement.exportClause === undefined ||
    !isNamedExports(statement.exportClause)
  ) {
    return [];
  }
  return statement.exportClause.elements.flatMap((element) => {
    const local = element.propertyName ?? element.name;
    return !element.isTypeOnly && isIdentifier(local) && isIdentifier(element.name)
      ? [[element.name.text, local.text] as const]
      : [];
  });
}

/** The name `export default name;` exports as the module's default; none of another statement. */
function assignedDefault(statement: Statement): string | undefined {
  if (!isExportAssignment(statement) || statement.isExportEquals) {
    return undefined;
  }
  let value = unwrapped(statement.expression);
  // `unwrapped` leaves a cast in angle brackets, `<typeof useThing>useThing`.
  while (isTypeAssertion(value)) {
    value = unwrapped(value.expression);
  }
  return isIdentifier(value) ? value.text : undefined;
}

/**
 * The names a module exports its functions by, each with the function's own name: of a declaration,
 * of a list, and of its default by name, `export default useThing;`.
 */
export function exportsOf(statements: readonly Statement[]): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const statement of statements) {
    const assigned = assignedDefault(statement);
    if (assigned !== undefined) {
      found.set('default', assigned);
    }
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

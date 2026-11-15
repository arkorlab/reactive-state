import {
  type FunctionDeclaration,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isNamedExports,
  isStringLiteral,
  isVariableStatement,
  type Statement,
  SyntaxKind,
  type VariableStatement,
} from 'typescript/ast';

import type { Modules } from './modules.ts';
import { isScript } from './typescript.ts';

/**
 * What a module of the application's exports by name, as Next.js asks a segment's module for an
 * export — `generateStaticParams`, a route handler's `GET` — read off its top level: a declaration
 * exported by its name, a list of exports that names it, or a module it exports everything of.
 */

/**
 * Whether `statement`, a declaration of a module's top level, is exported by its own name:
 * `export`, not `export default`, which exports it as the module's default — nothing Next.js asks a
 * segment for by name.
 */
function exportsByName(statement: FunctionDeclaration | VariableStatement): boolean {
  const kinds = new Set(statement.modifiers?.map((modifier) => modifier.kind));
  return kinds.has(SyntaxKind.ExportKeyword) && !kinds.has(SyntaxKind.DefaultKeyword);
}

/**
 * Whether `statement`, of a module's top level, exports `name`: a declaration of it exported by its
 * name, or a list of exports that names it. A declaration the module keeps to itself is no export
 * of it, whatever it is named.
 */
function namesExport(statement: Statement, name: string): boolean {
  if (isFunctionDeclaration(statement)) {
    return exportsByName(statement) && statement.name?.text === name;
  }
  if (isVariableStatement(statement)) {
    return (
      exportsByName(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => isIdentifier(declaration.name) && declaration.name.text === name,
      )
    );
  }
  if (!isExportDeclaration(statement) || statement.isTypeOnly) {
    return false;
  }
  const clause = statement.exportClause;
  return (
    clause !== undefined &&
    isNamedExports(clause) &&
    clause.elements.some((element) => !element.isTypeOnly && element.name.text === name)
  );
}

/** The module of the application's `statement`, of `file`, exports everything of: `export * from`. */
function exportedWhole(statement: Statement, file: string, modules: Modules): string | undefined {
  if (
    !isExportDeclaration(statement) ||
    statement.exportClause !== undefined ||
    statement.isTypeOnly ||
    statement.moduleSpecifier === undefined ||
    !isStringLiteral(statement.moduleSpecifier)
  ) {
    return undefined;
  }
  return modules.resolve(statement.moduleSpecifier.text, file);
}

/**
 * The statement of `file`'s top level that exports `name`: one that declares or names it, or an
 * `export * from` of a module of the application's that exports it so; none where none does.
 */
export function exportOf(
  file: string,
  name: string,
  modules: Modules,
  seen = new Set<string>(),
): Statement | undefined {
  if (seen.has(file) || !isScript(file)) {
    return undefined;
  }
  seen.add(file);
  const { sourceFile } = modules.parse(file, false);
  return sourceFile.statements.find((statement) => {
    if (namesExport(statement, name)) {
      return true;
    }
    const whole = exportedWhole(statement, file, modules);
    return whole !== undefined && exportOf(whole, name, modules, seen) !== undefined;
  });
}

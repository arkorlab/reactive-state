import {
  type Expression,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isNamedExports,
  isVariableStatement,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater, isAnswering, returnedBy } from './answers.ts';
import { metadataCallee } from './input-callees.ts';
import { proxyOrigin } from './proxy-origins.ts';

/** A Proxy exported directly or through a shared function's written return origins. */
export function sharedProxyOrigin(sourceFile: SourceFile): Node | undefined {
  const values: Expression[] = [];
  for (const statement of sourceFile.statements) {
    statementOrigins(statement, values);
  }
  return proxyOrigin(values);
}

/** The value roots one module export exposes, excluding type-only exports. */
function statementOrigins(statement: Statement, values: Expression[]): void {
  if (isFunctionDeclaration(statement)) {
    if (hasExport(statement.modifiers) && !answersLater(statement)) {
      values.push(...returnedBy(statement));
    }
    return;
  }
  if (isVariableStatement(statement)) {
    if (hasExport(statement.modifiers)) {
      const initializers = statement.declarationList.declarations.flatMap((each) =>
        each.initializer === undefined ? [] : [each.initializer],
      );
      for (const value of initializers) {
        exportedOrigins(value, values);
      }
    }
    return;
  }
  if (isExportAssignment(statement)) {
    exportedOrigins(statement.expression, values);
    return;
  }
  namedOrigins(statement, values);
}

/** Locally named value exports; transitive source modules are checked separately. */
function namedOrigins(statement: Statement, values: Expression[]): void {
  if (
    !isExportDeclaration(statement) ||
    statement.moduleSpecifier !== undefined ||
    statement.isTypeOnly ||
    statement.exportClause === undefined ||
    !isNamedExports(statement.exportClause)
  ) {
    return;
  }
  for (const entry of statement.exportClause.elements) {
    if (!entry.isTypeOnly) {
      exportedOrigins(entry.propertyName ?? entry.name, values);
    }
  }
}

/** An exported callable's source returns, or the exported data value itself. */
function exportedOrigins(value: Expression, values: Expression[]): void {
  const fn = metadataCallee(value);
  if (fn !== undefined && isAnswering(fn)) {
    if (!answersLater(fn)) {
      values.push(...returnedBy(fn));
    }
    return;
  }
  values.push(value);
}

/** Whether a declaration is exported as a value. */
function hasExport(modifiers: readonly Node[] | undefined): boolean {
  return modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) === true;
}

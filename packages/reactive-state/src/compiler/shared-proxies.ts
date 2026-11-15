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

import { type Answering, answersLater, isAnswering } from './answers.ts';
import { metadataCallee } from './input-callees.ts';
import { proxyOrigin } from './proxy-origins.ts';

/** Exported data expressions and synchronous callables collected from a shared module. */
interface ExportRoots {
  readonly callables: Answering[];
  readonly values: Expression[];
}

/** A Proxy exported directly or through a shared function's written return origins. */
export function sharedProxyOrigin(sourceFile: SourceFile): Node | undefined {
  const roots: ExportRoots = { callables: [], values: [] };
  for (const statement of sourceFile.statements) {
    statementOrigins(statement, roots);
  }
  return proxyOrigin(roots.values, { callables: roots.callables });
}

/** The value roots one module export exposes, excluding type-only exports. */
function statementOrigins(statement: Statement, roots: ExportRoots): void {
  if (isFunctionDeclaration(statement)) {
    if (hasExport(statement.modifiers) && !answersLater(statement)) {
      roots.callables.push(statement);
    }
    return;
  }
  if (isVariableStatement(statement)) {
    if (hasExport(statement.modifiers)) {
      const initializers = statement.declarationList.declarations.flatMap((each) =>
        each.initializer === undefined ? [] : [each.initializer],
      );
      for (const value of initializers) {
        exportedOrigins(value, roots);
      }
    }
    return;
  }
  if (isExportAssignment(statement)) {
    exportedOrigins(statement.expression, roots);
    return;
  }
  namedOrigins(statement, roots);
}

/** Locally named value exports; transitive source modules are checked separately. */
function namedOrigins(statement: Statement, roots: ExportRoots): void {
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
      exportedOrigins(entry.propertyName ?? entry.name, roots);
    }
  }
}

/** An exported callable kept with its parameter frame, or the exported data value itself. */
function exportedOrigins(value: Expression, roots: ExportRoots): void {
  const fn = metadataCallee(value);
  if (fn !== undefined && isAnswering(fn)) {
    if (!answersLater(fn)) {
      roots.callables.push(fn);
    }
    return;
  }
  roots.values.push(value);
}

/** Whether a declaration is exported as a value. */
function hasExport(modifiers: readonly Node[] | undefined): boolean {
  return modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) === true;
}

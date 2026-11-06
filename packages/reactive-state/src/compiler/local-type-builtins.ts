import {
  type Identifier,
  isBlock,
  isCaseBlock,
  isEnumDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNamespaceImport,
  isQualifiedName,
  isSourceFile,
  type Node,
  type QualifiedName,
  type Statement,
} from 'typescript/ast';

import { namespaceStatements } from './local-type-namespaces.ts';

/** Built-in type names qualified through the unshadowed global namespace. */

/**
 * The global type's name through `globalThis`, which may repeat. Ordinary value and type
 * declarations do not hide the namespace; local namespaces, imports and enums do.
 */
export function qualifiedBuiltinName(name: QualifiedName): string | undefined {
  let root = name.left;
  while (isQualifiedName(root)) {
    if (root.right.text !== 'globalThis') {
      return undefined;
    }
    root = root.left;
  }
  return root.text === 'globalThis' && !namespaceBound(root) ? name.right.text : undefined;
}

/** Whether a lexical declaration hides the implicit namespace a global type qualifies through. */
export function namespaceBound(name: Identifier): boolean {
  for (let at: Node = name.parent; ; at = at.parent) {
    if (isModuleDeclaration(at) && isIdentifier(at.name) && at.name.text === name.text) {
      return true;
    }
    const statements = statementsOf(at);
    if (statements?.some((statement) => bindsNamespace(statement, name.text)) === true) {
      return true;
    }
    if (isSourceFile(at)) {
      return false;
    }
  }
}

/** The declarations of one lexical scope, including merged namespace bodies and switch clauses. */
function statementsOf(node: Node): readonly Statement[] | undefined {
  if (isModuleBlock(node)) {
    return namespaceStatements(node);
  }
  if (isCaseBlock(node)) {
    return node.clauses.flatMap((clause) => clause.statements);
  }
  return isBlock(node) || isSourceFile(node) ? node.statements : undefined;
}

/** Whether a declaration occupies the namespace space, without treating values or types as one. */
function bindsNamespace(statement: Statement, name: string): boolean {
  if (isModuleDeclaration(statement)) {
    return isIdentifier(statement.name) && statement.name.text === name;
  }
  if (isEnumDeclaration(statement) || isImportEqualsDeclaration(statement)) {
    return statement.name.text === name;
  }
  if (!isImportDeclaration(statement)) {
    return false;
  }
  const clause = statement.importClause;
  if (clause?.name?.text === name) {
    return true;
  }
  const named = clause?.namedBindings;
  return (
    named !== undefined &&
    (isNamespaceImport(named)
      ? named.name.text === name
      : named.elements.some((element) => element.name.text === name))
  );
}

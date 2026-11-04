import {
  type Identifier,
  type ClassDeclaration,
  isBlock,
  isCaseBlock,
  isClassDeclaration,
  isEnumDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNamespaceImport,
  isQualifiedName,
  isSourceFile,
  isTypeAliasDeclaration,
  type ModuleBlock,
  type ModuleDeclaration,
  type Node,
  type QualifiedName,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import type { LocalTypeBinding } from './local-type-aliases.ts';

/** The local declarations behind a qualified type name, through lexical namespaces alone. */

/**
 * The local alias, interface or class `name` qualifies through namespaces declared around it. Imported
 * namespaces and unknown members are opaque; ordinary values and types occupy other name spaces.
 */
export function qualifiedLocalTypeBinding(name: QualifiedName): LocalTypeBinding {
  const members: string[] = [];
  let root = name.left;
  members.unshift(name.right.text);
  while (isQualifiedName(root)) {
    members.unshift(root.right.text);
    root = root.left;
  }
  let namespaces = lexicalNamespaces(root);
  for (const [index, member] of members.entries()) {
    if (namespaces === undefined || namespaces === null) {
      return namespaces;
    }
    const statements = exportedStatements(namespaces);
    if (index === members.length - 1) {
      return memberTypeBinding(statements, member);
    }
    namespaces = namespacesIn(statements, member);
  }
  return undefined;
}

/**
 * A namespace body's own declarations and the exported declarations of its merged bodies. A
 * private member stays in the body that declares it; ordinary ambient members export implicitly.
 */
export function namespaceStatements(block: ModuleBlock): readonly Statement[] {
  if (!isModuleDeclaration(block.parent)) {
    return block.statements;
  }
  const statements = new Set<Statement>(block.statements);
  const merged = exportedStatements(mergedNamespaces(block.parent));
  for (const statement of merged) {
    statements.add(statement);
  }
  return [...statements];
}

/** The declarations that merge with `namespace`, through its exported enclosing namespace path. */
function mergedNamespaces(namespace: ModuleDeclaration): readonly ModuleDeclaration[] {
  const members: string[] = [];
  let root = namespace;
  for (
    let parent = enclosingNamespace(root);
    parent !== undefined;
    parent = enclosingNamespace(root)
  ) {
    if (!isIdentifier(root.name) || !exportedNamespace(root)) {
      break;
    }
    members.unshift(root.name.text);
    root = parent;
  }
  if (!isIdentifier(root.name)) {
    return [namespace];
  }
  const statements = directStatementsOf(root.parent);
  let merged = statements === undefined ? undefined : namespacesIn(statements, root.name.text);
  for (const member of members) {
    if (merged === undefined || merged === null) {
      return [namespace];
    }
    merged = namespacesIn(exportedStatements(merged), member);
  }
  return merged ?? [namespace];
}

/** The enclosing namespace of a dotted declaration or one written in another namespace's body. */
function enclosingNamespace(namespace: ModuleDeclaration): ModuleDeclaration | undefined {
  const { parent } = namespace;
  if (isModuleDeclaration(parent)) {
    return isIdentifier(parent.name) ? parent : undefined;
  }
  return isModuleBlock(parent) &&
    isModuleDeclaration(parent.parent) &&
    isIdentifier(parent.parent.name)
    ? parent.parent
    : undefined;
}

/** Whether a nested namespace is visible to the other bodies of its enclosing namespace. */
function exportedNamespace(namespace: ModuleDeclaration): boolean {
  return (
    isModuleDeclaration(namespace.parent) ||
    isAmbient(namespace) ||
    carries(namespace, SyntaxKind.ExportKeyword)
  );
}

/** The nearest namespace-space declarations of `name`, with imports and enums hiding outer ones. */
function lexicalNamespaces(name: Identifier): readonly ModuleDeclaration[] | null | undefined {
  for (let at: Node = name.parent; ; at = at.parent) {
    const statements = statementsOf(at);
    const found = statements === undefined ? undefined : namespacesIn(statements, name.text);
    if (found !== undefined || isSourceFile(at)) {
      return found;
    }
  }
}

/** The declarations of one lexical scope, including all clauses of a switch. */
function statementsOf(node: Node): readonly Statement[] | undefined {
  return isModuleBlock(node) ? namespaceStatements(node) : directStatementsOf(node);
}

/** The declarations written directly in one lexical scope. */
function directStatementsOf(node: Node): readonly Statement[] | undefined {
  if (isCaseBlock(node)) {
    return node.clauses.flatMap((clause) => clause.statements);
  }
  return isBlock(node) || isModuleBlock(node) || isSourceFile(node) ? node.statements : undefined;
}

/** The namespace declarations in `statements` that merge as `name`, or an opaque namespace binding. */
function namespacesIn(
  statements: readonly Statement[],
  name: string,
): readonly ModuleDeclaration[] | null | undefined {
  const namespaces = statements.filter((statement): statement is ModuleDeclaration => {
    return (
      isModuleDeclaration(statement) && isIdentifier(statement.name) && statement.name.text === name
    );
  });
  if (namespaces.length > 0) {
    return namespaces;
  }
  return statements.some((statement) => importsName(statement, name) || enumBinds(statement, name))
    ? null
    : undefined;
}

/** The members visible through each namespace's exported name, including dotted declarations. */
function exportedStatements(namespaces: readonly ModuleDeclaration[]): readonly Statement[] {
  return namespaces.flatMap((namespace) => {
    const { body } = namespace;
    if (body === undefined) {
      return [];
    }
    if (isModuleDeclaration(body)) {
      return [body];
    }
    if (!isModuleBlock(body)) {
      return [];
    }
    const ambient = isAmbient(namespace);
    return body.statements.filter((statement) => {
      return (
        carries(statement, SyntaxKind.ExportKeyword) ||
        (ambient && !isImportDeclaration(statement) && !isImportEqualsDeclaration(statement))
      );
    });
  });
}

/** Whether a namespace is ambient, by its own declaration, an enclosing one or its declaration file. */
function isAmbient(namespace: ModuleDeclaration): boolean {
  for (let at: Node = namespace; ; at = at.parent) {
    if (carries(at, SyntaxKind.DeclareKeyword)) {
      return true;
    }
    if (isSourceFile(at)) {
      return at.isDeclarationFile;
    }
  }
}

/** Whether a declaration carries a modifier, where that kind of node can hold modifiers. */
function carries(node: Node, modifier: SyntaxKind): boolean {
  return (
    (node as { readonly modifiers?: readonly Node[] }).modifiers?.some(
      (each) => each.kind === modifier,
    ) === true
  );
}

/** The exported type `name` names, retaining interfaces and class/interface merging. */
function memberTypeBinding(statements: readonly Statement[], name: string): LocalTypeBinding {
  for (const statement of statements) {
    if (
      (isTypeAliasDeclaration(statement) || isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return statement;
    }
    if (isInterfaceDeclaration(statement) && statement.name.text === name) {
      return (
        statements.find(
          (member): member is ClassDeclaration =>
            isClassDeclaration(member) && member.name?.text === name,
        ) ?? statement
      );
    }
    if (importsName(statement, name) || enumBinds(statement, name)) {
      return null;
    }
  }
  return undefined;
}

/** Whether `statement` declares an enum in the namespace name space. */
function enumBinds(statement: Statement, name: string): boolean {
  return isEnumDeclaration(statement) && statement.name.text === name;
}

/** Whether `statement` imports `name`, whose namespace members this local reader cannot know. */
function importsName(statement: Statement, name: string): boolean {
  if (isImportEqualsDeclaration(statement)) {
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

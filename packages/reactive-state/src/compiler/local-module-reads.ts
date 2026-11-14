import {
  type Identifier,
  isArrayBindingPattern,
  isBindingElement,
  isBlock,
  isCaseBlock,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isModuleBlock,
  isObjectBindingPattern,
  isParameterDeclaration,
  isSourceFile,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  SyntaxKind,
  type VariableDeclarationList,
} from 'typescript/ast';

import { unshadowedReadsIn } from './code-globals.ts';
import { freeReads, isBlockScoped } from './scope.ts';

/**
 * Reads of a constant or parameter, excluding names its nested lexical scopes declare anew — a
 * namespace's body among them.
 */
export function readsOf(declared: Identifier, owner: Node): (node: Node) => node is Identifier {
  const reads = moduleReads(declared, owner);
  return (node): node is Identifier => {
    return (
      node !== declared &&
      isIdentifier(node) &&
      node.text === declared.text &&
      (reads === undefined || reads.has(node))
    );
  };
}

/** Reads below the binding's own scope, whose children do not mask that binding as an inner name. */
function moduleReads(name: Identifier, owner: Node): ReadonlySet<Identifier> | undefined {
  const found = bindingScope(name, owner);
  if (found === undefined) {
    return undefined;
  }
  const reads = new Set<Identifier>();
  const readsIn = found.exported ? freeReads : unshadowedReadsIn;
  found.scope.forEachChild((child) => {
    for (const read of readsIn(child)) {
      reads.add(read);
    }
  });
  return reads;
}

/**
 * The lexical scope declaring a constant, or the function declaring one of its parameters; of a
 * constant a namespace's body declares, the body, where it keeps the name to itself. One it exports
 * is read by the bodies that merge with it, which this does not find: its scope is the module's, as
 * wide as it was, and `exported`, so that no namespace is read as hiding it.
 */
function bindingScope(
  name: Identifier,
  owner: Node,
): { readonly scope: Node; readonly exported: boolean } | undefined {
  let declaration: Node = name.parent;
  while (
    isBindingElement(declaration) ||
    isObjectBindingPattern(declaration) ||
    isArrayBindingPattern(declaration)
  ) {
    declaration = declaration.parent;
  }
  if (isParameterDeclaration(declaration)) {
    return { exported: false, scope: declaration.parent };
  }
  if (
    !isVariableDeclaration(declaration) ||
    !isVariableDeclarationList(declaration.parent) ||
    !isBlockScoped(declaration.parent)
  ) {
    return undefined;
  }
  const exported = exportsIt(declaration.parent);
  for (let at: Node = declaration.parent; at !== owner; at = at.parent) {
    if (declaresBlock(at) || isSourceFile(at) || (!exported && isModuleBlock(at))) {
      return { exported, scope: at };
    }
  }
  return { exported, scope: owner };
}

/** Whether the statement of `list` is exported, `export const`, of a namespace's body. */
function exportsIt(list: VariableDeclarationList): boolean {
  const statement = list.parent;
  return (
    isModuleBlock(statement.parent) &&
    isVariableStatement(statement) &&
    statement.modifiers?.some((each) => each.kind === SyntaxKind.ExportKeyword) === true
  );
}

/** The scope of a block-scoped variable, including loop heads and a switch's shared cases. */
function declaresBlock(node: Node): boolean {
  return (
    isBlock(node) ||
    isCaseBlock(node) ||
    isForStatement(node) ||
    isForOfStatement(node) ||
    isForInStatement(node)
  );
}

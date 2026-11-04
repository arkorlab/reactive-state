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
  isObjectBindingPattern,
  isParameterDeclaration,
  isSourceFile,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { freeReads, isBlockScoped } from './scope.ts';

/** Reads of a constant or parameter, excluding names its nested lexical scopes declare anew. */
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
  const scope = bindingScope(name, owner);
  if (scope === undefined) {
    return undefined;
  }
  const reads = new Set<Identifier>();
  scope.forEachChild((child) => {
    for (const read of freeReads(child)) {
      reads.add(read);
    }
  });
  return reads;
}

/** The lexical scope declaring a constant, or the function declaring one of its parameters. */
function bindingScope(name: Identifier, owner: Node): Node | undefined {
  let declaration: Node = name.parent;
  while (
    isBindingElement(declaration) ||
    isObjectBindingPattern(declaration) ||
    isArrayBindingPattern(declaration)
  ) {
    declaration = declaration.parent;
  }
  if (isParameterDeclaration(declaration)) {
    return declaration.parent;
  }
  if (
    !isVariableDeclaration(declaration) ||
    !isVariableDeclarationList(declaration.parent) ||
    !isBlockScoped(declaration.parent)
  ) {
    return undefined;
  }
  for (let at: Node = declaration.parent; at !== owner; at = at.parent) {
    if (declaresBlock(at) || isSourceFile(at)) {
      return at;
    }
  }
  return owner;
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

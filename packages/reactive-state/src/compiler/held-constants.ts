import {
  isBinaryExpression,
  isBlock,
  isCaseBlock,
  isDeleteExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isModuleBlock,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isElementAccessExpression,
  isSourceFile,
  isVariableDeclaration,
  isVariableStatement,
  type Expression,
  type Identifier,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { localClassValueBinding } from './local-type-aliases.ts';
import { readsBinding } from './scope.ts';
import { isTakenApart, useOf } from './uses.ts';

/** What a constant the code declares is, where nothing changes it or hands it on: what it was made of. */

/** The statements that make a scope: a block, a module's or a namespace's body, a switch's cases, a loop. */
function isScope(node: Node): boolean {
  return (
    isBlock(node) ||
    isSourceFile(node) ||
    isModuleBlock(node) ||
    isCaseBlock(node) ||
    isForStatement(node) ||
    isForOfStatement(node) ||
    isForInStatement(node)
  );
}

/** Whether `kind` assigns: `=`, `+=`, `**=` and the others. */
function isAssigning(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

/**
 * Whether a read of a constant is a read of a member of it, `held.call`, that changes none: not
 * written to, `held.call = fn`, `held.count++`, `delete held.call`, taken apart as a target.
 */
function readsMember(read: Node): boolean {
  const { at, parent } = useOf(read);
  if (
    !(isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) ||
    parent.expression !== at
  ) {
    return false;
  }
  const { at: member, parent: outer } = useOf(parent);
  return !(
    (isBinaryExpression(outer) && outer.left === member && isAssigning(outer.operatorToken.kind)) ||
    ((isPrefixUnaryExpression(outer) || isPostfixUnaryExpression(outer)) &&
      (outer.operator === SyntaxKind.PlusPlusToken ||
        outer.operator === SyntaxKind.MinusMinusToken)) ||
    isDeleteExpression(outer) ||
    isTakenApart(member)
  );
}

/** Whether a constant is exported, which another module may change. */
function isExported(declaration: VariableDeclaration): boolean {
  const statement = declaration.parent.parent;
  return (
    isVariableStatement(statement) &&
    statement.modifiers?.some((each) => each.kind === SyntaxKind.ExportKeyword) === true
  );
}

/**
 * Whether the constant `declaration` is changed or handed on within the scope it is declared in:
 * read by other than a member of it, `Object.setPrototypeOf(held, fn)`, `const alias = held`.
 */
function isHeld(declaration: VariableDeclaration, name: string): boolean {
  let scope: Node = declaration.parent;
  while (!isScope(scope)) {
    scope = scope.parent;
  }
  let held = false;
  const visit = (node: Node): void => {
    if (
      !held &&
      isIdentifier(node) &&
      node.text === name &&
      node !== declaration.name &&
      readsBinding(node) &&
      localClassValueBinding(node) === declaration &&
      !readsMember(node)
    ) {
      held = true;
    }
    node.forEachChild(visit);
  };
  scope.forEachChild(visit);
  return held;
}

/**
 * What the constant `name` reads of is initialized by, where nothing changes it or hands it on —
 * so that what it was made of is what it is: none of another binding, an exported constant, one
 * written to or handed on.
 */
export function heldInitializer(name: Identifier): Expression | undefined {
  const binding = localClassValueBinding(name);
  return binding !== undefined &&
    binding !== null &&
    isVariableDeclaration(binding) &&
    !isExported(binding) &&
    !isHeld(binding, name.text)
    ? binding.initializer
    : undefined;
}

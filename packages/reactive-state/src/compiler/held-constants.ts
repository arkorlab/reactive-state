import {
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isCaseBlock,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isModuleBlock,
  isNewExpression,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isSourceFile,
  isTaggedTemplateExpression,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { memberOf, peeled, setsPrototype, valueUse } from './literal-members.ts';
import { localClassValueBinding } from './local-type-aliases.ts';
import { readsBinding } from './scope.ts';
import { isTakenApart } from './uses.ts';

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

/** The text a node writes, a string; none of another node. */
type TextOf = (node: Node) => string | undefined;

/**
 * Whether a read or a call of `member` of an object may change it: a call, where the code does not
 * show the member to be a function written, which gives `this` nothing (`mentionsThis`), or none;
 * a read, where the object has a prototype (`__proto__`), one of whose getters may, and the code does
 * not show the member to be a function written.
 */
function mayChange(
  member: Node,
  called: boolean,
  literal: ObjectLiteralExpression | undefined,
  textOf: TextOf,
): boolean {
  if (literal === undefined) {
    return true;
  }
  let name: string | undefined;
  if (isPropertyAccessExpression(member)) {
    name = member.name.text;
  } else if (isElementAccessExpression(member)) {
    name = textOf(peeled(member.argumentExpression));
  }
  const own = name === undefined ? 'unknown' : memberOf(literal, name, textOf);
  return called ? own === 'unknown' : own !== 'function' && setsPrototype(literal, textOf);
}

/**
 * Whether a read of a constant is a read of a member of it, `held.call`, that changes none: not
 * written to, `held.call = fn`, `held.count++`, `delete held.call`, taken apart as a target; and not
 * called where the call may change it (`mayChange`), `held.setup()`.
 */
function readsMember(
  read: Node,
  literal: ObjectLiteralExpression | undefined,
  textOf: TextOf,
): boolean {
  const { at, parent } = valueUse(read);
  if (
    !(isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) ||
    parent.expression !== at
  ) {
    return false;
  }
  const { at: member, parent: outer } = valueUse(parent);
  const called =
    ((isCallExpression(outer) || isNewExpression(outer)) && outer.expression === member) ||
    (isTaggedTemplateExpression(outer) && outer.tag === member);
  return !(
    (isBinaryExpression(outer) && outer.left === member && isAssigning(outer.operatorToken.kind)) ||
    ((isPrefixUnaryExpression(outer) || isPostfixUnaryExpression(outer)) &&
      (outer.operator === SyntaxKind.PlusPlusToken ||
        outer.operator === SyntaxKind.MinusMinusToken)) ||
    isDeleteExpression(outer) ||
    isTakenApart(member) ||
    mayChange(parent, called, literal, textOf)
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
function isHeld(declaration: VariableDeclaration, name: string, textOf: TextOf): boolean {
  const initializer =
    declaration.initializer === undefined ? undefined : peeled(declaration.initializer);
  const literal =
    initializer !== undefined && isObjectLiteralExpression(initializer) ? initializer : undefined;
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
      !readsMember(node, literal, textOf)
    ) {
      held = true;
    }
    node.forEachChild(visit);
  };
  scope.forEachChild(visit);
  return held;
}

/** Whether `node` writes `this` anywhere: a method of an object may change the object by it. */
function mentionsThis(node: Node): boolean {
  let found = node.kind === SyntaxKind.ThisKeyword;
  node.forEachChild((child) => {
    found ||= mentionsThis(child);
  });
  return found;
}

/**
 * What the constant `name` reads of is initialized by, where nothing changes it or hands it on —
 * so that what it was made of is what it is: none of another binding, an exported constant, one
 * written to or handed on, one a method of which may change it by `this`, or whose member is called
 * where the call may (`mayChange`).
 */
export function heldInitializer(name: Identifier, textOf: TextOf): Expression | undefined {
  const binding = localClassValueBinding(name);
  return binding !== undefined &&
    binding !== null &&
    isVariableDeclaration(binding) &&
    binding.initializer !== undefined &&
    !isExported(binding) &&
    !mentionsThis(binding.initializer) &&
    !isHeld(binding, name.text, textOf)
    ? binding.initializer
    : undefined;
}

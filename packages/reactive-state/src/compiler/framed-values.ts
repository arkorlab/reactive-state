import {
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isBlock,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isIdentifier,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  SyntaxKind,
  type TypeNode,
  type VariableStatement,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering, returnedBy } from './answers.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedFactoryArguments } from './framed-factory-arguments.ts';
import { framedFactoryCall } from './framed-factory-calls.ts';
import { framedFactoryReturns } from './framed-factory-returns.ts';

/** Written assertion types and synchronous local results, without a runtime type checker. */

interface Assertion {
  readonly type: TypeNode;
  readonly keys: readonly string[];
}
type Resolve = (name: Identifier) => Node | undefined;

/** Transparent wrappers retain an assertion's written type before the receiver is unwrapped. */
export function framedValueShape(node: Expression): {
  readonly value: Expression;
  readonly assertions: readonly Assertion[];
} {
  let value = node;
  while (transparent(value)) value = value.expression;
  const assertions: Assertion[] = [];
  let selected = node;
  let keys: readonly string[] = [];
  for (;;) {
    if (isAsExpression(selected) || isTypeAssertion(selected)) {
      assertions.push({ keys, type: selected.type });
      selected = selected.expression;
    } else if (transparent(selected)) {
      selected = selected.expression;
    } else if (isPropertyAccessExpression(selected) || isElementAccessExpression(selected)) {
      const key = frameMemberName(selected);
      if (key === undefined) break;
      keys = [key, ...keys];
      selected = selected.expression;
    } else break;
  }
  return { assertions, value };
}

/** Source-written synchronous factories, excluding imported, async and generator results. */
export function framedCallReturns(
  call: CallExpression,
  resolve: Resolve,
  select?: (returned: Expression) => readonly Expression[] | undefined,
): readonly Expression[] | undefined {
  const invocation = framedFactoryCall(call, (callee) => localFactory(callee, resolve), resolve);
  if (invocation === undefined) return undefined;
  const { fn, given } = invocation;
  if (answersLater(fn) || fn.body === undefined) return undefined;
  const returned = isBlock(fn.body)
    ? framedFactoryReturns(fn.body, constantStatement)
    : returnedBy(fn);
  if (returned === undefined) return undefined;
  const projected = returned.flatMap((value) =>
    framedFactoryArguments(value, call, fn, { resolve, given }),
  );
  if (select === undefined) return projected;
  const selected: Expression[] = [];
  for (const value of projected) {
    const members = select(value);
    if (members === undefined) return undefined;
    for (const member of members)
      selected.push(...framedFactoryArguments(member, call, fn, { resolve, given }));
  }
  return selected;
}

/** Lexical function declarations and constant aliases, with repeated value syntax left opaque. */
function localFactory(callee: Expression, resolve: Resolve): Answering | undefined {
  const seen = new Set<Node>();
  let value = framedValueShape(callee).value;
  while (!seen.has(value)) {
    seen.add(value);
    if (isAnswering(value)) return value;
    if (!isIdentifier(value)) return undefined;
    const declared = resolve(value);
    if (declared === undefined) return undefined;
    if (isFunctionDeclaration(declared)) return unchangedFactory(declared, resolve);
    if (!isVariableDeclaration(declared) || declared.initializer === undefined) return undefined;
    const statement = declared.parent.parent;
    if (!isVariableStatement(statement) || !constantStatement(statement)) return undefined;
    value = framedValueShape(declared.initializer).value;
  }
  return undefined;
}

/** Named declarations retain their body only while no source write can replace that lexical binding. */
function unchangedFactory(
  declared: FunctionDeclaration,
  resolve: Resolve,
): FunctionDeclaration | undefined {
  const pending: Node[] = [declared.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isIdentifier(node) &&
      node.text === declared.name?.text &&
      reassignedName(node) &&
      resolve(node) === declared
    )
      return undefined;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return declared;
}

/** A direct, destructured, unary or loop write to the name itself, excluding its object's fields. */
function reassignedName(name: Identifier): boolean {
  let target: Node = name;
  while (assignmentContainer(target)) target = target.parent;
  const parent = target.parent;
  if (isBinaryExpression(parent) && parent.left === target) {
    const kind = parent.operatorToken.kind;
    return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
  }
  if (isForInStatement(parent) || isForOfStatement(parent)) return parent.initializer === target;
  return (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
  );
}

/** Wrappers and assignment patterns preserve their selected target; member and key reads do not. */
function assignmentContainer(target: Node): boolean {
  const parent = target.parent;
  return (
    (transparent(parent) && parent.expression === target) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === target) ||
    (isShorthandPropertyAssignment(parent) && parent.name === target)
  );
}

/** Parentheses, assertions, non-null markers and satisfies preserve the underlying value. */
function transparent(node: Node): node is Expression & { readonly expression: Expression } {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isTypeAssertion(node) ||
    isNonNullExpression(node) ||
    isSatisfiesExpression(node)
  );
}

/** A constant declaration, read directly to keep this leaf out of the admission module graph. */
function constantStatement(statement: VariableStatement): boolean {
  return /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()));
}

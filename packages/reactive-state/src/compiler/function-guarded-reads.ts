import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isBreakStatement,
  isCaseClause,
  isClassStaticBlockDeclaration,
  isConditionalExpression,
  isContinueStatement,
  isDefaultClause,
  isForInStatement,
  isForOfStatement,
  isFunctionLikeDeclaration,
  isIdentifier,
  isIfStatement,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isThrowStatement,
  isTypeOfExpression,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { unwrapTarget } from './function-this-writes.ts';

const WRITTEN_NAMES = new WeakMap<SourceFile, ReadonlySet<string>>();

/** The `typeof` result of a function, which no other value has. */
const FUNCTION_TYPEOF = 'function';

/** The operators that compare equal when their operands are, and those that compare unequal. */
const EQUAL_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
]);
const UNEQUAL_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/**
 * Whether the read `name`, of a binding that the code never assigns, stands where a guard of the
 * same binding has shown that it holds no function: the branch of a conditional or an `if` that a
 * `typeof name` test selects, the right operand of an `&&` or `||` that it selects, or the
 * statements after an `if` whose test it makes and whose then branch always leaves. A function a
 * closure runs later is none of these, so the read is looked for only as far as the function that
 * holds it; what a guard cannot prove — `instanceof`, a test of another name — shows nothing.
 */
export function isGuardedNonFunction(name: Identifier, declared: FrameDeclaration): boolean {
  if (isWritten(name)) {
    return false;
  }
  for (let at: Node = name.parent, child: Node = name; ; child = at, at = at.parent) {
    if (isFunctionLikeDeclaration(at) || isClassStaticBlockDeclaration(at)) {
      return false;
    }
    if (selectsNonFunction(at, child, name, declared)) {
      return true;
    }
    if (isSourceFile(at)) {
      return false;
    }
  }
}

/** Whether `at` runs `child` only where a guard in `at` has shown that `name` holds no function. */
function selectsNonFunction(
  at: Node,
  child: Node,
  name: Identifier,
  declared: FrameDeclaration,
): boolean {
  if (isConditionalExpression(at)) {
    return (
      (isChild(child, at.whenTrue) && proves(at.condition, true, name, declared)) ||
      (isChild(child, at.whenFalse) && proves(at.condition, false, name, declared))
    );
  }
  if (isIfStatement(at)) {
    return (
      (isChild(child, at.thenStatement) && proves(at.expression, true, name, declared)) ||
      (isChild(child, at.elseStatement) && proves(at.expression, false, name, declared))
    );
  }
  if (isBinaryExpression(at) && isChild(child, at.right)) {
    const operator = at.operatorToken.kind;
    if (operator === SyntaxKind.AmpersandAmpersandToken) {
      return proves(at.left, true, name, declared);
    }
    return operator === SyntaxKind.BarBarToken && proves(at.left, false, name, declared);
  }
  if (isBlock(at) || isCaseClause(at) || isDefaultClause(at) || isSourceFile(at)) {
    return afterLeavingGuard(at.statements, child, name, declared);
  }
  return false;
}

/** Whether `child` is the node `branch`. */
function isChild(child: Node, branch: Node | undefined): boolean {
  return child === branch;
}

/** Whether a statement before `child` is an `if` that always leaves, and that a guard of `name` makes. */
function afterLeavingGuard(
  statements: readonly Statement[],
  child: Node,
  name: Identifier,
  declared: FrameDeclaration,
): boolean {
  for (const statement of statements) {
    if (isChild(child, statement)) {
      return false;
    }
    if (
      isIfStatement(statement) &&
      leaves(statement.thenStatement) &&
      proves(statement.expression, false, name, declared)
    ) {
      return true;
    }
  }
  return false;
}

/** Whether `statement` always ends by returning, throwing, breaking or continuing. */
function leaves(statement: Statement): boolean {
  let last: Statement | undefined = statement;
  while (last !== undefined && isBlock(last)) {
    last = last.statements.at(-1);
  }
  return (
    last !== undefined &&
    (isReturnStatement(last) ||
      isThrowStatement(last) ||
      isBreakStatement(last) ||
      isContinueStatement(last))
  );
}

/**
 * Whether `condition` having the value `truth` shows that `name` holds no function: `typeof name`
 * compared with the text of a type, for or against, under `!`, and as a part of an `&&` that is
 * true or of an `||` that is false.
 */
function proves(
  condition: Expression,
  truth: boolean,
  name: Identifier,
  declared: FrameDeclaration,
): boolean {
  let each = unwrapped(condition);
  let holds = truth;
  while (isPrefixUnaryExpression(each) && each.operator === SyntaxKind.ExclamationToken) {
    each = unwrapped(each.operand);
    holds = !holds;
  }
  if (!isBinaryExpression(each)) {
    return false;
  }
  const operator = each.operatorToken.kind;
  if (operator === SyntaxKind.AmpersandAmpersandToken) {
    return (
      holds && (proves(each.left, true, name, declared) || proves(each.right, true, name, declared))
    );
  }
  if (operator === SyntaxKind.BarBarToken) {
    return (
      !holds &&
      (proves(each.left, false, name, declared) || proves(each.right, false, name, declared))
    );
  }
  const compared = typeofComparison(each.left, each.right, name, declared);
  if (
    compared === undefined ||
    !(EQUAL_OPERATORS.has(operator) || UNEQUAL_OPERATORS.has(operator))
  ) {
    return false;
  }
  // `typeof name === compared` holds when the operator is an equality and the test is true, or an
  // inequality and the test is false; then the type is `compared`, else it is another.
  const isThatType = EQUAL_OPERATORS.has(operator) === holds;
  return isThatType ? compared !== FUNCTION_TYPEOF : compared === FUNCTION_TYPEOF;
}

/** The text `typeof name` is compared with, in either order of the operands; none of another test. */
function typeofComparison(
  left: Expression,
  right: Expression,
  name: Identifier,
  declared: FrameDeclaration,
): string | undefined {
  const [operand, text] = isTypeOfExpression(unwrapped(left))
    ? [unwrapped(left), unwrapped(right)]
    : [unwrapped(right), unwrapped(left)];
  if (
    !isTypeOfExpression(operand) ||
    !(isStringLiteral(text) || isNoSubstitutionTemplateLiteral(text))
  ) {
    return undefined;
  }
  const tested = unwrapped(operand.expression);
  return isIdentifier(tested) &&
    tested.text === name.text &&
    frameDeclarationOf(tested) === declared
    ? text.text
    : undefined;
}

/** Whether the file assigns a name `name` is spelled as, anywhere: `=`, `+=`, `++`, a loop head or a pattern. */
function isWritten(name: Identifier): boolean {
  const file = name.getSourceFile();
  let names = WRITTEN_NAMES.get(file);
  if (names === undefined) {
    const written = new Set<string>();
    collectWrittenNames(file, written);
    names = written;
    WRITTEN_NAMES.set(file, names);
  }
  return names.has(name.text);
}

/** Adds the names `node` and what it holds assign: the targets of assignments, updates and loop heads. */
function collectWrittenNames(node: Node, written: Set<string>): void {
  if (
    isBinaryExpression(node) &&
    node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= SyntaxKind.LastAssignment
  ) {
    addTargetNames(node.left, written);
  } else if (
    (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
    (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken)
  ) {
    addTargetNames(node.operand, written);
  } else if (
    (isForInStatement(node) || isForOfStatement(node)) &&
    !isVariableDeclarationList(node.initializer)
  ) {
    addTargetNames(node.initializer, written);
  }
  node.forEachChild((each) => {
    collectWrittenNames(each, written);
  });
}

/** Adds the names a target binds: a name, or the names of an object or array pattern, with their defaults. */
function addTargetNames(target: Node, written: Set<string>): void {
  const each = unwrapTarget(target);
  if (isIdentifier(each)) {
    written.add(each.text);
  } else if (isBinaryExpression(each) && each.operatorToken.kind === SyntaxKind.EqualsToken) {
    addTargetNames(each.left, written);
  } else if (isArrayLiteralExpression(each)) {
    for (const element of each.elements) {
      addTargetNames(isSpreadElement(element) ? element.expression : element, written);
    }
  } else if (isObjectLiteralExpression(each)) {
    for (const property of each.properties) {
      addPropertyTargetNames(property, written);
    }
  }
}

/** Adds the names a property of an object pattern binds: a shorthand name, or what its value or spread binds. */
function addPropertyTargetNames(property: ObjectLiteralElementLike, written: Set<string>): void {
  if (isShorthandPropertyAssignment(property)) {
    if (isIdentifier(property.name)) {
      written.add(property.name.text);
    }
  } else if (isPropertyAssignment(property)) {
    addTargetNames(property.initializer, written);
  } else if (isSpreadAssignment(property)) {
    addTargetNames(property.expression, written);
  }
}

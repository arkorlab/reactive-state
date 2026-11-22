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
  isParameterDeclaration,
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
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type SourceFile,
  type Statement,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { unwrapTarget } from './function-this-writes.ts';
import { bindingIdentifiers } from './scope.ts';

/** What a file assigns, by name, and the declarations that bind a name again, by name. */
interface WrittenNames {
  readonly assigned: Set<string>;
  readonly redeclared: Map<string, Node[]>;
}

const WRITTEN_NAMES = new WeakMap<SourceFile, WrittenNames>();

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
 * Whether the read `name`, of a parameter or a `const` or `let` that the code never assigns,
 * stands where a guard of the same binding has shown that it holds no function: the branch of a
 * conditional or an `if` that a `typeof name` test selects, the right operand of an `&&` or `||`
 * that it selects, or the statements after an `if` whose test it makes and whose then branch always
 * leaves. A function a closure runs later is none of these, so the read is looked for only as far
 * as the function that holds it; what a guard cannot prove — `instanceof`, a test of another name —
 * shows nothing. A `var` is never narrowed: it is hoisted, so its own initializer may run between
 * a guard and a read, which a parameter and a block-scoped binding (whose temporal dead zone keeps
 * a guard from running before its declaration) do not allow.
 */
export function isGuardedNonFunction(name: Identifier, declared: FrameDeclaration): boolean {
  if (!isScopedBinding(declared) || isWritten(name, declared)) {
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

/**
 * Whether `child` is one of `statements`, after an `if` that always leaves and that a guard of
 * `name` makes. What else a node with statements holds — the expression of a `case` — runs before
 * them, so only a statement of the list is looked at.
 */
function afterLeavingGuard(
  statements: readonly Statement[],
  child: Node,
  name: Identifier,
  declared: FrameDeclaration,
): boolean {
  const at = statements.findIndex((statement) => isChild(child, statement));
  const before = statements.slice(0, Math.max(at, 0));
  for (const statement of before) {
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

/** Whether `declared` is a parameter, or a `const` or `let`: a binding that is no hoisted `var`. */
function isScopedBinding(declared: FrameDeclaration): boolean {
  if (isParameterDeclaration(declared)) {
    return true;
  }
  const list = isVariableDeclaration(declared) ? declared.parent : undefined;
  return (
    list !== undefined &&
    isVariableDeclarationList(list) &&
    /^(?:const|let)\b/u.test(list.getText(declared.getSourceFile()))
  );
}

/**
 * Whether the file writes the binding `declared` of `name`: it assigns a name spelled as `name`
 * anywhere (`=`, `+=`, `++`, a loop head, a pattern), or, where `declared` is a parameter, a `var`
 * of the same function binds the name again and so assigns it — an initialized `var` or a `var`
 * loop head. (A `const` or `let` that a `var` of its own scope would redeclare is a syntax error.)
 */
function isWritten(name: Identifier, declared: FrameDeclaration): boolean {
  const file = name.getSourceFile();
  let names = WRITTEN_NAMES.get(file);
  if (names === undefined) {
    names = { assigned: new Set<string>(), redeclared: new Map<string, Node[]>() };
    collectWrittenNames(file, names);
    WRITTEN_NAMES.set(file, names);
  }
  if (names.assigned.has(name.text)) {
    return true;
  }
  const redeclaring = isParameterDeclaration(declared)
    ? (names.redeclared.get(name.text) ?? [])
    : [];
  return redeclaring.some((each) => scopeOf(each) === scopeOf(declared));
}

/** The function, static block or file whose variables `node` declares or is a parameter of. */
function scopeOf(node: Node): Node {
  let at = node.parent;
  while (
    !isFunctionLikeDeclaration(at) &&
    !isClassStaticBlockDeclaration(at) &&
    !isSourceFile(at)
  ) {
    at = at.parent;
  }
  return at;
}

/** Adds what `node` and what it holds write: assignments, updates and loop heads, and redeclarations. */
function collectWrittenNames(node: Node, written: WrittenNames): void {
  recordAssignment(node, written.assigned);
  recordRedeclaration(node, written.redeclared);
  node.forEachChild((each) => {
    collectWrittenNames(each, written);
  });
}

/** Adds the names `node` assigns: the targets of assignments, updates and loop heads. */
function recordAssignment(node: Node, assigned: Set<string>): void {
  if (
    isBinaryExpression(node) &&
    node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= SyntaxKind.LastAssignment
  ) {
    addTargetNames(node.left, assigned);
  } else if (
    (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
    (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken)
  ) {
    addTargetNames(node.operand, assigned);
  } else if (
    (isForInStatement(node) || isForOfStatement(node)) &&
    !isVariableDeclarationList(node.initializer)
  ) {
    addTargetNames(node.initializer, assigned);
  }
}

/** Adds the names `node` declares again, as a `var` that gives them a value or heads a loop. */
function recordRedeclaration(node: Node, redeclared: Map<string, Node[]>): void {
  if (!isVariableDeclaration(node) || !assignsItsNames(node)) {
    return;
  }
  for (const bound of bindingIdentifiers(node.name)) {
    redeclared.set(bound.text, [...(redeclared.get(bound.text) ?? []), node]);
  }
}

/** Whether `declaration` is a `var` that gives its names a value: an initializer or a loop head. */
function assignsItsNames(declaration: VariableDeclaration): boolean {
  const list = declaration.parent;
  if (
    !isVariableDeclarationList(list) ||
    !/^var\b/u.test(list.getText(declaration.getSourceFile()))
  ) {
    return false;
  }
  return (
    declaration.initializer !== undefined ||
    isForInStatement(list.parent) ||
    isForOfStatement(list.parent)
  );
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

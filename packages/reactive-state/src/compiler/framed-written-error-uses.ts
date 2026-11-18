import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBigIntLiteral,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassStaticBlockDeclaration,
  isConditionalExpression,
  isConstructorDeclaration,
  isDeleteExpression,
  isDoStatement,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isGetAccessorDeclaration,
  isIdentifier,
  isIfStatement,
  isNewExpression,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTemplateSpan,
  isTypeAssertion,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  isWhileStatement,
  type Node,
  type PropertyName,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { arrayMethodMayBeOverridden } from './framed-arrays.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { useOf } from './uses.ts';

/**
 * Classifies references to a local `Error` variable into whole block-scoped lexical aliases and
 * proven non-escaping read-only uses, rejecting any write, mutation call, or escaping reference.
 */

const SCALAR_ERROR_KEYS: ReadonlySet<string> = new Set(['message', 'name', 'stack']);

const SAFE_BINARY_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.PlusToken,
]);

const PRIMITIVE_LITERAL_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.TrueKeyword,
]);

const RETURN_BINARY_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** Matches `const alias = error` and `let alias = error` without `using` disposal hooks. */
export function lexicalErrorAlias(reference: Identifier): VariableDeclaration | undefined {
  if (reassignedTarget(reference)) return undefined;
  const { at, parent } = useOf(reference);
  if (
    !isVariableDeclaration(parent) ||
    parent.initializer !== at ||
    !isIdentifier(parent.name) ||
    !isVariableDeclarationList(parent.parent) ||
    !/^(?:const|let)\b/u.test(parent.parent.getText(parent.getSourceFile()).trimStart())
  ) {
    return undefined;
  }
  return parent;
}

/** Whitelists direct text conversions, non-coercing tests, scalar reads, and inline array joins. */
export function nonEscapingErrorRead(reference: Identifier): boolean {
  if (reassignedTarget(reference)) return false;
  const { at, parent } = useOf(reference);
  return (
    directTextOrTestUse(at, parent) ||
    scalarMemberRead(at, parent) ||
    scalarDestructuringRead(at, parent) ||
    inlineArrayTextRead(at, parent)
  );
}

/** Direct `String(error)`, untagged templates, strict/boolean guards, and `+` / `+=` conversions. */
function directTextOrTestUse(at: Node, parent: Node): boolean {
  return (
    directStringConversion(at, parent) ||
    untaggedTemplateSpan(at, parent) ||
    safeBinaryUse(at, parent) ||
    isTypeOfExpression(parent) ||
    isVoidExpression(parent) ||
    pureBooleanTestUse(at, parent)
  );
}

/** Truthiness tests consume `ToBoolean` directly without retaining or exposing the reference. */
function pureBooleanTestUse(at: Node, parent: Node): boolean {
  let current = at;
  let container = parent;
  while (booleanBranchOperand(current, container)) {
    const outer = useOf(container);
    current = outer.at;
    container = outer.parent;
  }
  return immediateBooleanTest(current, container);
}

/** Logical and conditional branch slots forward a value only when enclosed in a boolean test. */
function booleanBranchOperand(at: Node, parent: Node): boolean {
  if (isConditionalExpression(parent)) {
    return parent.whenTrue === at || parent.whenFalse === at;
  }
  return (
    isBinaryExpression(parent) &&
    RETURN_BINARY_OPERATORS.has(parent.operatorToken.kind) &&
    (parent.left === at || parent.right === at)
  );
}

/** Control-flow conditions, `!`, `?:` conditions, and unshadowed `Boolean(value)` calls. */
function immediateBooleanTest(at: Node, parent: Node): boolean {
  if (
    (isIfStatement(parent) || isWhileStatement(parent) || isDoStatement(parent)) &&
    parent.expression === at
  ) {
    return true;
  }
  if ((isForStatement(parent) || isConditionalExpression(parent)) && parent.condition === at) {
    return true;
  }
  if (
    isPrefixUnaryExpression(parent) &&
    parent.operator === SyntaxKind.ExclamationToken &&
    parent.operand === at
  ) {
    return true;
  }
  return directBooleanConversion(at, parent);
}

/** Unshadowed single-argument `Boolean(value)` call converting to a primitive boolean. */
function directBooleanConversion(at: Node, parent: Node): boolean {
  if (!isCallExpression(parent) || parent.arguments.length !== 1 || parent.arguments[0] !== at) {
    return false;
  }
  const callee = unwrapped(parent.expression);
  return globalPathOf(callee)?.join('.') === 'Boolean';
}

/** Unshadowed single-argument `String(value)` or `new String(value)` conversion. */
function directStringConversion(at: Node, parent: Node): boolean {
  if (!isCallExpression(parent) && !isNewExpression(parent)) return false;
  if (parent.arguments?.length !== 1 || parent.arguments[0] !== at) return false;
  const callee = unwrapped(parent.expression);
  return isIdentifier(callee) && globalPathOf(callee)?.join('.') === 'String';
}

/** Untagged template literal span converting `at` directly through `ToString`. */
function untaggedTemplateSpan(at: Node, parent: Node): boolean {
  return (
    isTemplateSpan(parent) &&
    parent.expression === at &&
    isTemplateExpression(parent.parent) &&
    !isTaggedTemplateExpression(parent.parent.parent)
  );
}

/** Primitive-producing `+`, `+=` (right-hand side only), and `===` / `!==` comparisons. */
function safeBinaryUse(at: Node, parent: Node): boolean {
  if (!isBinaryExpression(parent)) return false;
  const kind = parent.operatorToken.kind;
  if (SAFE_BINARY_OPERATORS.has(kind)) return parent.left === at || parent.right === at;
  return kind === SyntaxKind.PlusEqualsToken && parent.right === at;
}

/** Scalar `.message` / `.name` / `.stack` reads and zero-argument `.toString()` calls. */
function scalarMemberRead(at: Node, parent: Node): boolean {
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    parent.expression !== at
  ) {
    return false;
  }
  const outer = useOf(parent);
  if (isDeleteExpression(outer.parent) || reassignedTarget(parent)) return false;
  const key = staticMemberKey(parent);
  if (key !== undefined && SCALAR_ERROR_KEYS.has(key)) {
    return !invokesTarget(outer.at, outer.parent);
  }
  return (
    key === 'toString' &&
    isCallExpression(outer.parent) &&
    outer.parent.expression === outer.at &&
    outer.parent.arguments.length === 0
  );
}

/** Checks whether `at` sits in the callee or tag slot of an invocation expression. */
function invokesTarget(at: Node, parent: Node): boolean {
  return (
    ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === at) ||
    (isTaggedTemplateExpression(parent) && parent.tag === at)
  );
}

/** Object destructuring limited to static scalar `Error` properties without defaults or rest. */
function scalarDestructuringRead(at: Node, parent: Node): boolean {
  return (
    isVariableDeclaration(parent) &&
    parent.initializer === at &&
    isVariableDeclarationList(parent.parent) &&
    isObjectBindingPattern(parent.name) &&
    parent.name.elements.every((element) => scalarBindingElement(element))
  );
}

/** Validates a single `{ message }` / `{ name }` / `{ stack }` destructuring element. */
function scalarBindingElement(element: Node): boolean {
  if (
    !isBindingElement(element) ||
    element.dotDotDotToken !== undefined ||
    element.initializer !== undefined ||
    !isIdentifier(element.name)
  ) {
    return false;
  }
  const key =
    element.propertyName === undefined
      ? element.name.text
      : staticPropertyName(element.propertyName);
  return key !== undefined && SCALAR_ERROR_KEYS.has(key);
}

/** Inline `[error].join(',')` / `[error].toString()` / `String([error])` without array escape. */
function inlineArrayTextRead(at: Node, parent: Node): boolean {
  if (!isArrayLiteralExpression(parent)) return false;
  if (
    !parent.elements.every(
      (each) => !isSpreadElement(each) && (each === at || primitiveLiteral(unwrapped(each))),
    )
  ) {
    return false;
  }
  const outer = useOf(parent);
  if (
    directStringConversion(outer.at, outer.parent) ||
    untaggedTemplateSpan(outer.at, outer.parent) ||
    (isBinaryExpression(outer.parent) &&
      outer.parent.operatorToken.kind === SyntaxKind.PlusToken &&
      (outer.parent.left === outer.at || outer.parent.right === outer.at))
  ) {
    return (
      !arrayMethodMayBeOverridden(parent, 'toString') && !arrayMethodMayBeOverridden(parent, 'join')
    );
  }
  return inlineArrayMethodCall(parent, outer.at, outer.parent);
}

/** Direct `.join(primitive?)` or `.toString()` on an unescaped array literal. */
function inlineArrayMethodCall(array: Node, at: Node, parent: Node): boolean {
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    parent.expression !== at
  ) {
    return false;
  }
  const method = staticMemberKey(parent);
  const call = useOf(parent);
  if (!isCallExpression(call.parent) || call.parent.expression !== call.at) return false;
  if (method === 'toString') {
    return call.parent.arguments.length === 0 && !arrayMethodMayBeOverridden(array, 'toString');
  }
  if (method !== 'join' || arrayMethodMayBeOverridden(array, 'join')) return false;
  const [separator] = call.parent.arguments;
  return (
    call.parent.arguments.length === 0 ||
    (call.parent.arguments.length === 1 &&
      separator !== undefined &&
      !isSpreadElement(separator) &&
      primitiveLiteral(unwrapped(separator)))
  );
}

/** Extracts a static property key from `obj.key` or `obj['key']`. */
function staticMemberKey(member: Node): string | undefined {
  if (isPropertyAccessExpression(member)) {
    return isIdentifier(member.name) ? member.name.text : undefined;
  }
  if (!isElementAccessExpression(member)) return undefined;
  const key = unwrapped(member.argumentExpression);
  return isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key) ? key.text : undefined;
}

/** Static identifier or string-literal property name inside an object binding pattern. */
function staticPropertyName(name: PropertyName): string | undefined {
  return isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined;
}

/** Side-effect-free primitive literals and unshadowed `undefined`. */
function primitiveLiteral(node: Expression): boolean {
  if (
    isStringLiteral(node) ||
    isNoSubstitutionTemplateLiteral(node) ||
    isNumericLiteral(node) ||
    isBigIntLiteral(node) ||
    PRIMITIVE_LITERAL_KINDS.has(node.kind)
  ) {
    return true;
  }
  return isIdentifier(node) && node.text === 'undefined' && frameDeclarationOf(node) === undefined;
}

/** Checks whether `target` sits on the left-hand side of an assignment or update operator. */
function isAssignmentLeft(target: Node, parent: Node): boolean {
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

/** Walks through transparent wrappers and destructuring patterns to detect writes. */
export function reassignedTarget(node: Node): boolean {
  let target: Node = node;
  while (assignmentWrapper(target)) target = target.parent;
  return isAssignmentLeft(target, target.parent);
}

/** Transparent expressions and assignment patterns propagate writes to their bound target. */
function assignmentWrapper(target: Node): boolean {
  const parent = target.parent;
  return (
    (transparentExpression(parent) && parent.expression === target) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === target) ||
    (isShorthandPropertyAssignment(parent) && parent.name === target)
  );
}

/** Parentheses, type assertions, non-null markers and satisfies preserve the target reference. */
function transparentExpression(
  node: Node,
): node is Expression & { readonly expression: Expression } {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isTypeAssertion(node) ||
    isNonNullExpression(node) ||
    isSatisfiesExpression(node)
  );
}

/** Nearest enclosing callable or static-block execution scope for a declaration or statement. */
export function enclosingValueScope(node: Node): Node | undefined {
  for (let at: Node = node.parent; !isSourceFile(at); at = at.parent) {
    if (
      isAnswering(at) ||
      isConstructorDeclaration(at) ||
      isGetAccessorDeclaration(at) ||
      isSetAccessorDeclaration(at) ||
      isClassStaticBlockDeclaration(at)
    ) {
      return at;
    }
  }
  return undefined;
}

/** Whether `reference` flows exclusively out as a returned value of `scope`. */
export function returnedFromScope(reference: Identifier, scope: Answering): boolean {
  if (reassignedTarget(reference)) return false;
  let current: Node = reference;
  while (returnResultWrapper(current)) current = current.parent;
  const parent = current.parent;
  if (isArrowFunction(parent)) return parent === scope && parent.body === current;
  return (
    isReturnStatement(parent) &&
    parent.expression === current &&
    enclosingValueScope(parent) === scope
  );
}

/** Value-forwarding wrappers and branch operands that preserve a returned expression slot. */
function returnResultWrapper(node: Node): boolean {
  const parent = node.parent;
  if (transparentExpression(parent) && parent.expression === node) return true;
  if (isConditionalExpression(parent)) {
    return parent.whenTrue === node || parent.whenFalse === node;
  }
  if (!isBinaryExpression(parent)) return false;
  const kind = parent.operatorToken.kind;
  if (kind === SyntaxKind.CommaToken) return parent.right === node;
  return RETURN_BINARY_OPERATORS.has(kind) && (parent.left === node || parent.right === node);
}

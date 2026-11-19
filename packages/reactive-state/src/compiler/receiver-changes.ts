import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNonNullExpression,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isTemplateExpression,
  isTypeAssertion,
  isTypeOfExpression,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { targetsOf } from './kept.ts';
import { readsOf } from './local-module-reads.ts';
import { bindingIdentifiers } from './scope.ts';
import { writtenBy } from './written.ts';

/**
 * Whether a module changes what a constant holds beyond what its own method bodies show: it hands
 * the constant on, or assigns into its members. The checks read a missing member of a held object
 * as it was written, and a default taken from it as fresh, only while no code does.
 */

const ASSIGNED = new WeakMap<SourceFile, ReadonlySet<Node>>();
const CHANGED = new WeakMap<Identifier, boolean>();

/**
 * Whether a read of the constant `name` is anything but the object of a member access, or reaches
 * a member that is assigned (`name.items = rows`, `name.a.b++`, `delete name.x`, `[name.n] = row`):
 * a call of a method on it, `name.items.push(1)`, and a read of a member, change none of them.
 */
export function changedThroughReads(name: Identifier): boolean {
  const cached = CHANGED.get(name);
  if (cached !== undefined) {
    return cached;
  }
  CHANGED.set(name, false);
  const file = name.getSourceFile();
  const assigned = assignedTargets(file);
  const reads = readsOf(name, file);
  let found = false;
  const visit = (node: Node): void => {
    if (found) {
      return;
    }
    if (reads(node)) {
      found = handedOnOrAssigned(node, assigned);
      return;
    }
    node.forEachChild(visit);
  };
  visit(file);
  CHANGED.set(name, found);
  return found;
}

/**
 * Whether `read` is a value the module passes on, or the root of a member chain assigned to; one a
 * constant takes (`const alias = name`, `const { items } = name`) is passed on if a name that
 * constant declares is.
 */
function handedOnOrAssigned(read: Identifier, assigned: ReadonlySet<Node>): boolean {
  let at = outermost(read);
  const taking = constantTaking(at);
  if (taking !== undefined) {
    return bindingIdentifiers(taking.name).some((each) => changedThroughReads(each));
  }
  if (!isMemberOf(at.parent, at)) {
    return true;
  }
  while (isMemberOf(at.parent, at)) {
    const access = at.parent;
    if (assigned.has(access)) {
      return true;
    }
    at = outermost(access);
  }
  return false;
}

/** The `const` declaration `node` is the whole initializer of; none of another position. */
function constantTaking(node: Node): VariableDeclaration | undefined {
  const declaration = node.parent;
  if (!isVariableDeclaration(declaration)) {
    return undefined;
  }
  const initializer: Node | undefined = declaration.initializer;
  return initializer === node && /^const\s/u.test(declaration.parent.getText())
    ? declaration
    : undefined;
}

/** The expression `node` is the whole of, past the parentheses and assertions around it. */
function outermost(node: Node): Node {
  let at = node;
  while (
    (isParenthesizedExpression(at.parent) ||
      isNonNullExpression(at.parent) ||
      isAsExpression(at.parent) ||
      isSatisfiesExpression(at.parent) ||
      isTypeAssertion(at.parent)) &&
    at.parent.expression === at
  ) {
    at = at.parent;
  }
  return at;
}

/** Whether `parent` reads a member of `child`, as `child.name` and `child[key]` do. */
function isMemberOf(
  parent: Node,
  child: Node,
): parent is Node & { readonly expression: Expression } {
  return (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === child
  );
}

/** The operators that assign a value of any kind, and not the number or text a computation gives. */
const ASSIGNING_VALUES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** The operators that answer one of their operands, whatever it is: `&&`, `||`, `??`, `,`, `=`. */
const ANSWERING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.CommaToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * Whether `node` changes what stands where it writes into to a number, text or `undefined` (`n++`,
 * `n += 2`, `delete name.x`, `name.label = 'a'`), which hands on no reference to anything.
 */
function givesAPrimitive(node: Node): boolean {
  if (isDeleteExpression(node) || isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) {
    return true;
  }
  if (!isBinaryExpression(node)) {
    return false;
  }
  if (!ASSIGNING_VALUES.has(node.operatorToken.kind)) {
    return true;
  }
  const target = unwrapped(node.left);
  return (
    node.operatorToken.kind === SyntaxKind.EqualsToken &&
    !isArrayLiteralExpression(target) &&
    !isObjectLiteralExpression(target) &&
    isPrimitive(unwrapped(node.right))
  );
}

/** Whether `value` is a literal, an operation or `undefined` that gives a number, text or boolean. */
function isPrimitive(value: Expression): boolean {
  return (
    isNumericLiteral(value) ||
    isBigIntLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isTemplateExpression(value) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword ||
    (isIdentifier(value) && value.text === 'undefined') ||
    isVoidExpression(value) ||
    isTypeOfExpression(value) ||
    isPrefixUnaryExpression(value) ||
    isPostfixUnaryExpression(value) ||
    (isBinaryExpression(value) && !ANSWERING.has(value.operatorToken.kind))
  );
}

/** What the module assigns into, other than by a call, past what wraps it: found once for a file. */
function assignedTargets(file: SourceFile): ReadonlySet<Node> {
  const cached = ASSIGNED.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const found = new Set<Node>();
  const visit = (node: Node): void => {
    const written = isCallExpression(node) || givesAPrimitive(node) ? undefined : writtenBy(node);
    const targets = written === undefined ? [] : targetsOf(written);
    for (const each of targets) {
      found.add(isExpression(each) ? unwrapped(each) : each);
    }
    node.forEachChild(visit);
  };
  visit(file);
  ASSIGNED.set(file, found);
  return found;
}

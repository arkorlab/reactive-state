/**
 * A collection's own iterating method, replaced right before a spread reads it, yields what the
 * replacement returns: `values.values = () => [data].values()` makes `[...values.values()]` the
 * written array's elements, whatever the collection holds.
 */

import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassLikeDeclaration,
  isComputedPropertyName,
  isElementAccessExpression,
  isExpression,
  isExpressionStatement,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isKeywordKind,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPunctuationKind,
  isReturnStatement,
  isSourceFile,
  isStatement,
  isTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { DEFAULT_ITERATOR, iteratorMemberName } from './framed-iterator-guards.ts';
import { framedRunsNoCode } from './framed-quiet-operands.ts';

/** The methods whose call on a written array yields its elements in order. */
const ELEMENTS = new Set([DEFAULT_ITERATOR, 'values']);

/**
 * The views of what a spread yields where the statement right before it replaces the iterated
 * method on a name the collection is read through (`bindings`) with a function returning a written
 * array's own iterator: the array's element at the position, or any element where the position is
 * unknown. None where no such replacement precedes the spread, or where what runs between them may
 * replace the method again (`quietBefore`), so the collection's readers apply.
 */
export function framedReplacedIteration(
  bindings: ReadonlySet<FrameBinding>,
  method: string,
  read: Node,
  at: { readonly index: number | undefined; readonly keys: readonly string[] },
): readonly ArrayElementView[] | undefined {
  const replacement = precedingReplacement(bindings, method, read);
  const array = replacement === undefined ? undefined : returnedElements(replacement);
  return array === undefined ? undefined : [{ value: array, index: at.index, keys: at.keys }];
}

/** The whole `const` names an expression is read through, a collection's names for replacement. */
export function framedAliasBindings(expression: Expression): ReadonlySet<FrameBinding> {
  const bindings = new Set<FrameBinding>();
  let value = unwrapped(expression);
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      binding === undefined ||
      selected?.keys.length !== 0 ||
      bindings.has(binding) ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      break;
    bindings.add(binding);
    value = unwrapped(binding.initializer);
  }
  return bindings;
}

/**
 * The function the statement right before `read` assigns to the method on one of `bindings`, where
 * nothing runs between them that may replace it again (`previousStatement`).
 */
function precedingReplacement(
  bindings: ReadonlySet<FrameBinding>,
  method: string,
  read: Node,
): Expression | undefined {
  const previous = previousStatement(read);
  if (previous === undefined || !isExpressionStatement(previous)) return undefined;
  const assignment = unwrapped(previous.expression);
  if (!isBinaryExpression(assignment) || assignment.operatorToken.kind !== SyntaxKind.EqualsToken)
    return undefined;
  const target = unwrapped(assignment.left);
  if (
    (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) ||
    iteratorMemberName(target) !== method
  )
    return undefined;
  const receiver = unwrapped(target.expression);
  const selected = isIdentifier(receiver) ? frameBindingOf(receiver) : undefined;
  return selected?.keys.length === 0 && bindings.has(selected.binding)
    ? assignment.right
    : undefined;
}

/**
 * The statement written right before the one that holds `node`, in its block or file, where
 * nothing the holding statement runs before `node` may replace the method again (`quietBefore`).
 */
function previousStatement(node: Node): Statement | undefined {
  let statement = node;
  while (!isSourceFile(statement.parent) && !isBlock(statement.parent))
    statement = statement.parent;
  if (!isStatement(statement) || !quietBefore(node, statement)) return undefined;
  const statements: readonly Statement[] = statement.parent.statements;
  return statements[statements.indexOf(statement) - 1];
}

/**
 * Whether `read` runs right after what precedes its statement, with nothing between them that may
 * replace the method again: no function or class lies between them, which would run it later or
 * again, and each operand the statement evaluates before it runs no code (`quietChild`), as an
 * assignment, a call or a member read may.
 */
function quietBefore(read: Node, statement: Statement): boolean {
  for (let node = read; node !== statement; node = node.parent) {
    const { parent } = node;
    if (isFunctionLikeDeclaration(parent) || isClassLikeDeclaration(parent)) return false;
    if (earlierChildren(parent, node).some((child) => !quietChild(child, parent))) return false;
  }
  return true;
}

/**
 * The children of `parent` written before `child`, in the order the language evaluates them; all
 * of them where `child` is none it visits.
 */
function earlierChildren(parent: Node, child: Node): readonly Node[] {
  const children: Node[] = [];
  parent.forEachChild((each) => {
    children.push(each);
  });
  const at = children.indexOf(child);
  return at === -1 ? children : children.slice(0, at);
}

/**
 * A child evaluated before `read` that runs no code: a type, a token or the name a declaration or
 * a property gives, none of which is evaluated, or an operand, or a computed name's, that runs no
 * code (`framedRunsNoCode`).
 */
function quietChild(child: Node, parent: Node): boolean {
  if (isTypeNode(child) || isPunctuationKind(child.kind) || isKeywordKind(child.kind)) return true;
  if (isComputedPropertyName(child)) return framedRunsNoCode(child.expression);
  if ((isVariableDeclaration(parent) || isPropertyAssignment(parent)) && parent.name === child)
    return true;
  return isExpression(child) && framedRunsNoCode(child);
}

/** The written array whose own iterator a source-written function returns, as its sole result. */
function returnedElements(replacement: Expression): ArrayLiteralExpression | undefined {
  const fn = unwrapped(replacement);
  if (!isArrowFunction(fn) && !isFunctionExpression(fn)) return undefined;
  let returned: Expression | undefined = isBlock(fn.body) ? undefined : fn.body;
  if (isBlock(fn.body)) {
    const [only, ...rest] = fn.body.statements;
    returned =
      only !== undefined && rest.length === 0 && isReturnStatement(only)
        ? only.expression
        : undefined;
  }
  const call = returned === undefined ? undefined : unwrapped(returned);
  if (call === undefined || !isCallExpression(call) || call.arguments.length > 0) return undefined;
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const name = iteratorMemberName(member);
  const array = unwrapped(member.expression);
  return name !== undefined && ELEMENTS.has(name) && isArrayLiteralExpression(array)
    ? array
    : undefined;
}

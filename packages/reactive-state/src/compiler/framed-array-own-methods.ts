import {
  type BinaryExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isElementAccessExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isExpressionStatement,
  isFunctionLikeDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isVariableStatement,
  type MethodDeclaration,
  type Node,
  NodeFlags,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import {
  sourceArrayFunction,
  writtenArrayFunction,
  writtenArrayKey,
} from './framed-array-functions.ts';
import { arrayRestBinding } from './framed-array-rest.ts';
import { assignmentPatternDefault } from './framed-assignment-patterns.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { constantValue } from './numbers.ts';

/** The names an array's own methods may take, and what a direct write of one declares. */

export const OWN_METHODS = new Set([
  'at',
  'concat',
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flat',
  'flatMap',
  'forEach',
  'join',
  'map',
  'pop',
  'reduce',
  'reduceRight',
  'shift',
  'slice',
  'some',
  'sort',
  'splice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'toString',
  'with',
]);

export interface ArrayMethodOverride {
  readonly own: boolean;
  readonly value?: Expression | MethodDeclaration;
  /** A data property the descriptor wrote writable: a later write replaces it. */
  readonly writable?: true;
  /** A property the descriptor wrote configurable: a later definition or deletion replaces it. */
  readonly configurable?: true;
}

/**
 * The expression a statement of the block evaluates for certain and may write the array's methods
 * with: an expression statement's, the initializer of the one declaration of a plain name, or the
 * right of an assignment to a plain name that is no write of a method, whose own write is the call
 * or the deletion it holds. What runs after the expression, a pattern's defaults and the setter of a
 * property assigned, is no part of it.
 */
export function definiteExpression(before: Node, root: FrameBinding): Expression | undefined {
  let expression: Expression | undefined;
  if (isExpressionStatement(before)) expression = before.expression;
  else if (isVariableStatement(before)) {
    const [only, ...rest] = before.declarationList.declarations;
    const plain = only !== undefined && rest.length === 0 && isIdentifier(only.name);
    expression = plain ? only.initializer : undefined;
  }
  const value = expression === undefined ? undefined : unwrapped(expression);
  const stored =
    value !== undefined &&
    isBinaryExpression(value) &&
    value.operatorToken.kind === SyntaxKind.EqualsToken &&
    isIdentifier(unwrapped(value.left)) &&
    ownMethodAssignment(value, root) === undefined;
  return stored ? value.right : expression;
}

/** The operators whose right side runs only on some left. */
const SHORT_CIRCUITS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * A descriptor written with `__proto__: object` takes fields from that object, which the compile
 * leaves unread: it may name an accessor, or any attribute.
 */
function setsPrototype(property: ObjectLiteralElementLike): boolean {
  return (
    isPropertyAssignment(property) &&
    !isComputedPropertyName(property.name) &&
    writtenArrayKey(property.name) === '__proto__'
  );
}

/** Whether an assignment gives a member a value, whose setter runs after the right side. */
function setsMember(node: BinaryExpression): boolean {
  const kind = node.operatorToken.kind;
  const assigns = kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
  return assigns && !isIdentifier(unwrapped(node.left));
}

/** Whether a node is a link of an optional chain, which runs what follows `?.` only on some value. */
function inOptionalChain(node: Node): boolean {
  // eslint-disable-next-line no-bitwise -- TypeScript marks the links of an optional chain with this flag.
  return (node.flags & NodeFlags.OptionalChain) !== 0;
}

/**
 * Whether an expression runs whenever its statement does: the statement is an expression or a
 * declaration, and no condition, short circuit, optional chain, default of a pattern, function or
 * inner statement lies between them. A loop, a branch or a switch runs its parts on some paths.
 */
export function evaluatedForSure(node: Node, statement: Node): boolean {
  if (!isExpressionStatement(statement) && !isVariableStatement(statement)) return false;
  for (let at = node; at !== statement; at = at.parent) {
    if (skipsLink(at, statement)) return false;
  }
  return true;
}

/** The default a binding element or a shorthand field of a pattern holds: it runs on some values. */
function patternDefault(node: Node): Node | undefined {
  if (isBindingElement(node)) return node.initializer;
  return isShorthandPropertyAssignment(node) ? node.objectAssignmentInitializer : undefined;
}

/** Whether what holds `at` runs it only on some paths: a branch, a short circuit, a chain, a setter. */
function skipsLink(at: Node, statement: Node): boolean {
  const { parent } = at;
  if (isConditionalExpression(parent)) return at !== parent.condition;
  if (patternDefault(parent) === at) return true;
  if (isBinaryExpression(parent) && parent.right === at)
    return (
      SHORT_CIRCUITS.has(parent.operatorToken.kind) ||
      setsMember(parent) ||
      assignmentPatternDefault(parent)
    );
  if (inOptionalChain(parent) || isFunctionLikeDeclaration(parent)) return true;
  const inner = parent.kind >= SyntaxKind.FirstStatement && parent.kind <= SyntaxKind.LastStatement;
  return inner && parent !== statement;
}

/** What an assignment makes a property: writable and configurable, as a descriptor would say. */
export const PLAIN_PROPERTY = { writable: true, configurable: true } as const;

/**
 * A method a write may have replaced: unproven, with the attributes it has both ways, as it was
 * and as the write leaves it, if it ran. A write of the value alone leaves it as it was.
 */
export function afterPossibleWrite(
  previous: ArrayMethodOverride | undefined,
  written: ArrayMethodOverride | undefined,
): ArrayMethodOverride {
  const writable = previous?.writable === true && written?.writable === true;
  const configurable = previous?.configurable === true && written?.configurable === true;
  return {
    own: false,
    ...(writable && { writable: true as const }),
    ...(configurable && { configurable: true as const }),
  };
}

/** One direct assignment to the native method selected by a call; it creates a plain property. */
export function ownMethodAssignment(
  node: Node,
  root: FrameBinding,
): (ArrayMethodOverride & { readonly key: string }) | undefined {
  if (!isBinaryExpression(node) || node.operatorToken.kind !== SyntaxKind.EqualsToken)
    return undefined;
  const member = unwrapped(node.left);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const key = frameMemberName(member);
  if (key === undefined || !OWN_METHODS.has(key) || arrayIdentity(member.expression) !== root)
    return undefined;
  return {
    key,
    own: sourceArrayFunction(node.right) || knownNonNative(node.right),
    value: node.right,
    ...PLAIN_PROPERTY,
  };
}

/** A written non-callable join makes native toString fall back to the ordinary object tag. */
export function knownNonNative(expression: Expression): boolean {
  const value = unwrapped(expression);
  return (
    writtenArrayFunction(value) ||
    constantValue(value) !== undefined ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    globalPathOf(value)?.join('.') === 'undefined'
  );
}

/** The declaration whose array value a name or a chain of lexical aliases denotes. */
export function arrayIdentity(value: Expression): FrameBinding | undefined {
  let each = unwrapped(value);
  const rest = arrayRestBinding(each);
  if (rest !== undefined) return rest;
  const seen = new Set<FrameBinding>();
  let root: FrameBinding | undefined;
  while (isIdentifier(each)) {
    const selected = frameBindingOf(each);
    if (selected === undefined) return undefined;
    if (selected.keys.length > 0 || seen.has(selected.binding)) return undefined;
    root = selected.binding;
    seen.add(root);
    if (root.initializer === undefined) return root;
    each = unwrapped(root.initializer);
  }
  return isArrayLiteralExpression(each) ? root : undefined;
}

const ACCESSOR_KEYS = new Set(['get', 'set']);

/**
 * A written value function proves a custom implementation; getters and unknown values do not. An
 * attribute the descriptor leaves unsaid stays as the property it redefines had it.
 */
export function descriptorFunction(
  descriptor: Expression | undefined,
  previous?: ArrayMethodOverride,
): ArrayMethodOverride {
  if (descriptor === undefined) return { own: false };
  const value = unwrapped(descriptor);
  if (!isObjectLiteralExpression(value)) return { own: false };
  const writable = attributeKept(descriptorSays(value, 'writable'), previous?.writable);
  const configurable = attributeKept(descriptorSays(value, 'configurable'), previous?.configurable);
  return {
    ...descriptorValue(value),
    ...(writable && { writable: true as const }),
    ...(configurable && { configurable: true as const }),
  };
}

/** An attribute the descriptor says is true, or leaves unsaid where the property it redefines had it. */
function attributeKept(says: AttributeSaid, before: true | undefined): boolean {
  return says === 'true' || (says === 'omitted' && before === true);
}

/** The value a descriptor writes, unproven once an accessor, a spread or an unknown key may follow. */
function descriptorValue(value: ObjectLiteralExpression): ArrayMethodOverride {
  let custom: ArrayMethodOverride = { own: false };
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) custom = { own: false };
    else {
      const key = writtenArrayKey(property.name);
      if (key === undefined || ACCESSOR_KEYS.has(key) || setsPrototype(property))
        custom = { own: false };
      else if (key === 'value')
        custom = isPropertyAssignment(property)
          ? { own: knownNonNative(property.initializer), value: property.initializer }
          : { own: false };
    }
  }
  return custom;
}

type AttributeSaid = 'omitted' | 'other' | 'true';

/**
 * What a descriptor says of an attribute: a literal `true` as its last word, nothing at all, or
 * anything else — `false`, a value the compile cannot read, a spread, a key that is not written out.
 * A writable data property is not an accessor.
 */
function descriptorSays(
  descriptor: ObjectLiteralExpression,
  attribute: 'configurable' | 'writable',
): AttributeSaid {
  let says: AttributeSaid = 'omitted';
  for (const property of descriptor.properties) {
    if (isSpreadAssignment(property)) return 'other';
    const key = writtenArrayKey(property.name);
    if (key === undefined || setsPrototype(property)) return 'other';
    if (attribute === 'writable' && ACCESSOR_KEYS.has(key)) return 'other';
    if (key === attribute)
      says =
        isPropertyAssignment(property) &&
        unwrapped(property.initializer).kind === SyntaxKind.TrueKeyword
          ? 'true'
          : 'other';
  }
  return says;
}

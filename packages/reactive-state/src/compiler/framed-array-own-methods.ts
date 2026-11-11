import {
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type MethodDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { sourceArrayFunction, writtenArrayFunction } from './framed-array-functions.ts';
import { arrayRestBinding } from './framed-array-rest.ts';
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
    writable: true,
    configurable: true,
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

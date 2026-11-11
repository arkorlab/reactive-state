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
import { framedWrittenTargets } from './framed-written-targets.ts';
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
}

/** One direct assignment to the native method selected by a call. */
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

/**
 * The declaration whose array value a name or a chain of lexical aliases denotes; none where a name
 * of the chain is written as a whole elsewhere, and may hold another array than it was given.
 */
export function arrayIdentity(value: Expression): FrameBinding | undefined {
  let each = unwrapped(value);
  const rest = arrayRestBinding(each);
  if (rest !== undefined) return rest;
  const seen = new Set<FrameBinding>();
  let root: FrameBinding | undefined;
  while (isIdentifier(each)) {
    const selected = frameBindingOf(each);
    if (selected === undefined) return undefined;
    if (selected.keys.length > 0 || seen.has(selected.binding) || reassigned(selected.binding))
      return undefined;
    root = selected.binding;
    seen.add(root);
    if (root.initializer === undefined) return root;
    each = unwrapped(root.initializer);
  }
  return isArrayLiteralExpression(each) ? root : undefined;
}

const REASSIGNED = new WeakMap<FrameBinding, boolean>();

/** Whether the file writes a binding as a whole: an assignment, a destructuring target, a loop head. */
function reassigned(binding: FrameBinding): boolean {
  const known = REASSIGNED.get(binding);
  if (known !== undefined) return known;
  let found = false;
  const pending: Node[] = [binding.getSourceFile()];
  for (let node = pending.pop(); node !== undefined && !found; node = pending.pop()) {
    found = framedWrittenTargets(node).some((target) => {
      const name = unwrapped(target);
      const selected = isIdentifier(name) ? frameBindingOf(name) : undefined;
      return selected?.keys.length === 0 && selected.binding === binding;
    });
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  REASSIGNED.set(binding, found);
  return found;
}

import {
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type MethodDeclaration,
  type Node,
  type SourceFile,
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
  const followed = followedIdentity(value);
  return followed.written ? undefined : followed.root;
}

/**
 * Whether a write to a member of `value` may write the array `root`: a name of its chain that is
 * written as a whole elsewhere may hold any array, and so may its member be one of the array's.
 */
export function mayBeArray(value: Expression, root: FrameBinding): boolean {
  const followed = followedIdentity(value);
  return followed.written || followed.root === root;
}

interface FollowedIdentity {
  readonly root: FrameBinding | undefined;
  /** Whether a name of the chain is written as a whole. */
  readonly written: boolean;
}

/** The chain of lexical aliases a value follows to an array's declaration, and what it passes. */
function followedIdentity(value: Expression): FollowedIdentity {
  let each = unwrapped(value);
  const rest = arrayRestBinding(each);
  if (rest !== undefined) return { root: rest, written: false };
  const seen = new Set<FrameBinding>();
  let root: FrameBinding | undefined;
  let written = false;
  while (isIdentifier(each)) {
    const selected = frameBindingOf(each);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return { root: undefined, written };
    root = selected.binding;
    written ||= writtenWhole(root.getSourceFile()).has(root);
    seen.add(root);
    if (root.initializer === undefined) return { root, written };
    each = unwrapped(root.initializer);
  }
  return { root: isArrayLiteralExpression(each) ? root : undefined, written };
}

const WRITTEN_WHOLE = new WeakMap<SourceFile, ReadonlySet<FrameBinding>>();

/**
 * The bindings a file writes as a whole — by an assignment, a destructuring target or a loop head —
 * found in one walk of the file.
 */
function writtenWhole(file: SourceFile): ReadonlySet<FrameBinding> {
  const known = WRITTEN_WHOLE.get(file);
  if (known !== undefined) return known;
  const found = new Set<FrameBinding>();
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const target of framedWrittenTargets(node)) {
      const name = unwrapped(target);
      const selected = isIdentifier(name) ? frameBindingOf(name) : undefined;
      if (selected?.keys.length === 0) found.add(selected.binding);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  WRITTEN_WHOLE.set(file, found);
  return found;
}

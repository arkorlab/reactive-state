import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  isExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { ownerKeyFirst } from './class-key-order.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner, exportedDeclaration, repeatsAround } from './framed-array-mutations.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { repeatedFrameRead } from './framed-writes.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Native fill contributes no inserted value where written bounds prove an empty range. */

interface FillContext {
  readonly receiver: Expression;
  readonly root: FrameBinding;
  readonly call: CallExpression;
  readonly borrowed: boolean;
  readonly identity: (value: Expression) => FrameBinding | undefined;
}

/** Equal bounds need no array length; other clamping requires a fresh unexposed constant literal. */
export function emptyArrayFill(given: readonly Expression[], context: FillContext): boolean {
  if (given.some((each) => isSpreadElement(each))) return false;
  const start = fillBound(given[1], 0);
  const end = fillBound(given[2], undefined);
  const equalOrReversed =
    start !== undefined && end !== undefined && sameSide(start, end) && end <= start;
  if (equalOrReversed && context.borrowed) return true;
  const length = unexposedLength(context);
  if (length === undefined || start === undefined) return false;
  if (equalOrReversed) return true;
  if (exportedBefore(context)) return false;
  const stop = fillBound(given[2], length);
  return stop !== undefined && relativeBound(start, length) >= relativeBound(stop, length);
}

/**
 * Whether an importing module can change the length of the array before the fill runs: the module
 * exports it where it is declared, and the fill is in a body that runs later.
 */
function exportedBefore(context: FillContext): boolean {
  return (
    exportedDeclaration(context.root) &&
    executionOwner(context.call) !== executionOwner(context.root)
  );
}

/** Monotone bounds on one side of zero clamp together without knowing the receiver length. */
function sameSide(start: number, end: number): boolean {
  return (start >= 0 && end >= 0) || (start < 0 && end < 0);
}

/** Written primitive arguments retain native integer conversion; unknown conversions stay opaque. */
function fillBound(
  value: Expression | undefined,
  fallback: number | undefined,
): number | undefined {
  if (value === undefined) return fallback;
  const actual = unwrapped(value);
  if (globalPathOf(actual)?.join('.') === 'undefined') return fallback;
  if (actual.kind === SyntaxKind.NullKeyword || actual.kind === SyntaxKind.FalseKeyword) return 0;
  if (actual.kind === SyntaxKind.TrueKeyword) return 1;
  const primitive = constantValue(actual);
  return primitive === undefined ? undefined : Math.trunc(Number(primitive)) || 0;
}

/** Negative bounds count back from length; both directions clamp to the actual array interval. */
function relativeBound(value: number, length: number): number {
  return value < 0 ? Math.max(length + value, 0) : Math.min(value, length);
}

/** Only a whole constant's unchanged literal origin establishes the length used by a native fill. */
function unexposedLength(context: FillContext): number | undefined {
  const { root } = context;
  if (!isVariableDeclaration(root) || !isIdentifier(root.name) || root.initializer === undefined)
    return undefined;
  const statement = root.parent.parent;
  if (
    !isVariableStatement(statement) ||
    !/^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
  )
    return undefined;
  const array = unwrapped(root.initializer);
  if (!isArrayLiteralExpression(array) || array.elements.some((each) => isSpreadElement(each)))
    return undefined;
  const pending: Node[] = [root.getSourceFile()];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeOnly(at)) continue;
    if (isIdentifier(at) && lengthExposed(at, context)) return undefined;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return array.elements.length;
}

/**
 * Earlier uses, argument effects and possible other-owner reads can change the captured length: a
 * use in what a destructuring pattern destructures runs before a fill in the pattern's defaults,
 * though it is written after it, and a use in a computed key of a class runs before a fill in one
 * of the class's static initializers.
 */
function lengthExposed(name: Identifier, context: FillContext): boolean {
  if (!readsBinding(name) || context.identity(name) !== context.root) return false;
  const selected = frameBindingOf(name);
  if (name === selected?.binding.name || name === unwrapped(context.receiver)) return false;
  const owner = executionOwner(context.call);
  if (executionOwner(name) !== owner) return true;
  if (
    (name.pos > context.call.end || destructuredFirst(context.call, name)) &&
    !destructuredFirst(name, context.call) &&
    !ownerKeyFirst(name, context.call) &&
    !repeatedFrameRead(name, context.call, context.root, owner) &&
    !repeatsAround(owner, context.root)
  )
    return false;
  return !constantAliasUse(name, context);
}

/** Whole constant aliases preserve the same array identity before an otherwise unexposed fill. */
function constantAliasUse(name: Identifier, context: FillContext): boolean {
  const { at, parent } = useOf(name);
  if (
    !isExpression(at) ||
    !isVariableDeclaration(parent) ||
    parent.initializer !== at ||
    !isIdentifier(parent.name)
  )
    return false;
  const statement = parent.parent.parent;
  return (
    isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile())) &&
    context.identity(parent.name) === context.root
  );
}

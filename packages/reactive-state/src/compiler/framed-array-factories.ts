import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Node,
  type Statement,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isElementAccessExpression,
  isExpression,
  isExpressionStatement,
  isIdentifier,
  isReturnStatement,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietOperand } from './framed-quiet-operands.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Native array factories preserve the supplied values before a later numeric selection. */
const OF = new Set(['Array.of']);
const FROM = new Set(['Array.from']);

/**
 * A known native of stores each argument; an unmapped from copies source elements, which may be
 * Errors where no reader reads the source and the declared element type admits one
 * (`framedCopiedUnread`).
 */
export function arrayFactoryViews(
  call: CallExpression,
  index: number | undefined,
  stable: (value: Expression, at?: Expression) => boolean,
): readonly ArrayElementView[] | undefined {
  if (framedNativeConstructor(call.expression, OF)) return ofViews(call, index);
  if (!framedNativeConstructor(call.expression, FROM)) return undefined;
  const prefix = framedArgumentPrefix(call);
  const source = prefix.values[0];
  if (source === undefined || prefix.unknown) return undefined;
  const mapper = prefix.values[1];
  if (mapper !== undefined && globalPathOf(unwrapped(mapper))?.join('.') !== 'undefined')
    return undefined;
  return ownIterator(call, source, stable)
    ? undefined
    : [{ value: source, index, capture: call, copiedFrom: { call, depth: 0 } }];
}

/** Fixed positions exclude arguments beyond the selected prefix or before a selected suffix. */
function ofViews(call: CallExpression, index: number | undefined): readonly ArrayElementView[] {
  const limit = index !== undefined && index >= 0 ? index + 1 : Infinity;
  const prefix = framedArgumentPrefix(call, call.arguments, limit);
  if (!prefix.unknown) return knownArguments(call, prefix.values, index);
  if (index !== undefined && index < 0) {
    const selected = knownSuffix(call, index);
    if (selected !== undefined)
      return [{ value: selected, index: undefined, element: true, capture: call }];
  }
  const earlier = index !== undefined && index >= 0 ? prefix.values.length : 0;
  return possibleArguments(call, earlier);
}

/** An expanded argument list retains its exact selected position. */
function knownArguments(
  call: CallExpression,
  args: readonly Expression[],
  index: number | undefined,
): readonly ArrayElementView[] {
  const position = index !== undefined && index < 0 ? args.length + index : index;
  if (position !== undefined && (position < 0 || position >= args.length)) return [];
  const values = position === undefined ? args : args.slice(position, position + 1);
  return values.map((value) => ({ value, index: undefined, element: true, capture: call }));
}

/** A trailing known argument suffix fixes an end-relative position despite earlier unknown spreads. */
function knownSuffix(call: CallExpression, index: number): Expression | undefined {
  for (let start = call.arguments.length - 1; start >= 0; start--) {
    const suffix = framedArgumentPrefix(call, call.arguments.slice(start), Infinity);
    if (suffix.unknown) return undefined;
    const position = suffix.values.length + index;
    if (position >= 0) return suffix.values[position];
  }
  return undefined;
}

interface ArgumentWork {
  readonly value: Expression;
  readonly seen: ReadonlySet<Node>;
}

/** Unresolved positions retain later possibilities while excluding every definitely earlier value. */
function possibleArguments(call: CallExpression, earlier: number): readonly ArrayElementView[] {
  const pending: ArgumentWork[] = call.arguments
    .toReversed()
    .map((value) => ({ value, seen: new Set() }));
  const found: ArrayElementView[] = [];
  let remaining = earlier;
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = at.value;
    if (!isSpreadElement(value)) {
      if (remaining > 0) remaining -= 1;
      else found.push({ value, index: undefined, element: true, capture: call });
      continue;
    }
    const spread = value.expression;
    const literal = at.seen.has(spread) ? undefined : framedAppliedArguments(call, spread);
    if (literal === undefined) {
      remaining = 0;
      found.push({ value: spread, index: undefined, capture: call });
    } else {
      const seen = new Set(at.seen).add(spread);
      pending.push(...literal.toReversed().map((each) => ({ value: each, seen })));
    }
  }
  return found;
}

/** A native Array.from consumes a known own iterator rather than the array's indexed slots. */
function ownIterator(
  call: CallExpression,
  source: Expression,
  stable: (value: Expression, at?: Expression) => boolean,
): boolean {
  const array = literalSource(source);
  const statement = closedStatement(call);
  if (array === undefined || statement === undefined || !isBlock(statement.parent)) return false;
  const statements = statement.parent.statements;
  const previous = statements[statements.indexOf(statement) - 1];
  if (previous === undefined || !isExpressionStatement(previous)) return false;
  const assignment = unwrapped(previous.expression);
  if (!isBinaryExpression(assignment) || assignment.operatorToken.kind !== SyntaxKind.EqualsToken)
    return false;
  const member = unwrapped(assignment.left);
  return (
    isElementAccessExpression(member) &&
    globalPathOf(unwrapped(member.argumentExpression))?.join('.') === 'Symbol.iterator' &&
    literalSource(member.expression) === array &&
    sourceArrayFunction(assignment.right) &&
    stable(source, assignment)
  );
}

/**
 * Whole constant aliases, past quiet commas (`framedQuietOperand`), retain a fresh native array
 * identity without guessing arbitrary objects.
 */
function literalSource(node: Expression): ArrayLiteralExpression | undefined {
  let value = framedQuietOperand(node);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return undefined;
    const binding = selected.binding;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    seen.add(binding);
    value = framedQuietOperand(binding.initializer);
  }
  return isArrayLiteralExpression(value) ? value : undefined;
}

/** Property selection may follow the factory, but unrelated application evaluation loses the proof. */
function closedStatement(call: CallExpression): Statement | undefined {
  let node: Node = call;
  for (;;) {
    const { at, parent } = useOf(node);
    if (!isExpression(at)) return undefined;
    if (
      (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
      parent.expression === at
    ) {
      node = parent;
      continue;
    }
    return (isReturnStatement(parent) || isExpressionStatement(parent)) && parent.expression === at
      ? parent
      : undefined;
  }
}

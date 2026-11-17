import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { patternSymbolName } from './pattern-writes.ts';
import { readsBinding } from './scope.ts';
import { constFollowedValue, unmutatedTuple } from './tuple-spreads.ts';

/**
 * Call arguments mutated beside a method's receiver: slot-aligned spread expansion, `.bind`
 * chain unwrapping, and direct, borrowed or bound global and method invocations.
 */

export interface CallArgument {
  readonly expression: Expression;
  readonly spread: boolean;
}

export interface SlotArgument {
  readonly expression: Expression;
  readonly index: number;
  readonly spread: boolean;
}

export interface UnwrappedBind {
  readonly boundArgs: readonly CallArgument[];
  readonly boundThis: Expression | undefined;
  readonly hasBind: boolean;
  readonly target: Expression;
}

/** A borrowed or bound method's name, receiver and arguments, in the order it is given them. */
export interface LentMethod {
  readonly given: readonly CallArgument[];
  readonly method: string;
  readonly receiver: Expression;
}

interface GlobalCall {
  readonly given: readonly CallArgument[];
  readonly path: string;
}

/** Wraps ordinary and spread call-site argument nodes into uniform `CallArgument` descriptors. */
export function asCallArguments(list: readonly Expression[]): readonly CallArgument[] {
  return list.map((each) => {
    return isSpreadElement(each)
      ? { expression: each.expression, spread: true }
      : { expression: each, spread: false };
  });
}

/** Peels `.bind(...)` chains off `node`, preserving the first bound `this` and prebound arguments. */
export function unwrapBoundTarget(node: Expression): UnwrappedBind {
  const segments: (readonly CallArgument[])[] = [];
  const seen = new Set<Expression>();
  let current = followedValue(node);
  let boundThis: Expression | undefined;
  while (isCallExpression(current) && !seen.has(current)) {
    seen.add(current);
    const binder = followedValue(current.expression);
    if (
      (!isPropertyAccessExpression(binder) && !isElementAccessExpression(binder)) ||
      memberNameOf(binder) !== 'bind'
    ) {
      break;
    }
    boundThis = current.arguments[0];
    segments.push(asCallArguments(current.arguments.slice(1)));
    current = followedValue(binder.expression);
  }
  return {
    boundArgs: segments.length === 0 ? [] : segments.toReversed().flat(),
    boundThis,
    hasBind: segments.length > 0,
    target: current,
  };
}

/** A borrowed (`.call`, `.apply`, `Reflect.apply`) or `.bind`-wrapped method call on its receiver. */
export function lentMethodOf(call: CallExpression): LentMethod | undefined {
  return borrowedMethodOf(call) ?? boundMethodOf(call);
}

/** A direct, aliased, borrowed or bound invocation of a global function and its arguments. */
export function globalCallOf(call: CallExpression): GlobalCall | undefined {
  const callee = followedValue(call.expression);
  const direct = globalPathOf(callee)?.join('.');
  if (direct === 'Reflect.apply') {
    const [first, , third] = call.arguments;
    return first === undefined ? undefined : globalFromTarget(first, appliedArguments(third));
  }
  const member =
    isPropertyAccessExpression(callee) || isElementAccessExpression(callee)
      ? memberNameOf(callee)
      : undefined;
  if (
    (member === 'call' || member === 'apply') &&
    (isPropertyAccessExpression(callee) || isElementAccessExpression(callee))
  ) {
    const trailing =
      member === 'apply'
        ? appliedArguments(call.arguments[1])
        : asCallArguments(call.arguments.slice(1));
    const borrowed = globalFromTarget(callee.expression, trailing);
    if (borrowed !== undefined) {
      return borrowed;
    }
  }
  return direct === undefined
    ? boundGlobalCall(callee, asCallArguments(call.arguments))
    : { given: asCallArguments(call.arguments), path: direct };
}

/** Resolves `fn` (possibly `.bind`-wrapped) to a global function path with `trailing` arguments. */
function globalFromTarget(
  fn: Expression,
  trailing: readonly CallArgument[],
): GlobalCall | undefined {
  const bound = unwrapBoundTarget(fn);
  const path = globalPathOf(bound.target)?.join('.');
  return path === undefined ? undefined : { given: [...bound.boundArgs, ...trailing], path };
}

/** Selects the argument at `slot` after expanding known tuple spreads, or a covering spread holder. */
export function argumentAt(given: readonly CallArgument[], slot: number): Expression | undefined {
  return slotArguments(given, slot)[0]?.expression;
}

/** Positional and unexpanded-spread arguments that can supply `slot`. */
export function slotArguments(
  given: readonly CallArgument[],
  slot: number,
): readonly SlotArgument[] {
  const candidates: SlotArgument[] = [];
  const stack = given.toReversed();
  const seen = new Set<ArrayLiteralExpression>();
  let index = 0;
  let shifted = false;
  for (let current = stack.pop(); current !== undefined && index <= slot; current = stack.pop()) {
    if (current.spread) {
      if (!expandTupleSpread(current.expression, seen, stack)) {
        candidates.push({ expression: current.expression, index, spread: true });
        shifted = true;
      }
      continue;
    }
    if ((shifted || index === slot) && current.expression.kind !== SyntaxKind.OmittedExpression) {
      candidates.push({ expression: current.expression, index, spread: false });
    }
    index += 1;
  }
  return candidates;
}

/** Pushes an unchanged array-literal spread's elements onto `stack` when statically known. */
function expandTupleSpread(
  expression: Expression,
  seen: Set<ArrayLiteralExpression>,
  stack: CallArgument[],
): boolean {
  const tuple = unmutatedTuple(expression);
  if (tuple === undefined || seen.has(tuple)) {
    return false;
  }
  seen.add(tuple);
  stack.push(...asCallArguments(tuple.elements).toReversed());
  return true;
}

/** A global function bound through `.bind(...)` chains and later called with trailing arguments. */
function boundGlobalCall(
  callee: Expression,
  trailing: readonly CallArgument[],
): GlobalCall | undefined {
  const bound = unwrapBoundTarget(callee);
  const path = bound.hasBind ? globalPathOf(bound.target)?.join('.') : undefined;
  return path === undefined ? undefined : { given: [...bound.boundArgs, ...trailing], path };
}

/** The method `call` borrows via `.call`, `.apply` or `Reflect.apply`, with its target receiver. */
function borrowedMethodOf(call: CallExpression): LentMethod | undefined {
  const callee = followedValue(call.expression);
  const [first, second] = call.arguments;
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    return first === undefined
      ? undefined
      : lentTargetOf(first, second, appliedArguments(call.arguments[2]));
  }
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) {
    return undefined;
  }
  const member = memberNameOf(callee);
  if (member !== 'call' && member !== 'apply') {
    return undefined;
  }
  const given =
    member === 'apply' ? appliedArguments(second) : asCallArguments(call.arguments.slice(1));
  return lentTargetOf(callee.expression, first, given);
}

/** The method `call` invokes through `.bind(...)` and the receiver its first bind fixed `this` to. */
function boundMethodOf(call: CallExpression): LentMethod | undefined {
  const bound = unwrapBoundTarget(call.expression);
  return bound.hasBind
    ? lentOf(bound.target, bound.boundThis, [
        ...bound.boundArgs,
        ...asCallArguments(call.arguments),
      ])
    : undefined;
}

/** Resolves `fn` (possibly `.bind`-wrapped) to a lent method on its effective receiver. */
function lentTargetOf(
  fn: Expression,
  receiver: Expression | undefined,
  trailing: readonly CallArgument[],
): LentMethod | undefined {
  const bound = unwrapBoundTarget(fn);
  const effectiveReceiver = bound.hasBind ? bound.boundThis : receiver;
  return lentOf(bound.target, effectiveReceiver, [...bound.boundArgs, ...trailing]);
}

/** Packages `method` and `receiver` into a `LentMethod` when the member name is statically known. */
function lentOf(
  method: Expression | undefined,
  receiver: Expression | undefined,
  given: readonly CallArgument[],
): LentMethod | undefined {
  const name = memberNameOf(method);
  return name === undefined || receiver === undefined
    ? undefined
    : { given, method: name, receiver };
}

/** The arguments written for `apply`, or an unknown-list spread where the code does not write them apart. */
export function appliedArguments(node: Expression | undefined): readonly CallArgument[] {
  if (node === undefined) {
    return [];
  }
  const value = constFollowedValue(node);
  if (value.kind === SyntaxKind.NullKeyword || globalPathOf(value)?.join('.') === 'undefined') {
    return [];
  }
  const tuple = unmutatedTuple(node);
  return tuple === undefined
    ? [{ expression: unwrapped(node), spread: true }]
    : asCallArguments(tuple.elements);
}

/** The name `node` reads of what it reads it of, by its name or by text in brackets; none of another. */
export function memberNameOf(node: Expression | undefined): string | undefined {
  const value = node === undefined ? undefined : unwrapped(node);
  if (value !== undefined && isPropertyAccessExpression(value)) {
    return value.name.text;
  }
  return value !== undefined && isElementAccessExpression(value)
    ? (literalName(value) ?? patternSymbolName(value.argumentExpression))
    : undefined;
}

/** What a name is declared of, through whole-identifier variable initializers; itself otherwise. */
export function followedValue(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && readsBinding(value) && !seen.has(value)) {
    seen.add(value);
    const selected = frameBindingOf(value);
    const declared =
      selected?.keys.length === 0 && isVariableDeclaration(selected.binding)
        ? selected.binding.initializer
        : undefined;
    if (declared === undefined) {
      break;
    }
    value = unwrapped(declared);
  }
  return value;
}

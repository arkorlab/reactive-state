import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type NewExpression,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { arrayError } from './framed-arrays.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedOwnRegExpMethod, framedRegExpReceiver } from './framed-regexp-methods.ts';
import { framedRegExpPattern } from './framed-regexp-pattern.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';

/** Native RegExp converts its consumed pattern and flags, including Error words and array elements. */

const PATTERN = new Set(['RegExp']);
const REFLECT_APPLY = new Set(['Reflect.apply']);
const REFLECT_CONSTRUCT = new Set(['Reflect.construct']);
const PATTERN_METHODS = new Set(['compile', 'exec', 'test']);
const BORROWED = { callSlots: 3 } as const;

interface PatternArguments {
  readonly given: readonly Expression[];
  readonly applied: Expression | undefined;
}

interface PatternWords {
  readonly error: (value: Expression) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** A native construction or borrowed call retains the same two text argument positions. */
export function framedRegExpText(
  node: Node,
  error: (value: Expression) => boolean,
  typed: (value: Expression) => boolean,
): boolean {
  if (!isCallExpression(node) && !isNewExpression(node)) return false;
  const words = { error, typed };
  const native = framedNativeArguments(node, PATTERN);
  if (native !== undefined) {
    if (native.args === undefined) {
      return native.applied !== undefined && arrayError(native.applied, words, node);
    }
    return (
      framedRegExpPattern(node, native.args, native.constructed, error) ||
      convertedArguments(node, native.args, words)
    );
  }
  if (!isCallExpression(node)) return false;
  const method = patternMethod(node);
  const borrowed = method ?? patternArguments(node);
  if (borrowed === undefined) return false;
  const limit = method?.limit ?? 2;
  if (borrowed.applied === undefined) return convertedArguments(node, borrowed.given, words, limit);
  const args = framedAppliedArguments(node, borrowed.applied);
  return args === undefined
    ? arrayError(borrowed.applied, words, node)
    : convertedArguments(node, args, words, limit);
}

/** A resolved prefix ignores later values; unresolved spreads keep only possibly consumed entries. */
function convertedArguments(
  call: CallExpression | NewExpression,
  args: readonly Expression[],
  words: PatternWords,
  limit = 2,
): boolean {
  return framedConsumedArguments(call, args, limit).some((argument) => {
    const spread = isSpreadElement(argument);
    const value = spread ? argument.expression : argument;
    return (!spread && words.error(value)) || arrayError(value, words, call);
  });
}

/** Existing ordinary borrowing and reflected construction wrappers retain the same consumed slots. */
function patternArguments(call: CallExpression): PatternArguments | undefined {
  const borrowed = borrowedTextCall(call);
  if (borrowed !== undefined) return borrowedPatternArguments(call, borrowed);
  const callee = unwrapped(call.expression);
  if (framedNativeConstructor(callee, REFLECT_CONSTRUCT)) {
    return constructTargetArguments(knownPrefix(call, 2));
  }
  if (framedNativeConstructor(callee, REFLECT_APPLY)) {
    const values = knownPrefix(call, BORROWED.callSlots);
    const [target, receiver, applied] = values ?? [];
    return target !== undefined &&
      receiver !== undefined &&
      framedNativeConstructor(target, PATTERN)
      ? { given: [], applied }
      : undefined;
  }
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
  const method = frameMemberName(callee);
  if (
    (method !== 'call' && method !== 'apply') ||
    !framedNativeConstructor(callee.expression, PATTERN)
  )
    return undefined;
  const limit = method === 'call' ? BORROWED.callSlots : 2;
  const values = knownPrefix(call, limit);
  if (values?.[0] === undefined) return undefined;
  return method === 'call'
    ? { given: values.slice(1), applied: undefined }
    : { given: [], applied: values[1] };
}

/** Resolves borrowed `RegExp` calls and borrowed `Reflect.construct(RegExp, ...)` wrappers. */
function borrowedPatternArguments(
  call: CallExpression,
  borrowed: NonNullable<ReturnType<typeof borrowedTextCall>>,
): PatternArguments | undefined {
  const path = borrowed.path.join('.');
  if (path === 'RegExp') return borrowed;
  if (path !== 'Reflect.construct') return undefined;
  const list =
    borrowed.applied === undefined
      ? borrowed.given
      : framedAppliedArguments(call, borrowed.applied);
  if (list === undefined) return undefined;
  const prefix = framedArgumentPrefix(call, list, 2);
  const values =
    prefix.unknown || (prefix.alternatives?.length ?? 0) > 0 ? undefined : prefix.values;
  return constructTargetArguments(values);
}

/** Extracts the argument list passed to `Reflect.construct` when its target is native `RegExp`. */
function constructTargetArguments(
  values: readonly Expression[] | undefined,
): PatternArguments | undefined {
  const [target, applied] = values ?? [];
  return target !== undefined && applied !== undefined && framedNativeConstructor(target, PATTERN)
    ? { given: [], applied }
    : undefined;
}

/** Only an unambiguous prefix can establish where a borrowed receiver or apply list sits. */
function knownPrefix(call: CallExpression, limit: number): readonly Expression[] | undefined {
  const prefix = framedArgumentPrefix(call, call.arguments, limit);
  return prefix.unknown || (prefix.alternatives?.length ?? 0) > 0 ? undefined : prefix.values;
}

/** Native pattern methods convert their first input; compile also converts its flags. */
function patternMethod(
  call: CallExpression,
): (PatternArguments & { readonly limit: number }) | undefined {
  const borrowed = borrowedTextCall(call);
  if (
    borrowed?.path.slice(0, -1).join('.') === 'RegExp.prototype' &&
    PATTERN_METHODS.has(borrowed.path.at(-1) ?? '')
  )
    return { ...borrowed, limit: borrowed.path.at(-1) === 'compile' ? 2 : 1 };
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const method = frameMemberName(member);
  if (
    !PATTERN_METHODS.has(method ?? '') ||
    !framedRegExpReceiver(member.expression) ||
    framedOwnRegExpMethod(call)
  )
    return undefined;
  return { given: call.arguments, applied: undefined, limit: method === 'compile' ? 2 : 1 };
}

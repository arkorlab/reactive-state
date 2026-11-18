import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { arrayError } from './framed-arrays.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedOwnRegExpMethod, framedRegExpReceiver } from './framed-regexp-methods.ts';
import { framedRegExpPattern } from './framed-regexp-pattern.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';

/** Native RegExp converts its consumed pattern and flags, including Error words and array elements. */

const PATTERN = new Set(['RegExp']);
const REFLECT_APPLY = 'Reflect.apply';
const REFLECT_CONSTRUCT = 'Reflect.construct';
const PATTERN_METHODS = new Set(['compile', 'exec', 'test']);
const BORROWED = { callSlots: 3 } as const;

interface PatternArguments {
  readonly applied: Expression | undefined;
  readonly constructed?: boolean;
  readonly given: readonly Expression[];
  readonly newTarget?: Expression | null;
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
    return evaluateConstructorArguments(
      node,
      { applied: native.applied, args: native.args, constructed: native.constructed },
      words,
    );
  }
  if (!isCallExpression(node)) return false;
  const method = patternMethod(node);
  if (method !== undefined) return evaluateMethodArguments(node, method, words);
  const borrowed = patternArguments(node);
  if (borrowed === undefined) return false;
  const args =
    borrowed.applied === undefined
      ? borrowed.given
      : framedAppliedArguments(node, borrowed.applied);
  return evaluateConstructorArguments(
    node,
    {
      applied: borrowed.applied,
      args,
      constructed: borrowed.constructed === true,
      newTarget: borrowed.newTarget,
    },
    words,
  );
}

/** Runs both `[Symbol.match]` pattern checks and ordinary argument conversions on `RegExp` calls. */
function evaluateConstructorArguments(
  call: CallExpression | NewExpression,
  target: {
    readonly applied: Expression | undefined;
    readonly args: readonly Expression[] | undefined;
    readonly constructed: boolean;
    readonly newTarget?: Expression | null;
  },
  words: PatternWords,
): boolean {
  if (target.args === undefined) {
    return target.applied !== undefined && arrayError(target.applied, words, call);
  }
  return (
    framedRegExpPattern(call, target.args, target, words.error) ||
    convertedArguments(call, target.args, words)
  );
}

/** Evaluates consumed argument conversions for native `RegExp.prototype` pattern methods. */
function evaluateMethodArguments(
  call: CallExpression,
  method: PatternArguments & { readonly limit: number },
  words: PatternWords,
): boolean {
  if (method.applied === undefined)
    return convertedArguments(call, method.given, words, method.limit);
  const args = framedAppliedArguments(call, method.applied);
  return args === undefined
    ? arrayError(method.applied, words, call)
    : convertedArguments(call, args, words, method.limit);
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
  if (nativeCallable(callee, REFLECT_CONSTRUCT))
    return constructListArguments(call, call.arguments);
  if (nativeCallable(callee, REFLECT_APPLY)) return reflectedApplyArguments(call);
  return memberBorrowedArguments(call, callee);
}

/** Resolves aliased or destructured `Reflect.apply` targeting `RegExp` or `Reflect.construct`. */
function reflectedApplyArguments(call: CallExpression): PatternArguments | undefined {
  const values = knownPrefix(call, BORROWED.callSlots);
  const [target, receiver, applied] = values ?? [];
  if (target === undefined || receiver === undefined) return undefined;
  if (framedNativeConstructor(target, PATTERN)) return { applied, constructed: false, given: [] };
  if (!nativeCallable(target, REFLECT_CONSTRUCT) || applied === undefined) return undefined;
  const list = framedAppliedArguments(call, applied);
  return list === undefined ? undefined : constructListArguments(call, list);
}

/** Resolves `.call` and `.apply` on aliased `RegExp` or destructured `Reflect.construct`. */
function memberBorrowedArguments(
  call: CallExpression,
  callee: Expression,
): PatternArguments | undefined {
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
  const method = frameMemberName(callee);
  if (method !== 'call' && method !== 'apply') return undefined;
  if (nativeCallable(callee.expression, REFLECT_CONSTRUCT)) {
    return borrowedConstructMemberArguments(call, method);
  }
  if (!framedNativeConstructor(callee.expression, PATTERN)) return undefined;
  const limit = method === 'call' ? BORROWED.callSlots : 2;
  const values = knownPrefix(call, limit);
  if (values?.[0] === undefined) return undefined;
  return method === 'call'
    ? { applied: undefined, constructed: false, given: values.slice(1) }
    : { applied: values[1], constructed: false, given: [] };
}

/** Extracts `Reflect.construct` arguments invoked through `.call` or `.apply`. */
function borrowedConstructMemberArguments(
  call: CallExpression,
  method: 'apply' | 'call',
): PatternArguments | undefined {
  if (method === 'call') {
    const receiver = knownPrefix(call, 1)?.[0];
    return receiver === undefined
      ? undefined
      : constructListArguments(call, call.arguments.slice(1));
  }
  const values = knownPrefix(call, 2);
  const list =
    values?.[0] !== undefined && values[1] !== undefined
      ? framedAppliedArguments(call, values[1])
      : undefined;
  return list === undefined ? undefined : constructListArguments(call, list);
}

/** Resolves borrowed `RegExp` calls and borrowed `Reflect.construct(RegExp, ...)` wrappers. */
function borrowedPatternArguments(
  call: CallExpression,
  borrowed: NonNullable<ReturnType<typeof borrowedTextCall>>,
): PatternArguments | undefined {
  const path = borrowed.path.join('.');
  if (path === 'RegExp') return { ...borrowed, constructed: false };
  if (path !== REFLECT_CONSTRUCT) return undefined;
  const list =
    borrowed.applied === undefined
      ? borrowed.given
      : framedAppliedArguments(call, borrowed.applied);
  return list === undefined ? undefined : constructListArguments(call, list);
}

/** Extracts `[target, args, newTarget?]` for `Reflect.construct` when `target` is native `RegExp`. */
function constructListArguments(
  call: CallExpression,
  list: readonly Expression[],
): PatternArguments | undefined {
  const prefix = framedArgumentPrefix(call, list, 2);
  if (prefix.unknown || (prefix.alternatives?.length ?? 0) > 0) return undefined;
  const [target, applied] = prefix.values;
  if (target === undefined || applied === undefined || !framedNativeConstructor(target, PATTERN)) {
    return undefined;
  }
  const full = framedArgumentPrefix(call, list, Infinity);
  const newTarget = full.unknown || (full.alternatives?.length ?? 0) > 0 ? null : full.values[2];
  return { applied, constructed: true, given: [], newTarget };
}

/** Matches a native global path through whole `const` aliases and `const` object destructuring. */
function nativeCallable(node: Expression, expected: string): boolean {
  if (framedNativeConstructor(node, new Set([expected]))) return true;
  const value = unwrapped(node);
  if (!isIdentifier(value)) return false;
  const selected = frameBindingOf(value);
  const binding = selected?.binding;
  if (
    selected === undefined ||
    selected.keys.length === 0 ||
    binding === undefined ||
    !isVariableDeclaration(binding) ||
    binding.initializer === undefined ||
    !isVariableDeclarationList(binding.parent) ||
    !/^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
  ) {
    return false;
  }
  const rootPath = globalPathOf(unwrapped(binding.initializer));
  return rootPath !== undefined && [...rootPath, ...selected.keys].join('.') === expected;
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

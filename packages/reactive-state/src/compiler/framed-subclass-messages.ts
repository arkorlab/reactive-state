import {
  type CallExpression,
  type ConstructorDeclaration,
  type Expression,
  isCallExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isExpressionStatement,
  isNewExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import {
  type ForwardedValue,
  framedRestIndex,
  framedSlotValues,
  type Slots,
} from './framed-constructor-parameters.ts';
import { framedSubclassChain } from './framed-constructors.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietSource } from './framed-native-evaluation.ts';

/** What a construction of a local Error subclass passes on to its native base's message. */

const ALL_ARGUMENTS = { limit: Infinity } as const;

/**
 * The values a construction of a local subclass whose constructors only call `super` passes on to
 * its native base's message (AggregateError's second slot; DOMException's message and name): an
 * argument a parameter forwards, a parameter's default, and each written `super` argument with the
 * arguments of the parameters it reads. Every argument, and every `super` argument, where the
 * positions are not known. `undefined` where the target is no such subclass.
 */
export function framedSubclassMessages(
  node: Node,
  names: ReadonlySet<string>,
): readonly ForwardedValue[] | undefined {
  const construction = subclassConstruction(node);
  if (construction === undefined) return undefined;
  const chain = framedSubclassChain(construction.target, names);
  if (chain === undefined) return undefined;
  const written: ForwardedValue[] = [];
  let slots = construction.slots;
  for (const declared of chain.classes) {
    const constructor = declared.members.find((member) => isConstructorDeclaration(member));
    if (constructor === undefined) continue;
    const call = superCall(constructor);
    if (call === undefined) return [];
    for (const argument of call.arguments) written.push({ value: argument, keys: [] });
    slots = slots === undefined ? undefined : superSlots(constructor, call, slots);
  }
  if (slots === undefined) return [...construction.whole, ...written];
  const known = slots;
  return messageSlots(chain.base).flatMap((index) => known[index] ?? []);
}

/** A `new` or `Reflect.construct` target and its argument positions, where they are known. */
function subclassConstruction(node: Node):
  | {
      readonly target: Expression;
      readonly slots: Slots | undefined;
      readonly whole: readonly ForwardedValue[];
    }
  | undefined {
  if (isNewExpression(node)) return boundOr(node.expression, node, node.arguments ?? []);
  if (
    !isCallExpression(node) ||
    globalPathOf(unwrapped(node.expression))?.join('.') !== 'Reflect.construct'
  )
    return undefined;
  const prefix = framedArgumentPrefix(node);
  const [target, list] = prefix.values;
  if (target === undefined || list === undefined || prefix.unknown) return undefined;
  const args = framedAppliedArguments(node, list);
  return args === undefined
    ? { target, slots: undefined, whole: [{ value: list, keys: [] }] }
    : boundOr(target, node, args);
}

/**
 * A construction of what `Target.bind(thisArg, …bound)` answers constructs the target with the bound
 * arguments ahead of its own, as the native bound function does; another target as it is.
 */
function boundOr(
  target: Expression,
  call: CallExpression | NewExpression,
  args: readonly Expression[],
): ReturnType<typeof constructed> {
  const bound = bindCall(target);
  if (bound === undefined) return constructed(target, call, args);
  const prefix = framedArgumentPrefix(bound.call, bound.call.arguments, ALL_ARGUMENTS.limit);
  if (!prefix.unknown)
    return constructed(bound.receiver, call, [...prefix.values.slice(1), ...args]);
  const whole = [...bound.call.arguments.slice(1), ...args].map((value) => ({ keys: [], value }));
  return { slots: undefined, target: bound.receiver, whole };
}

/** The `Target.bind(…)` call a constructed value is, through whole constant aliases. */
function bindCall(
  target: Expression,
): { readonly call: CallExpression; readonly receiver: Expression } | undefined {
  const bound = framedQuietSource(target);
  if (bound === undefined || !isCallExpression(bound)) return undefined;
  const member = unwrapped(bound.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  return frameMemberName(member) === 'bind'
    ? { call: bound, receiver: member.expression }
    : undefined;
}

/** Written arguments by position, expanding known spreads; an unknown spread hides positions. */
function constructed(
  target: Expression,
  call: CallExpression | NewExpression,
  args: readonly Expression[],
): {
  readonly target: Expression;
  readonly slots: Slots | undefined;
  readonly whole: readonly ForwardedValue[];
} {
  const whole = args.map((value) => ({ value, keys: [] }));
  const prefix = framedArgumentPrefix(call, args, ALL_ARGUMENTS.limit);
  return {
    target,
    whole,
    slots: prefix.unknown ? undefined : prefix.values.map((value) => [{ value, keys: [] }]),
  };
}

/** The statement calling the base constructor; a transparent constructor holds no other call. */
function superCall(constructor: ConstructorDeclaration): CallExpression | undefined {
  const statements = constructor.body?.statements;
  if (statements === undefined) return undefined;
  for (const statement of statements) {
    if (
      isExpressionStatement(statement) &&
      isCallExpression(statement.expression) &&
      statement.expression.expression.kind === SyntaxKind.SuperKeyword
    )
      return statement.expression;
  }
  return undefined;
}

/** The base constructor's argument positions, in terms of the construction's own arguments. */
function superSlots(
  constructor: ConstructorDeclaration,
  call: CallExpression,
  slots: Slots,
): Slots | undefined {
  const parameters = constructor.parameters;
  const result: (readonly ForwardedValue[])[] = [];
  for (const argument of call.arguments) {
    if (!isSpreadElement(argument)) {
      const values = framedSlotValues(argument, parameters, slots, call.arguments);
      if (values === undefined) return undefined;
      result.push(values);
      continue;
    }
    const rest = framedRestIndex(argument.expression, parameters);
    if (rest === undefined) return undefined;
    result.push(...slots.slice(rest));
  }
  return result;
}

/** The native constructor positions whose values become an error's words. */
function messageSlots(base: string): readonly number[] {
  if (base === 'AggregateError') return [1];
  return base === 'DOMException' ? [0, 1] : [0];
}

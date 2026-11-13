import {
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedArrayMutation } from './framed-array-mutators.ts';
import { frameMemberName } from './framed-bindings.ts';
import { calledNative, constantInitializer } from './framed-native-calls.ts';
import { methodMayBeOverridden } from './framed-overridden-methods.ts';
import { prototypeMayChange } from './framed-prototype-changes.ts';

/** The native object mutators, and the arguments a call of one hands them, borrowed or not. */

export const PATHS = {
  assign: 'Object.assign',
  properties: 'Object.defineProperties',
  property: 'Object.defineProperty',
} as const;

const MUTATORS: ReadonlySet<string> = new Set(Object.values(PATHS));

/** A native object mutator and the arguments it runs with, after its target. */
export interface MutatorInvocation {
  readonly path: string;
  readonly args: readonly Expression[];
  /** Whether the mutator answers `false` where it fails, and runs on, as `Reflect` does. */
  readonly silent?: boolean;
}

/**
 * The native a callee names: by its global path, through parentheses and a comma (`(0, f)`), through
 * a constant that holds it (`const define = Object.defineProperty`), and through `.call` or `.apply`
 * of such a name. None for a callee that is any other expression, a bound function among them.
 */
export function nativePath(callee: Expression): string | undefined {
  const seen = new Set<Node>();
  const suffixes: string[] = [];
  let value = unwrapped(callee);
  for (;;) {
    if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.CommaToken) {
      value = unwrapped(value.right);
      continue;
    }
    const global = globalPathOf(value)?.join('.');
    if (global !== undefined) return [global, ...suffixes].join('.');
    if (isPropertyAccessExpression(value) && ['apply', 'call'].includes(value.name.text)) {
      suffixes.unshift(value.name.text);
      value = unwrapped(value.expression);
      continue;
    }
    const held = isIdentifier(value) && !seen.has(value) ? constantInitializer(value) : undefined;
    if (held === undefined || !isIdentifier(value)) return undefined;
    seen.add(value);
    value = unwrapped(held);
  }
}

/** `Reflect.defineProperty` takes the arguments of `Object.defineProperty`, and answers instead of throwing. */
function normalized(path: string): string {
  const reflected = 'Reflect.defineProperty';
  if (path === reflected) return PATHS.property;
  return path.startsWith(`${reflected}.`)
    ? `${PATHS.property}${path.slice(reflected.length)}`
    : path;
}

/**
 * The mutator a call runs, directly or through `.call`, `.apply` or `Reflect.apply`, with the
 * arguments it receives; none for a call of something else, or one whose arguments are unread.
 */
export function mutatorInvocation(call: CallExpression): MutatorInvocation | undefined {
  return nativeInvocation(call, MUTATORS);
}

/** The call of one of the natives `known` names, however the code writes the call. */
function nativeInvocation(
  call: CallExpression,
  known: ReadonlySet<string>,
): MutatorInvocation | undefined {
  const called = calledNative(call, tracked(known));
  if (called === undefined) return undefined;
  const path = normalized(called.path);
  return known.has(path) ? { path, args: called.args, silent: called.path !== path } : undefined;
}

const TRACKED = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();

/** The natives the language's own names stand for: those `known` names, and the `Reflect` one that answers instead of throwing. */
function tracked(known: ReadonlySet<string>): ReadonlySet<string> {
  const found = TRACKED.get(known);
  if (found !== undefined) return found;
  const all = new Set(known);
  if (known.has(PATHS.property)) all.add('Reflect.defineProperty');
  TRACKED.set(known, all);
  return all;
}

/** The natives that hand back the object they were given first; `Object(a)` hands back an object. */
const HANDS_BACK: ReadonlySet<string> = new Set([
  'Object',
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'Object.setPrototypeOf',
  PATHS.assign,
  PATHS.properties,
  PATHS.property,
]);

/** The array methods that hand back the array they were called on, and `valueOf` of any object. */
const HANDS_RECEIVER: ReadonlySet<string> = new Set([
  'copyWithin',
  'fill',
  'reverse',
  'sort',
  'valueOf',
]);

/** The operators whose value is one of their operands, or the right one. */
const OF_RIGHT: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.CommaToken, SyntaxKind.EqualsToken]);
const OF_EITHER: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * The objects a mutation may reach through the expression that names its target: the natives that
 * return their first argument or the array they are called on (`Object.assign(a, {})`,
 * `a.fill(0)`, borrowed or called through `.call`, `.apply`, `Reflect.apply` or a constant), a
 * comma, an assignment, a condition or a logical operator, each of whose operands may be it.
 */
export function returnedTargets(target: Expression): readonly Expression[] {
  const found: Expression[] = [];
  const seen = new Set<Node>();
  const pending = [target];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const inner = unwrapped(at);
    const next = seen.has(inner) ? undefined : handedBack(inner);
    seen.add(inner);
    if (next !== undefined) pending.push(...next.toReversed());
    else if (found.every((each) => unwrapped(each) !== inner)) found.push(at);
  }
  return found;
}

/** The expressions one that gives its value away may be, none for one that holds an object itself. */
function handedBack(expression: Expression): readonly Expression[] | undefined {
  if (isBinaryExpression(expression)) {
    const kind = expression.operatorToken.kind;
    if (OF_RIGHT.has(kind)) return [expression.right];
    return OF_EITHER.has(kind) ? [expression.left, expression.right] : undefined;
  }
  if (isConditionalExpression(expression)) return [expression.whenTrue, expression.whenFalse];
  if (isNewExpression(expression)) return handedOver(expression);
  return isCallExpression(expression) ? handedOverBy(expression) : undefined;
}

/** What `new Object(a)` is: the object it was given, or a new one that nothing holds. */
function handedOver(call: NewExpression): readonly Expression[] | undefined {
  const [first] = call.arguments ?? [];
  const native = globalPathOf(unwrapped(call.expression))?.join('.') === 'Object';
  return native && first !== undefined && !isSpreadElement(first) ? [first] : undefined;
}

/** The array method a call names, of one of those that return the array they are called on, and the array. */
function receiverMethod(
  call: CallExpression,
): { readonly name: string; readonly receiver: Expression } | undefined {
  const callee = unwrapped(call.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
  const name = frameMemberName(callee);
  return name !== undefined && HANDS_RECEIVER.has(name)
    ? { name, receiver: callee.expression }
    : undefined;
}

/** What a call returns of what it was given: its first argument, or the array it was called on. */
function handedOverBy(call: CallExpression): readonly Expression[] | undefined {
  const borrowed = borrowedArrayMutation(call);
  if (borrowed !== undefined) {
    if (!HANDS_RECEIVER.has(borrowed.method) || isSpreadElement(borrowed.receiver))
      return undefined;
    return prototypeMayChange(call.getSourceFile())
      ? [borrowed.receiver, call]
      : [borrowed.receiver];
  }
  const method = receiverMethod(call);
  if (method !== undefined)
    return methodMayBeOverridden(call.getSourceFile(), method.name, mutatorInvocation)
      ? [method.receiver, call]
      : [method.receiver];
  const invoked = nativeInvocation(call, HANDS_BACK);
  if (invoked === undefined || invoked.silent === true) return undefined;
  const [first] = invoked.args;
  return first === undefined || isSpreadElement(first) ? undefined : [first];
}

/** The arrays and objects a native object mutator writes, past what hands back its target. */
export function invokedTargets(invoked: MutatorInvocation): readonly Expression[] {
  const [target] = invoked.args;
  return target === undefined ? [] : returnedTargets(target);
}

/** What an initializer holds that hands one object back: that object, or the expression itself. */
export function soleTarget(expression: Expression): Expression {
  const [only, ...more] = returnedTargets(expression);
  return only !== undefined && more.length === 0 ? unwrapped(only) : expression;
}

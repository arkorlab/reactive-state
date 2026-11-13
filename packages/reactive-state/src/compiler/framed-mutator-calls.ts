import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedArrayMutation } from './framed-array-mutators.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments } from './framed-keys.ts';

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

/** A native a callee names, and the arguments a `bind` of it gave it before the call's own. */
interface NativeCallee {
  readonly path: string;
  readonly bound: readonly Expression[];
}

/**
 * The native a callee names: by its global path, through parentheses and a comma (`(0, f)`), through
 * a constant that holds it (`const define = Object.defineProperty`), through `.call` or `.apply`
 * of such a name, and through one `.bind` of it, whose arguments come first. None for a callee that
 * is any other expression.
 */
function nativeCallee(callee: Expression, allowBound: boolean): NativeCallee | undefined {
  const seen = new Set<Node>();
  const passed: { suffixes: string[]; bound?: readonly Expression[] } = { suffixes: [] };
  let value = unwrapped(callee);
  for (;;) {
    const global = globalPathOf(value)?.join('.');
    if (global !== undefined)
      return { path: [global, ...passed.suffixes].join('.'), bound: passed.bound ?? [] };
    const next = through(value, passed, allowBound) ?? heldBy(value, seen);
    if (next === undefined) return undefined;
    value = unwrapped(next);
  }
}

/** The native a callee names, by the forms above but a `bind`: the path alone. */
export function nativePath(callee: Expression): string | undefined {
  return nativeCallee(callee, false)?.path;
}

/** What a callee that is a comma, a `.call` or `.apply`, or a `bind` of another is called through. */
function through(
  value: Expression,
  passed: { suffixes: string[]; bound?: readonly Expression[] },
  allowBound: boolean,
): Expression | undefined {
  if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.CommaToken)
    return value.right;
  if (isPropertyAccessExpression(value) && ['apply', 'call'].includes(value.name.text)) {
    passed.suffixes.unshift(value.name.text);
    return value.expression;
  }
  const binding =
    allowBound && isCallExpression(value) && passed.bound === undefined
      ? bindingOf(value)
      : undefined;
  if (binding === undefined) return undefined;
  passed.bound = binding.bound;
  return binding.target;
}

/** The initializer of the constant a name stands for, once. */
function heldBy(value: Expression, seen: Set<Node>): Expression | undefined {
  if (!isIdentifier(value) || seen.has(value)) return undefined;
  seen.add(value);
  return constantInitializer(value);
}

/** The function a call of `bind` binds, and the arguments it binds, if they are written out. */
function bindingOf(
  call: CallExpression,
): { readonly target: Expression; readonly bound: readonly Expression[] } | undefined {
  const callee = unwrapped(call.expression);
  if (!isPropertyAccessExpression(callee)) return undefined;
  const [, ...bound] = writtenArguments(call);
  return callee.name.text !== 'bind' || bound.some((each) => isSpreadElement(each))
    ? undefined
    : { target: callee.expression, bound };
}

/** The initializer of the constant a name stands for whole. */
function constantInitializer(name: Identifier): Expression | undefined {
  const held = frameBindingOf(name);
  const declaration = held?.keys.length === 0 ? held.binding : undefined;
  if (declaration === undefined || !isVariableDeclaration(declaration)) return undefined;
  const list = declaration.parent;
  const constant =
    isVariableDeclarationList(list) && /^const\b/u.test(list.getText(list.getSourceFile()));
  return constant ? declaration.initializer : undefined;
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

/** The natives that call their first argument, with a receiver and the arguments or a list of them. */
const FORWARDING: ReadonlyMap<string, 'apply' | 'call'> = new Map([
  ['Function.prototype.apply.call', 'apply'],
  ['Function.prototype.call.call', 'call'],
  ['Reflect.apply', 'apply'],
]);

/** The call of one of the natives `known` names, in the forms a mutator is called in. */
function nativeInvocation(
  call: CallExpression,
  known: ReadonlySet<string>,
): MutatorInvocation | undefined {
  const callee = nativeCallee(call.expression, true);
  if (callee === undefined) return undefined;
  const { bound } = callee;
  const path = normalized(callee.path);
  const silent = callee.path !== path;
  if (known.has(path)) return { path, args: [...bound, ...writtenArguments(call)], silent };
  const forwarding = FORWARDING.get(path);
  if (forwarding !== undefined) return forwarded(call, forwarding, known);
  const split = path.lastIndexOf('.');
  const native = path.slice(0, split);
  if (!known.has(native)) return undefined;
  const how = path.slice(split + 1);
  if (how === 'apply') return withSilence(applied(call, native, call.arguments[1], bound), silent);
  if (how !== 'call') return undefined;
  const [receiver, ...rest] = writtenArguments(call);
  return receiver === undefined || isSpreadElement(receiver)
    ? undefined
    : { path: native, args: [...bound, ...rest], silent };
}

/** A call that forwards to one of the natives `known` names: `Reflect.apply(Object.assign, null, [a])`. */
function forwarded(
  call: CallExpression,
  how: 'apply' | 'call',
  known: ReadonlySet<string>,
): MutatorInvocation | undefined {
  const [target, , list] = call.arguments;
  const native = target === undefined ? undefined : nativeCallee(target, true);
  const aimed = native === undefined ? undefined : normalized(native.path);
  if (native === undefined || aimed === undefined || !known.has(aimed)) return undefined;
  const silent = native.path !== aimed;
  if (how === 'apply') return withSilence(applied(call, aimed, list, native.bound), silent);
  const [first, second, ...rest] = writtenArguments(call);
  return first === undefined ||
    second === undefined ||
    isSpreadElement(first) ||
    isSpreadElement(second)
    ? undefined
    : { path: aimed, args: [...native.bound, ...rest], silent };
}

/** An invocation, marked as the one that fails silently where it does. */
function withSilence(
  invoked: MutatorInvocation | undefined,
  silent: boolean,
): MutatorInvocation | undefined {
  return invoked === undefined ? undefined : { ...invoked, silent };
}

/** A mutator called with the entries of a written list, after the arguments bound to it. */
function applied(
  call: CallExpression,
  path: string,
  list: Expression | undefined,
  bound: readonly Expression[],
): MutatorInvocation | undefined {
  const listed = list === undefined ? undefined : framedAppliedArguments(call, list);
  return listed === undefined
    ? undefined
    : { path, args: [...bound, ...writtenArguments(call, listed)] };
}

/**
 * The call's arguments in order, each spread of a written list, or of a constant list nothing
 * changes, replaced by the entries it stands for; a spread the compile cannot read stays one. A
 * list is expanded each time it is spread, but never within itself.
 */
export function writtenArguments(
  call: CallExpression,
  given: readonly Expression[] = call.arguments,
): readonly Expression[] {
  type Listed = readonly (readonly Expression[])[];
  const written: Expression[] = [];
  const pending = given.toReversed().map((node) => ({ node, within: [] as Listed }));
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const listed = isSpreadElement(each.node)
      ? framedAppliedArguments(call, each.node.expression)
      : undefined;
    if (listed === undefined || each.within.includes(listed)) written.push(each.node);
    else {
      const within = [...each.within, listed];
      for (const node of listed.toReversed()) pending.push({ node, within });
    }
  }
  return written;
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
    if (seen.has(inner)) continue;
    seen.add(inner);
    const next = handedBack(inner);
    if (next === undefined) found.push(at);
    else pending.push(...next.toReversed());
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

/** What a call returns of what it was given: its first argument, or the array it was called on. */
function handedOverBy(call: CallExpression): readonly Expression[] | undefined {
  const borrowed = borrowedArrayMutation(call);
  if (borrowed !== undefined)
    return HANDS_RECEIVER.has(borrowed.method) && !isSpreadElement(borrowed.receiver)
      ? [borrowed.receiver]
      : undefined;
  const callee = unwrapped(call.expression);
  if (
    (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
    HANDS_RECEIVER.has(frameMemberName(callee) ?? '')
  )
    return [callee.expression];
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

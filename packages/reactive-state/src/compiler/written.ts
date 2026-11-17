import {
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNewExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { initializerOf, takenApartOf } from './framed.ts';
import { isStickyPattern, keepsPatternIndex, symbolPatternChanges } from './pattern-writes.ts';
import {
  appliedArguments,
  argumentAt,
  asCallArguments,
  type CallArgument,
  followedValue,
  globalCallOf,
  memberNameOf,
  unwrapBoundTarget,
} from './written-arguments.ts';
import { dispatchEventTargets, reflectSetReceivers } from './written-slot-targets.ts';
import { transferredBy } from './written-transfers.ts';

/**
 * What of a shared module's code writes into what it is given, where it writes it (`settled.ts`):
 * what an assignment, a count or a `delete` writes, what a loop of no declaration writes into, what
 * a method changes of what it is called on, borrowed too, and what a global's function changes of
 * what it is given.
 */

/**
 * The methods that change what they are called on in place: an array's, a typed array's, a `Map`'s,
 * a `Set`'s; a date's setters, in UTC as in local time, `setUTCSeconds`, and `setTime`; a
 * `DataView`'s; a pattern's `compile`; a buffer's `resize`, `grow` and `transfer`, which detaches
 * it; the platform's — `append` of a `URLSearchParams`, a `Headers`, a `FormData`, `abort` of an
 * `AbortController`, an `EventTarget`'s listeners, including one a dispatch consumes once; an
 * event's cancellation and propagation flags or its initialized type; what locks a stream or queues
 * in it — and
 * what advances an iterator, or ends it: `next`, `return`, `throw`.
 */
const CHANGING_METHODS: ReadonlySet<string> = new Set([
  'abort',
  'add',
  'addEventListener',
  'append',
  'clear',
  'compile',
  'copyWithin',
  'delete',
  'dispatchEvent',
  'enqueue',
  'fill',
  'getOrInsert',
  'getOrInsertComputed',
  'getReader',
  'getWriter',
  'grow',
  'initEvent',
  'next',
  'pipeThrough',
  'pipeTo',
  'pop',
  'prepend',
  'preventDefault',
  'push',
  'releaseLock',
  'removeEventListener',
  'resize',
  'return',
  'reverse',
  'set',
  'setBigInt64',
  'setBigUint64',
  'setDate',
  'setFloat16',
  'setFloat32',
  'setFloat64',
  'setFullYear',
  'setHours',
  'setInt8',
  'setInt16',
  'setInt32',
  'setMilliseconds',
  'setMinutes',
  'setMonth',
  'setSeconds',
  'setTime',
  'setUint8',
  'setUint16',
  'setUint32',
  'setUTCDate',
  'setUTCFullYear',
  'setUTCHours',
  'setUTCMilliseconds',
  'setUTCMinutes',
  'setUTCMonth',
  'setUTCSeconds',
  'setYear',
  'shift',
  'sort',
  'splice',
  'stopImmediatePropagation',
  'stopPropagation',
  'tee',
  'throw',
  'transfer',
  'transferToFixedLength',
  'unshift',
]);

/**
 * The methods of a pattern that move where it matches from next, its `lastIndex`, where it is of
 * `g` or `y` (`keepsPatternIndex`): `exec`, `test`.
 */
const INDEXING_METHODS: ReadonlySet<string> = new Set(['exec', 'test']);

/** The methods of text that move where a pattern of `y` and no `g` they are given matches from (`isStickyPattern`). */
const STICKY_TAKERS: ReadonlySet<string> = new Set(['match', 'replace']);

/**
 * The functions of globals that change what they are given first: `Atomics`' that write among them;
 * `Object`'s and `Reflect`'s that set, define or delete its entries, set its prototype, or lock it —
 * `Object.freeze`, `Object.seal`, `preventExtensions` — of which `Object.isFrozen` answers otherwise.
 */
export const CHANGING_FUNCTIONS: ReadonlySet<string> = new Set([
  'Atomics.add',
  'Atomics.and',
  'Atomics.compareExchange',
  'Atomics.exchange',
  'Atomics.or',
  'Atomics.store',
  'Atomics.sub',
  'Atomics.xor',
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'Object.setPrototypeOf',
  'Reflect.defineProperty',
  'Reflect.deleteProperty',
  'Reflect.preventExtensions',
  'Reflect.set',
  'Reflect.setPrototypeOf',
]);

/** The operators that assign what stands on their right to what stands on their left. */
const ASSIGNING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.SlashEqualsToken,
]);

/**
 * The methods of a stream, its reader, its writer or its controller that change it — what ends it,
 * `close`, `cancel`, `error`, `terminate`, and what reads of it or writes into it, `read`, `write`
 * — which text and the platform's other values hold of those names too, `console.error`, so of what
 * the code shows is one alone (`isStream`).
 */
const STREAMING: ReadonlySet<string> = new Set([
  'cancel',
  'close',
  'error',
  'read',
  'terminate',
  'write',
]);

/** The platform's streams. */
const STREAMS: ReadonlySet<string> = new Set([
  'CompressionStream',
  'DecompressionStream',
  'ReadableStream',
  'TextDecoderStream',
  'TextEncoderStream',
  'TransformStream',
  'WritableStream',
]);

/** The methods of a stream that answer its reader, its writer, or another stream of it. */
const STREAM_PARTS: ReadonlySet<string> = new Set(['getReader', 'getWriter', 'pipeThrough']);

/** The name of the method `call` calls, by its name or by text in brackets; none of another call. */
export function methodOf(call: CallExpression): string | undefined {
  return memberNameOf(call.expression);
}

/** What `node` writes into, where it writes: what it assigns, counts up, deletes, changes in place. */
export function writtenBy(node: Node): Node | undefined {
  if (isBinaryExpression(node) && ASSIGNING.has(node.operatorToken.kind)) {
    return node.left;
  }
  if (
    (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
    (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken)
  ) {
    return node.operand;
  }
  if (isDeleteExpression(node)) {
    return node.expression;
  }
  // `for (current of items)`: a loop of no declaration writes into what it is given each time.
  if (
    (isForOfStatement(node) || isForInStatement(node)) &&
    !isVariableDeclarationList(node.initializer)
  ) {
    return node.initializer;
  }
  return isCallExpression(node) ? calledWrite(node) : undefined;
}

/**
 * What a call writes beside its receiver: the event `dispatchEvent` is given, whose target and
 * cancellation flags a dispatch changes, or the buffers a structured clone's transfer list detaches.
 */
/** The argument expressions supplied to `call`, including prebound and applied arguments. */
export function writtenCallValues(call: CallExpression): readonly Expression[] {
  const globalCall = globalCallOf(call);
  if (globalCall !== undefined) {
    return globalCall.given.map((each) => each.expression);
  }
  const lent = borrowedOf(call) ?? boundOf(call);
  if (lent !== undefined) {
    return lent.given.map((each) => each.expression);
  }
  return asCallArguments(call.arguments).map((each) => each.expression);
}

export function writtenArgumentBy(node: Node): readonly Node[] {
  if (!isCallExpression(node)) {
    return [];
  }
  const globalCall = globalCallOf(node);
  if (globalCall?.path === 'structuredClone') {
    return transferredBy(globalCall.given);
  }
  if (globalCall?.path === 'Reflect.set') {
    return reflectSetReceivers(globalCall.given);
  }
  const invoked = borrowedOf(node) ?? boundOf(node);
  if ((invoked?.method ?? methodOf(node)) !== 'dispatchEvent') {
    return [];
  }
  return dispatchEventTargets(invoked?.given ?? asCallArguments(node.arguments));
}

/**
 * What `call` writes into: what a global's function that changes what it is given is given first;
 * what a method that changes what it is called on is called on (`changes`), borrowed too.
 */
function calledWrite(call: CallExpression): Node | undefined {
  const callee = unwrapped(call.expression);
  // `Atomics.add(counts, …)`, `Reflect.set(target, …)`: what a global's function is given, not the
  // global, though its name is a method's that changes what it is called on.
  const globalCall = globalCallOf(call);
  if (globalCall !== undefined && CHANGING_FUNCTIONS.has(globalCall.path)) {
    return argumentAt(globalCall.given, 0);
  }
  const borrowed = borrowedOf(call) ?? boundOf(call);
  if (borrowed !== undefined) {
    return changes(borrowed.method, borrowed.receiver) ? borrowed.receiver : undefined;
  }
  const method = methodOf(call);
  // `text.match(word)` of a pattern of `y` and no `g` moves where it matches from, as `exec` does.
  const [first] = call.arguments;
  if (
    method !== undefined &&
    first !== undefined &&
    STICKY_TAKERS.has(method) &&
    isStickyPattern(first)
  ) {
    return first;
  }
  return method !== undefined &&
    (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
    changes(method, callee.expression)
    ? callee.expression
    : undefined;
}

/**
 * Whether the method `method`, called on `receiver`, changes it: one that changes what it is called
 * on (`CHANGING_METHODS`), or `exec` and `test` of a pattern that keeps where it matches from.
 */
function changes(method: string, receiver: Expression): boolean {
  return (
    CHANGING_METHODS.has(method) ||
    (INDEXING_METHODS.has(method) && keepsPatternIndex(receiver)) ||
    symbolPatternChanges(method, receiver) ||
    (STREAMING.has(method) && isStream(receiver, new Set()))
  );
}

/**
 * Whether `receiver` is a stream, or its reader or writer, the code shows it makes: `new
 * WritableStream()`, what `getWriter` answers of one, the `readable` or the `writable` of one, read
 * or taken apart — through what a variable around it is declared of, in turn.
 */
function isStream(receiver: Expression, seen: Set<Expression>): boolean {
  let value = unwrapped(receiver);
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = initializerOf(value);
    if (declared === undefined) {
      // `const { writable } = new TransformStream()`.
      const taken = takenApartOf(value);
      return (
        taken !== undefined &&
        (taken.key === 'readable' || taken.key === 'writable') &&
        isStream(taken.of, seen)
      );
    }
    value = unwrapped(declared);
  }
  if (isNewExpression(value)) {
    return STREAMS.has(globalPathOf(unwrapped(value.expression))?.join('.') ?? '');
  }
  if (isPropertyAccessExpression(value)) {
    return (
      (value.name.text === 'readable' || value.name.text === 'writable') &&
      isStream(value.expression, seen)
    );
  }
  if (isCallExpression(value)) {
    const method = methodOf(value);
    const callee = unwrapped(value.expression);
    return (
      method !== undefined &&
      STREAM_PARTS.has(method) &&
      (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
      isStream(callee.expression, seen)
    );
  }
  return false;
}

/**
 * The method `call` borrows of another value, and what it calls it on — of `call` and `apply`,
 * `RegExp.prototype.test.call(word, text)`, `Array.prototype.push.apply(list, items)`, and of
 * `Reflect.apply(Map.prototype.set, table, [key, value])` — none of another call.
 */
function borrowedOf(call: CallExpression): LentMethod | undefined {
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

/**
 * The method `call` holds bound through `.bind(...)`, and what its first bind bound `this` to —
 * `push` of `const push = items.push.bind(items)` or `Array.prototype.push.bind(items)`.
 */
function boundOf(call: CallExpression): LentMethod | undefined {
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

/** A borrowed or bound method's name, receiver and arguments, in the order it is given them. */
interface LentMethod {
  readonly given: readonly CallArgument[];
  readonly method: string;
  readonly receiver: Expression;
}

/** The name of the method `method` reads, lent to `receiver`; none of a method the compile cannot name. */
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

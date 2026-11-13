import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf } from './framed-bindings.ts';
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
  const named = nativePath(call.expression);
  if (named === undefined) return undefined;
  const path = normalized(named);
  const silent = named !== path;
  if (MUTATORS.has(path)) return { path, args: writtenArguments(call), silent };
  if (path === 'Reflect.apply') {
    const [callee, , list] = call.arguments;
    const native = callee === undefined ? undefined : nativePath(callee);
    const aimed = native === undefined ? undefined : normalized(native);
    if (aimed === undefined || !MUTATORS.has(aimed)) return undefined;
    return withSilence(applied(call, aimed, list), native !== aimed);
  }
  const split = path.lastIndexOf('.');
  const native = path.slice(0, split);
  if (!MUTATORS.has(native)) return undefined;
  const how = path.slice(split + 1);
  if (how === 'apply') return withSilence(applied(call, native, call.arguments[1]), silent);
  if (how !== 'call') return undefined;
  const [receiver, ...rest] = writtenArguments(call);
  return receiver === undefined || isSpreadElement(receiver)
    ? undefined
    : { path: native, args: rest, silent };
}

/** An invocation, marked as the one that fails silently where it does. */
function withSilence(
  invoked: MutatorInvocation | undefined,
  silent: boolean,
): MutatorInvocation | undefined {
  return invoked === undefined ? undefined : { ...invoked, silent };
}

/** A mutator called with the entries of a written list. */
function applied(
  call: CallExpression,
  path: string,
  list: Expression | undefined,
): MutatorInvocation | undefined {
  const listed = list === undefined ? undefined : framedAppliedArguments(call, list);
  return listed === undefined ? undefined : { path, args: writtenArguments(call, listed) };
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

/** The natives that hand back the object they were given first. */
const RETURNS_TARGET: ReadonlySet<string> = new Set([
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'Object.setPrototypeOf',
  PATHS.assign,
  PATHS.properties,
  PATHS.property,
]);

/**
 * The object a mutation reaches through the natives that return their first argument:
 * Object.assign(Object.assign(a, {}), ...) mutates a.
 */
export function returnedTarget(target: Expression): Expression {
  let at = target;
  for (;;) {
    const inner = unwrapped(at);
    if (!isCallExpression(inner)) return at;
    const path = globalPathOf(unwrapped(inner.expression))?.join('.');
    const [first] = writtenArguments(inner);
    if (path === undefined || !RETURNS_TARGET.has(path)) return at;
    if (first === undefined || isSpreadElement(first)) return at;
    at = first;
  }
}

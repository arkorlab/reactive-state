import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedBoundErrorArguments } from './framed-bound-errors.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { unchangedNativeBind } from './framed-native-bind.ts';
import { framedQuietSource } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { wholeIntlConstant } from './render-intl-receivers.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Borrowed native formatter methods retain their written receiver and native brand. */

const REFLECT_APPLY = new Set(['Reflect.apply']);
const ACCESSORS = new Set([
  'Intl.Collator.prototype.compare',
  'Intl.DateTimeFormat.prototype.format',
  'Intl.NumberFormat.prototype.format',
]);

interface BorrowedRead {
  readonly expression: Expression;
  readonly target: Expression;
  readonly fields: ReadonlySet<Expression>;
  readonly names: readonly string[];
  readonly kind: string;
  readonly bound: BoundInvocation | undefined;
}
interface BoundInvocation {
  readonly call: CallExpression;
  readonly args: readonly Expression[];
}

interface Invocation {
  readonly target: Expression;
  readonly receiver: Expression;
  readonly bound: BoundInvocation | undefined;
}

/** Only a native prototype callable and a known wrapper receiver add an environment read. */
export function borrowedIntlRead(
  node: Node,
  formatters: ReadonlyMap<string, ReadonlySet<string>>,
): BorrowedRead | undefined {
  if (!isCallExpression(node)) return undefined;
  const invocation = borrowedInvocation(node, formatters);
  if (invocation === undefined) return undefined;
  const source = methodSource(invocation.target);
  if (source === undefined || ACCESSORS.has(source.path)) return undefined;
  for (const [kind, members] of formatters) {
    for (const member of members) {
      if (source.path === `${kind}.prototype.${member}`)
        return {
          expression: invocation.receiver,
          target: invocation.target,
          fields: source.fields,
          names: [member],
          kind,
          bound: invocation.bound,
        };
    }
  }
  return undefined;
}

/** Native call/apply and Reflect.apply consume their this argument in distinct known positions. */
function borrowedInvocation(
  call: CallExpression,
  formatters: ReadonlyMap<string, ReadonlySet<string>>,
): Invocation | undefined {
  const names = new Set<string>();
  for (const [kind, members] of formatters)
    for (const member of members) names.add(`${kind}.prototype.${member}`);
  const bound = framedBoundErrorArguments(call, names);
  if (bound !== undefined) {
    const receiver = knownPrefix(bound.bound, 1)?.[0];
    return receiver === undefined
      ? undefined
      : { target: bound.target, receiver, bound: { call: bound.bound, args: bound.args } };
  }
  const local = prototypeBoundInvocation(call, names);
  if (local !== undefined) return local;
  const callee = unwrapped(call.expression);
  if (framedNativeConstructor(callee, REFLECT_APPLY)) {
    const [target, receiver] = knownPrefix(call, 2) ?? [];
    return target === undefined || receiver === undefined
      ? undefined
      : { target, receiver, bound: undefined };
  }
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
  const member = frameMemberName(callee);
  if (member !== 'call' && member !== 'apply') return undefined;
  const receiver = knownPrefix(call, 1)?.[0];
  return receiver === undefined
    ? undefined
    : { target: callee.expression, receiver, bound: undefined };
}

/** Proven prototype aliases retain the same local method identity when their native bind is unchanged. */
function prototypeBoundInvocation(
  call: CallExpression,
  names: ReadonlySet<string>,
): Invocation | undefined {
  const bound = framedQuietSource(call.expression);
  if (bound === undefined || !isCallExpression(bound)) return undefined;
  const member = unwrapped(bound.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'bind'
  )
    return undefined;
  const source = methodSource(member.expression);
  if (
    source === undefined ||
    !names.has(source.path) ||
    !unchangedNativeBind(member.expression, bound, names)
  )
    return undefined;
  const prefix = framedArgumentPrefix(bound, bound.arguments, Infinity);
  const receiver = prefix.values[0];
  if (receiver === undefined || prefix.unknown || prefix.alternatives !== undefined)
    return undefined;
  return {
    target: member.expression,
    receiver,
    bound: { call: bound, args: [...prefix.values.slice(1), ...call.arguments] },
  };
}

/** Unresolved spreads and replacement alternatives do not identify a native wrapper's receiver. */
function knownPrefix(call: CallExpression, count: number): readonly Expression[] | undefined {
  const prefix = framedArgumentPrefix(call, call.arguments, count);
  return prefix.unknown || (prefix.alternatives?.length ?? 0) > 0 ? undefined : prefix.values;
}

/** Whole method aliases keep native identity only without another possible source use. */
interface NativeMethod {
  readonly path: string;
  readonly fields: ReadonlySet<Expression>;
}

function methodSource(expression: Expression): NativeMethod | undefined {
  const bindings = new Set<Node>();
  const allowed = new Set<Node>();
  const fields = new Set<Expression>();
  const path = methodPath(expression, { bindings, allowed, fields });
  return path !== undefined && unexposedMethod(expression, bindings, allowed)
    ? { path, fields }
    : undefined;
}

interface MethodAliases {
  readonly bindings: Set<Node>;
  readonly allowed: Set<Node>;
  readonly fields: Set<Expression>;
}

/** Whole function or prototype aliases retain one native member path without evaluating a key. */
function methodPath(expression: Expression, aliases: MethodAliases): string | undefined {
  let value = unwrapped(expression);
  const suffix: string[] = [];
  const seen = new Set<Expression>();
  while (!seen.has(value)) {
    seen.add(value);
    const path = globalPathOf(value);
    if (path !== undefined) return [...path, ...suffix].join('.');
    if (isIdentifier(value)) {
      const binding = wholeIntlConstant(value);
      if (binding?.initializer === undefined || aliases.bindings.has(binding)) return undefined;
      aliases.bindings.add(binding);
      aliases.allowed.add(value);
      aliases.allowed.add(binding.name);
      value = unwrapped(binding.initializer);
      continue;
    }
    const name = literalMethodMember(value);
    if (name === undefined) return undefined;
    aliases.fields.add(value);
    suffix.unshift(name.name);
    value = unwrapped(name.receiver);
  }
  return undefined;
}

/** New prototype member paths use direct names or literal string keys only. */
function literalMethodMember(
  value: Expression,
): { readonly name: string; readonly receiver: Expression } | undefined {
  if (isPropertyAccessExpression(value))
    return { name: value.name.text, receiver: value.expression };
  if (!isElementAccessExpression(value)) return undefined;
  const key = unwrapped(value.argumentExpression);
  return isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key)
    ? { name: key.text, receiver: value.expression }
    : undefined;
}

/** Other alias uses may install an own call/apply implementation or hand the function to one. */
function unexposedMethod(
  expression: Expression,
  bindings: ReadonlySet<Node>,
  allowed: ReadonlySet<Node>,
): boolean {
  if (bindings.size === 0) return true;
  const pending: Node[] = [expression.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && !allowed.has(node) && readsBinding(node)) {
      const binding = frameDeclarationOf(node);
      if (binding !== undefined && bindings.has(binding)) return false;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

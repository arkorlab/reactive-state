import {
  type CallExpression,
  type Expression,
  type Identifier,
  type FunctionDeclaration,
  type VariableDeclaration,
  isFunctionDeclaration,
  isExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableStatement,
  isVoidExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Native call/apply wrappers retain the local factory and proven argument positions. */

type Resolve = (name: Identifier) => Node | undefined;
type Factory = (callee: Expression) => Answering | undefined;
type CallableBinding = FunctionDeclaration | VariableDeclaration;
const REFLECT_ARGUMENTS = 3;

interface Invocation {
  readonly fn: Answering;
  readonly given: readonly Expression[] | null;
}

/** Only unchanged native invokers normalize; ordinary calls keep their existing argument syntax. */
export function framedFactoryCall(
  call: CallExpression,
  factory: Factory,
  resolve: Resolve,
): Invocation | undefined {
  const callee = unwrapped(call.expression);
  if (isCallExpression(callee)) return boundInvocation(call, callee, factory, resolve);
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    const prefix = framedArgumentPrefix(call, call.arguments, REFLECT_ARGUMENTS);
    const target = prefix.values[0];
    if (target === undefined || prefix.alternatives !== undefined) return undefined;
    const fn = factory(target);
    if (fn === undefined) return undefined;
    const list = prefix.values[2];
    const given =
      list === undefined || prefix.unknown ? null : (framedAppliedArguments(call, list) ?? null);
    return { fn, given };
  }
  if (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) {
    const method = frameMemberName(callee);
    if (method === 'call' || method === 'apply') {
      const fn = factory(callee.expression);
      if (fn === undefined || !nativeInvokers(callee.expression, resolve)) return undefined;
      return { fn, given: methodArguments(call, method, fn) };
    }
  }
  const fn = factory(call.expression);
  return fn === undefined ? undefined : { fn, given: call.arguments };
}

/** Immediate native bind invocations prepend captured arguments without executing the factory. */
function boundInvocation(
  call: CallExpression,
  bound: CallExpression,
  factory: Factory,
  resolve: Resolve,
): Invocation | undefined {
  const member = unwrapped(bound.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'bind'
  )
    return undefined;
  const fn = factory(member.expression);
  if (fn === undefined || !nativeInvokers(member.expression, resolve)) return undefined;
  const prefix = framedArgumentPrefix(bound, bound.arguments, fn.parameters.length + 1);
  const given =
    prefix.unknown || prefix.alternatives !== undefined
      ? null
      : [...prefix.values.slice(1), ...call.arguments];
  return { fn, given };
}

/** Unknown prefixes or exposed apply lists preserve opacity instead of selecting parameter defaults. */
function methodArguments(
  call: CallExpression,
  method: 'call' | 'apply',
  fn: Answering,
): readonly Expression[] | null {
  const prefix = framedArgumentPrefix(
    call,
    call.arguments,
    method === 'apply' ? 2 : fn.parameters.length + 1,
  );
  if (prefix.unknown || prefix.alternatives !== undefined) return null;
  if (method === 'call') return prefix.values.slice(1);
  const list = prefix.values[1];
  if (list === undefined) return [];
  const value = unwrapped(list);
  if (
    value.kind === SyntaxKind.NullKeyword ||
    isVoidExpression(value) ||
    globalPathOf(value)?.join('.') === 'undefined'
  )
    return [];
  return framedAppliedArguments(call, list) ?? null;
}

/** Other uses could replace a function's own invokers; whole constant aliases are checked in turn. */
function nativeInvokers(target: Expression, resolve: Resolve): boolean {
  const value = unwrapped(target);
  if (!isIdentifier(value)) return true;
  const declaration = resolve(value);
  if (
    declaration === undefined ||
    (!isFunctionDeclaration(declaration) && !isVariableDeclaration(declaration))
  )
    return false;
  const bindings: CallableBinding[] = [declaration];
  const seen = new Set<Node>();
  for (let binding = bindings.pop(); binding !== undefined; binding = bindings.pop()) {
    if (seen.has(binding)) continue;
    seen.add(binding);
    const aliases = invocationAliases(binding, value.getSourceFile(), resolve);
    if (aliases === undefined) return false;
    bindings.push(...aliases);
  }
  return true;
}

/** Each lexical reference is a call or an immutable alias, otherwise native method identity is unknown. */
function invocationAliases(
  binding: CallableBinding,
  source: Node,
  resolve: Resolve,
): readonly VariableDeclaration[] | undefined {
  const aliases: VariableDeclaration[] = [];
  const pending: Node[] = [source];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    node.forEachChild((child) => {
      pending.push(child);
    });
    if (
      !isIdentifier(node) ||
      node === binding.name ||
      !readsBinding(node) ||
      resolve(node) !== binding
    )
      continue;
    const alias = constantAlias(node);
    if (alias !== undefined) aliases.push(alias);
    else if (!quietInvocation(node)) return undefined;
  }
  return aliases;
}

/** A whole immutable callable alias retains exactly the function value, never a destructuring slot. */
function constantAlias(name: Identifier): VariableDeclaration | undefined {
  const { at, parent } = useOf(name);
  if (
    !isExpression(at) ||
    !isVariableDeclaration(parent) ||
    parent.initializer !== at ||
    !isIdentifier(parent.name)
  )
    return undefined;
  const statement = parent.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    ? parent
    : undefined;
}

/** Calling the function or its native invokers does not expose its member table to another holder. */
function quietInvocation(name: Identifier): boolean {
  const { at, parent } = useOf(name);
  if (!isExpression(at)) return false;
  if (isCallExpression(parent)) {
    return (
      parent.expression === at ||
      (globalPathOf(parent.expression)?.join('.') === 'Reflect.apply' && parent.arguments[0] === at)
    );
  }
  if (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) return false;
  if (parent.expression !== at) return false;
  const method = frameMemberName(parent);
  const call = useOf(parent).parent;
  return (
    ['apply', 'bind', 'call'].includes(method ?? '') &&
    isCallExpression(call) &&
    unwrapped(call.expression) === parent
  );
}

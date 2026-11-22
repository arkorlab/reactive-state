import {
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedProxyHandlerEntryQuiet, framedProxyHandlerKey } from './framed-proxy-key-shapes.ts';
import { framedReflectedObjectValues } from './framed-reflected-objects.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedValueShape } from './framed-values.ts';

/**
 * Unwraps native identity, clone, reflected `Object`, and read-transparent `Proxy` wrappers around
 * an `Error` target so the universal written-word initializer proof can inspect the inner target.
 */

const IDENTITY_WRAPPERS: ReadonlySet<string> = new Set([
  'Object',
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'structuredClone',
]);

const PROXIES: ReadonlySet<string> = new Set(['Proxy']);
const FORWARDING_GET: ReadonlySet<string> = new Set(['Reflect.get', 'undefined']);

/** Returns the inner target expression when `value` is a supported non-intercepting wrapper. */
export function nonInterceptingWrappedTarget(value: Expression): Expression | undefined {
  return (
    identityWrappedArgument(value) ??
    reflectedObjectArgument(value) ??
    nonInterceptingProxyTarget(value)
  );
}

/** Single-argument native identity and clone helpers preserve a proven inner `Error`. */
function identityWrappedArgument(value: Expression): Expression | undefined {
  if (!isCallExpression(value) && !isNewExpression(value)) return undefined;
  const path = globalPathOf(unwrapped(value.expression))?.join('.');
  if (path === undefined || !IDENTITY_WRAPPERS.has(path)) return undefined;
  if (path !== 'Object' && isNewExpression(value)) return undefined;
  const args = value.arguments;
  const first = args?.length === 1 ? args[0] : undefined;
  return first === undefined || isSpreadElement(first) ? undefined : first;
}

/** Borrowed and reflected native `Object` invocations return their first object operand unchanged. */
function reflectedObjectArgument(value: Expression): Expression | undefined {
  const reflected = framedReflectedObjectValues(value);
  return reflected?.length === 1 ? reflected[0] : undefined;
}

/** `new Proxy(target, handler)` and `Proxy.revocable(target, handler).proxy` with no custom `get`. */
function nonInterceptingProxyTarget(value: Expression): Expression | undefined {
  const pair = proxyArgumentPair(value);
  if (pair === undefined) return undefined;
  const handler = framedValueShape(pair.handler).value;
  return isObjectLiteralExpression(handler) &&
    handler.properties.every((entry) => nonInterceptingProxyEntry(entry))
    ? pair.target
    : undefined;
}

/** Extracts `[target, handler]` from a 2-argument native `Proxy` or immediate `Proxy.revocable`. */
function proxyArgumentPair(
  value: Expression,
): { readonly handler: Expression; readonly target: Expression } | undefined {
  if (isNewExpression(value)) {
    return framedNativeConstructor(value.expression, PROXIES)
      ? twoPlainArguments(value.arguments ?? [])
      : undefined;
  }
  if (
    (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) ||
    frameMemberName(value) !== 'proxy'
  ) {
    return undefined;
  }
  const call = unwrapped(value.expression);
  if (!isCallExpression(call)) return undefined;
  const callee = unwrapped(call.expression);
  return (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
    frameMemberName(callee) === 'revocable' &&
    framedNativeConstructor(callee.expression, PROXIES)
    ? twoPlainArguments(call.arguments)
    : undefined;
}

/** Requires two non-spread positional arguments with no trailing side-effecting operands. */
function twoPlainArguments(
  args: readonly Expression[],
): { readonly handler: Expression; readonly target: Expression } | undefined {
  if (args.length !== 2) return undefined;
  const [target, handler] = args;
  return target === undefined ||
    handler === undefined ||
    isSpreadElement(target) ||
    isSpreadElement(handler)
    ? undefined
    : { handler, target };
}

/** Rejects spreads, `__proto__`, accessors, and any `get` trap other than nullish or `Reflect.get`. */
function nonInterceptingProxyEntry(entry: ObjectLiteralExpression['properties'][number]): boolean {
  if (isSpreadAssignment(entry) || isGetAccessorDeclaration(entry)) return false;
  const key = framedProxyHandlerKey(entry.name);
  if (key === undefined || key === '__proto__') return false;
  if (key !== 'get') return framedProxyHandlerEntryQuiet(entry);
  if (!isPropertyAssignment(entry)) return false;
  const trap = framedValueShape(entry.initializer).value;
  return trap.kind === SyntaxKind.NullKeyword || framedNativeConstructor(trap, FORWARDING_GET);
}

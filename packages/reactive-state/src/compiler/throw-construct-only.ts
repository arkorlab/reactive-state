import {
  type CallExpression,
  isBlock,
  isSourceFile,
  isVariableStatement,
  type Node,
  type Statement,
} from 'typescript/ast';

import { calledMember } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { writtenOf } from './throw-shapes.ts';

/**
 * The classes of globals a call of throws of, which `new` alone makes: the language's of its later
 * editions, `Map()`, a typed array's, `Intl`'s but `Collator`, `DateTimeFormat` and `NumberFormat`,
 * and the platform's, `URL()`.
 */
const CONSTRUCTED_ONLY: ReadonlySet<string> = new Set([
  'AbortController',
  'ArrayBuffer',
  'BigInt64Array',
  'BigUint64Array',
  'Blob',
  'DataView',
  'DOMException',
  'Event',
  'EventTarget',
  'File',
  'FinalizationRegistry',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'FormData',
  'Headers',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Intl.DisplayNames',
  'Intl.DurationFormat',
  'Intl.ListFormat',
  'Intl.Locale',
  'Intl.PluralRules',
  'Intl.RelativeTimeFormat',
  'Intl.Segmenter',
  'Map',
  'Promise',
  'Proxy',
  'ReadableStream',
  'Request',
  'Response',
  'Set',
  'SharedArrayBuffer',
  'TextDecoder',
  'TextEncoder',
  'TransformStream',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
  'URL',
  'URLSearchParams',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  'WebAssembly.Instance',
  'WebAssembly.Memory',
  'WebAssembly.Module',
  'WebAssembly.Table',
  'WritableStream',
]);

/** Additional platform classes whose ordinary invocation has no [[Call]] behavior. */
const PLATFORM_ONLY: ReadonlySet<string> = new Set([
  'ByteLengthQueuingStrategy',
  'CompressionStream',
  'CountQueuingStrategy',
  'DecompressionStream',
  'TextDecoderStream',
  'TextEncoderStream',
  'WebAssembly.Exception',
  'WebAssembly.Global',
  'WebAssembly.Tag',
]);

/** Existing construct-only checks, plus source-proven unchanged platform constructors. */
export function constructOnlyCallThrows(
  call: CallExpression,
  path: string,
  resolve: Resolve | undefined,
): boolean {
  if (CONSTRUCTED_ONLY.has(path)) {
    return true;
  }
  const follow: Resolve = (name) => {
    const held = resolve?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, call) ? undefined : held;
  };
  const selected = additionalConstructor(call, follow);
  const native = selected?.path ?? path;
  return (
    PLATFORM_ONLY.has(native) && quietNativeCall(call, native, follow, selected?.reflected ?? false)
  );
}

/** An unchanged additional native class, called directly or through an explicit Function forwarder. */
function additionalConstructor(
  call: CallExpression,
  resolve: Resolve,
): { readonly path: string; readonly reflected: boolean } | undefined {
  const callee = writtenOf(call.expression, resolve);
  const path = globalCalleePath(callee, resolve)?.join('.') ?? '';
  if (PLATFORM_ONLY.has(path)) {
    return { path, reflected: false };
  }
  const reflected = path === 'Reflect.apply';
  const member = calledMember(callee);
  const target = reflected ? call.arguments[0] : member?.of;
  if (
    target === undefined ||
    (!reflected && member?.name !== 'call' && member?.name !== 'apply') ||
    calleeUncertain(target, call)
  ) {
    return undefined;
  }
  const native = globalCalleePath(target, resolve)?.join('.') ?? '';
  return PLATFORM_ONLY.has(native) ? { path: native, reflected } : undefined;
}

/** Known native construct-only classes other than Promise never call a capability executor. */
export function nativeCapabilitylessConstructor(path: string): boolean {
  return path !== 'Promise' && (CONSTRUCTED_ONLY.has(path) || PLATFORM_ONLY.has(path));
}

/** Argument creation and enclosing work have not replaced the selected native operation. */
export function quietNativeCall(
  call: CallExpression,
  path: string,
  resolve: Resolve | undefined,
  reflected = false,
): boolean {
  return (
    !earlierExpressionEffect(call) &&
    call.arguments.every(
      (each, index) =>
        (reflected && index === 0) || !callbackCreationEffect(writtenOf(each, resolve)),
    ) &&
    !priorEffect(call, path, resolve)
  );
}

/** Enclosing immediate-function scopes retain the effects before their invocation. */
function priorEffect(call: CallExpression, path: string, resolve: Resolve | undefined): boolean {
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && statementEffect(statement, call, path, resolve),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Reading a stable alias of this selected native does not itself replace the native. */
function statementEffect(
  statement: Statement,
  call: CallExpression,
  path: string,
  resolve: Resolve | undefined,
): boolean {
  if (!isVariableStatement(statement)) {
    return callbackCreationEffect(statement);
  }
  return statement.declarationList.declarations.some((declaration) => {
    const value = declaration.initializer;
    if (
      value !== undefined &&
      globalCalleePath(value, resolve)?.join('.') === path &&
      !calleeUncertain(value, call)
    ) {
      return false;
    }
    return callbackCreationEffect(declaration);
  });
}

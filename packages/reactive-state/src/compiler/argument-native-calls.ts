import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isNewExpression,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVoidExpression,
  type NewExpression,
  type Node,
  SyntaxKind,
  type TaggedTemplateExpression,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { BUILT_INS } from './built-ins.ts';
import { globalPathOf } from './code-globals.ts';
import { unmutatedTuple } from './tuple-spreads.ts';

/** Synchronous callback classification and tuple-spread expansion for native invocations. */

export type NativeInvocation = CallExpression | NewExpression | TaggedTemplateExpression;
export type CalleeLookup = (node: Expression) => Node | undefined;
export type NativeDecision =
  | { readonly kind: 'accepted' }
  | { readonly body: Node; readonly fn: Answering; readonly kind: 'callback' }
  | { readonly kind: 'rejected' };

interface ExpandedArguments {
  readonly unresolvedAt: number | undefined;
  readonly values: readonly Expression[];
}

const SECOND_CALLBACK_NATIVES: ReadonlySet<string> = new Set([
  'Array.from',
  'JSON.parse',
  'JSON.stringify',
  'Map.groupBy',
  'Object.groupBy',
]);
const STREAM_CONSTRUCTORS: ReadonlySet<string> = new Set([
  'ReadableStream',
  'TransformStream',
  'WritableStream',
]);
const UNSAFE_NATIVES: ReadonlySet<string> = new Set([
  'Array.fromAsync',
  'eval',
  'Promise.try',
  'ReadableStream.from',
  'Reflect.apply',
  'Reflect.construct',
]);
const IGNORED_JSON_CALLBACKS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateExpression,
  SyntaxKind.TrueKeyword,
]);

/** Classifies a built-in invocation as hook-free, synchronous-callback, or conservatively unsafe. */
export function classifyNativeInvocation(
  node: NativeInvocation,
  path: readonly string[],
  calleeOf: CalleeLookup,
): NativeDecision {
  const named = path.join('.');
  if (isUnsafeNativePath(named, path)) {
    return { kind: 'rejected' };
  }
  const streamConstructor = STREAM_CONSTRUCTORS.has(named);
  const slot = nativeCallbackSlot(node, named, path);
  if (!streamConstructor && slot === undefined) {
    return { kind: 'accepted' };
  }
  const given = isTaggedTemplateExpression(node) ? tagArguments(node) : (node.arguments ?? []);
  const expanded = expandNativeArguments(given);
  if (streamConstructor) {
    return {
      kind:
        expanded.values.length === 0 && expanded.unresolvedAt === undefined
          ? 'accepted'
          : 'rejected',
    };
  }
  return slot === undefined
    ? { kind: 'accepted' }
    : classifyExpandedSlot(expanded, slot, named, calleeOf);
}

/** Rejects reflective, prototype, borrowed, eval and WebAssembly global paths. */
function isUnsafeNativePath(named: string, path: readonly string[]): boolean {
  const [root = ''] = path;
  const tail = path.at(-1);
  return (
    root === 'WebAssembly' ||
    UNSAFE_NATIVES.has(named) ||
    path.includes('prototype') ||
    tail === 'call' ||
    tail === 'apply'
  );
}

/** Inspects `slot` on expanded native arguments after checking for covering unresolved spreads. */
function classifyExpandedSlot(
  expanded: ExpandedArguments,
  slot: number,
  named: string,
  calleeOf: CalleeLookup,
): NativeDecision {
  if (expanded.unresolvedAt !== undefined && expanded.unresolvedAt <= slot) {
    return { kind: 'rejected' };
  }
  const callback = expanded.values[slot];
  return callback === undefined || callback.kind === SyntaxKind.OmittedExpression
    ? { kind: 'accepted' }
    : classifyNativeCallback(callback, named, calleeOf);
}

/** Native tag strings are present before any substitutions. */
export function tagArguments(node: Node): readonly Expression[] {
  if (!isTaggedTemplateExpression(node)) {
    return [];
  }
  const substitutions = isTemplateExpression(node.template)
    ? node.template.templateSpans.map((span) => span.expression)
    : [];
  return [node.template, ...substitutions];
}

/** The argument index where a built-in accepts a synchronous callback, or none when it takes none. */
function nativeCallbackSlot(
  node: NativeInvocation,
  named: string,
  path: readonly string[],
): number | undefined {
  if (named === 'Promise' && isNewExpression(node)) {
    return 0;
  }
  const [root = '', member] = path;
  const typedFrom =
    path.length === 2 && member === 'from' && root.endsWith('Array') && BUILT_INS.has(root);
  return typedFrom || SECOND_CALLBACK_NATIVES.has(named) ? 1 : undefined;
}

/** Resolves a synchronous native callback's callable body, or rejects an unproven callable. */
function classifyNativeCallback(
  callback: Expression,
  named: string,
  calleeOf: CalleeLookup,
): NativeDecision {
  const fn = calleeOf(callback);
  if (fn === undefined) {
    return { kind: 'rejected' };
  }
  if (
    isVoidExpression(fn) ||
    globalPathOf(fn)?.join('.') === 'undefined' ||
    ((named === 'JSON.parse' || named === 'JSON.stringify') && IGNORED_JSON_CALLBACKS.has(fn.kind))
  ) {
    return { kind: 'accepted' };
  }
  return isAnswering(fn) && fn.body !== undefined
    ? { body: fn.body, fn, kind: 'callback' }
    : { kind: 'rejected' };
}

/** Expands unmutated array-literal spreads and records the earliest unresolved spread index. */
function expandNativeArguments(given: readonly Expression[]): ExpandedArguments {
  const values: Expression[] = [];
  const stack = given.toReversed();
  const seen = new Set<ArrayLiteralExpression>();
  let unresolvedAt: number | undefined;
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (!isSpreadElement(current)) {
      values.push(current);
      continue;
    }
    const tuple = unmutatedTuple(current.expression);
    if (tuple === undefined || seen.has(tuple)) {
      unresolvedAt ??= values.length;
      continue;
    }
    seen.add(tuple);
    stack.push(...tuple.elements.toReversed());
  }
  return { unresolvedAt, values };
}

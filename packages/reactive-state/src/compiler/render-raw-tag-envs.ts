import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBindingElement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isSpreadElement,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { computedBindingContainer } from './framed-keys.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { constantValue } from './numbers.ts';
import type {
  TagBoundValue,
  TagParameterEntry,
  TagParameterEnv,
  TagParameterValue,
  TagPath,
} from './render-raw-tag-calls.ts';
import { canonicalArrayTagIndex } from './render-raw-tag-paths.ts';
import { bindingIdentifiers } from './scope.ts';

/** Canonicalized parameter-binding environments and bounded recursion widening for tag factories. */

const ENV_DEPTH_LIMIT = 8;
const ENV_IDS_BY_FILE = new WeakMap<Node, Map<string, number>>();

/** Expands a parameter identifier bound by an enclosing factory invocation. */
export function pushFactoryParameterTagPaths(
  name: Identifier,
  declared: ParameterDeclaration,
  suffix: readonly (string | undefined)[],
  context: { readonly env: TagParameterEnv | undefined; readonly pending: TagPath[] },
): { readonly handled: boolean; readonly opaque: boolean } {
  const entry = context.env?.entries.get(declared);
  if (entry === undefined) return { handled: false, opaque: false };
  if (entry.kind === 'opaque') return { handled: true, opaque: true };
  const keys = frameBindingOf(name)?.keys ?? [];
  pushBoundParameterValues(entry, [...keys, ...suffix], context.pending);
  return { handled: true, opaque: false };
}

function pushBoundParameterValues(
  entry: TagParameterValue,
  fullSuffix: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  if (entry.rest === true) {
    pushRestParameterValues(entry, fullSuffix, pending);
    return;
  }
  for (const item of entry.values) {
    pending.push({ env: item.env, node: item.node, suffix: fullSuffix });
  }
}

function pushRestParameterValues(
  entry: TagParameterValue,
  fullSuffix: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  if (fullSuffix.length === 0) return;
  const [head, ...tail] = fullSuffix;
  if (head === undefined) {
    for (const item of entry.values) {
      pending.push({ env: item.env, node: item.node, suffix: tail });
    }
    return;
  }
  const index = canonicalArrayTagIndex(head);
  const selected = index === undefined ? undefined : entry.values[index];
  if (selected !== undefined) {
    pending.push({ env: selected.env, node: selected.node, suffix: tail });
  }
}

/** Builds a canonicalized `TagParameterEnv` for invoking `fn` with `given` under `callerEnv`. */
export function buildFactoryParameterEnv(
  fn: Answering,
  given: readonly TagBoundValue[] | null,
  callerEnv: TagParameterEnv | undefined,
): TagParameterEnv | undefined {
  const params = runtimeParameters(fn);
  if (params.length === 0) return callerEnv;
  if (given === null) return buildOpaqueParameterEnv(fn, callerEnv);
  const root = fn.getSourceFile();
  const entries = new Map<ParameterDeclaration, TagParameterEntry>(callerEnv?.entries);
  for (const param of params) entries.set(param, { kind: 'opaque' });
  const firstSpread = given.findIndex((arg) => isSpreadElement(arg.node));
  let widened = false;
  for (const [index, param] of params.entries()) {
    const defaultEnv = createTagParameterEnv(root, new Map(entries), widened);
    const bound = bindOneParameter(param, index, { defaultEnv, firstSpread, given });
    if (bound.widened) widened = true;
    entries.set(param, bound.entry);
  }
  return createTagParameterEnv(root, entries, widened);
}

function buildOpaqueParameterEnv(
  fn: Answering,
  callerEnv: TagParameterEnv | undefined,
): TagParameterEnv | undefined {
  const params = runtimeParameters(fn);
  if (params.length === 0) return callerEnv;
  const entries = new Map<ParameterDeclaration, TagParameterEntry>(callerEnv?.entries);
  for (const param of params) entries.set(param, { kind: 'opaque' });
  const widened = (callerEnv?.depth ?? 0) >= ENV_DEPTH_LIMIT;
  return createTagParameterEnv(fn.getSourceFile(), entries, widened);
}

function createTagParameterEnv(
  root: Node,
  entries: ReadonlyMap<ParameterDeclaration, TagParameterEntry>,
  widened: boolean,
): TagParameterEnv {
  let innerDepth = 0;
  for (const entry of entries.values()) {
    if (entry.kind === 'opaque') continue;
    for (const item of entry.values) {
      if (item.env !== undefined && item.env.depth > innerDepth) {
        innerDepth = item.env.depth;
      }
    }
  }
  const depth = widened ? ENV_DEPTH_LIMIT : Math.min(ENV_DEPTH_LIMIT, innerDepth + 1);
  return {
    depth,
    entries,
    id: internParameterEnvId(root, entries),
  };
}

function internParameterEnvId(
  root: Node,
  entries: ReadonlyMap<ParameterDeclaration, TagParameterEntry>,
): number {
  let table = ENV_IDS_BY_FILE.get(root);
  if (table === undefined) {
    table = new Map<string, number>();
    ENV_IDS_BY_FILE.set(root, table);
  }
  const signature = [...entries]
    .toSorted(([left], [right]) => left.pos - right.pos)
    .map(([param, entry]) => `${String(param.pos)}=${serializeParameterEntry(entry)}`)
    .join(';');
  const existing = table.get(signature);
  if (existing !== undefined) return existing;
  const nextId = table.size + 1;
  table.set(signature, nextId);
  return nextId;
}

function serializeParameterEntry(entry: TagParameterEntry): string {
  if (entry.kind === 'opaque') return '?';
  const prefix = entry.rest === true ? '...' : '';
  const items = entry.values
    .map((item) => {
      const scope = item.env === undefined ? '' : `@${String(item.env.id)}`;
      return `${String(item.node.pos)}:${String(item.node.end)}${scope}`;
    })
    .join(',');
  return `${prefix}[${items}]`;
}

function bindOneParameter(
  param: ParameterDeclaration,
  index: number,
  callArgs: {
    readonly defaultEnv: TagParameterEnv;
    readonly firstSpread: number;
    readonly given: readonly TagBoundValue[];
  },
): { readonly entry: TagParameterEntry; readonly widened: boolean } {
  const { defaultEnv, firstSpread, given } = callArgs;
  if (firstSpread !== -1 && index >= firstSpread) {
    return { entry: { kind: 'opaque' }, widened: false };
  }
  if (param.dotDotDotToken !== undefined) {
    return bindRestParameter(given.slice(index), firstSpread);
  }
  const arg = given[index];
  const values: TagBoundValue[] = [];
  if (arg !== undefined && !isDefinitelyUndefined(arg.node)) {
    const status = appendBoundExpr(arg.node, arg.env, values);
    if (status !== 'ok') return { entry: { kind: 'opaque' }, widened: status === 'widened' };
  }
  if (param.initializer !== undefined && (arg === undefined || !isDefinitelyPresent(arg.node))) {
    const status = appendBoundExpr(param.initializer, defaultEnv, values);
    if (status !== 'ok') return { entry: { kind: 'opaque' }, widened: status === 'widened' };
  }
  return { entry: { kind: 'values', values }, widened: false };
}

function bindRestParameter(
  restArgs: readonly TagBoundValue[],
  firstSpread: number,
): { readonly entry: TagParameterEntry; readonly widened: boolean } {
  if (firstSpread !== -1) return { entry: { kind: 'opaque' }, widened: false };
  const values: TagBoundValue[] = [];
  for (const item of restArgs) {
    const forwarded = unwrapDirectParameterArg(item.node, item.env);
    if (forwarded?.kind === 'opaque') return { entry: { kind: 'opaque' }, widened: false };
    const single = forwarded?.values.length === 1 ? forwarded.values[0] : undefined;
    if (single !== undefined) {
      values.push(single);
      continue;
    }
    if ((item.env?.depth ?? 0) >= ENV_DEPTH_LIMIT) {
      return { entry: { kind: 'opaque' }, widened: true };
    }
    values.push(item);
  }
  return { entry: { kind: 'values', rest: true, values }, widened: false };
}

function appendBoundExpr(
  expr: Expression,
  env: TagParameterEnv | undefined,
  values: TagBoundValue[],
): 'ok' | 'opaque' | 'widened' {
  const forwarded = unwrapDirectParameterArg(expr, env);
  if (forwarded !== undefined) {
    if (forwarded.kind === 'opaque') return 'opaque';
    values.push(...forwarded.values);
    return 'ok';
  }
  if ((env?.depth ?? 0) >= ENV_DEPTH_LIMIT) return 'widened';
  values.push({ env, node: expr });
  return 'ok';
}

function unwrapDirectParameterArg(
  expr: Expression,
  env: TagParameterEnv | undefined,
): TagParameterEntry | undefined {
  if (env === undefined) return undefined;
  const actual = unwrapped(expr);
  if (!isIdentifier(actual) || framedAssignedSources(actual).length > 0) return undefined;
  const declared = frameDeclarationOf(actual);
  if (declared === undefined || !isParameterDeclaration(declared) || !isIdentifier(declared.name)) {
    return undefined;
  }
  if (
    declared.initializer !== undefined &&
    isArrayLiteralExpression(unwrapped(declared.initializer))
  ) {
    return undefined;
  }
  const entry = env.entries.get(declared);
  return entry !== undefined && (entry.kind === 'opaque' || entry.rest !== true)
    ? entry
    : undefined;
}

function runtimeParameters(fn: Answering): readonly ParameterDeclaration[] {
  return fn.parameters.filter((each) => !isIdentifier(each.name) || each.name.text !== 'this');
}

function isDefinitelyUndefined(value: Expression): boolean {
  const actual = unwrapped(value);
  return isVoidExpression(actual) || globalPathOf(actual)?.join('.') === 'undefined';
}

function isDefinitelyPresent(value: Expression): boolean {
  const actual = unwrapped(value);
  return (
    isObjectLiteralExpression(actual) ||
    isArrayLiteralExpression(actual) ||
    isNewExpression(actual) ||
    isArrowFunction(actual) ||
    isFunctionExpression(actual) ||
    actual.kind === SyntaxKind.NullKeyword ||
    actual.kind === SyntaxKind.TrueKeyword ||
    actual.kind === SyntaxKind.FalseKeyword ||
    constantValue(actual) !== undefined
  );
}

/** True when `value` is an unbound callable identifier leaf that may expose `.bind`/`.call`/`.apply`. */
export function callableIdentifierLeaf(
  value: Expression,
  suffixLength: number,
  env: TagParameterEnv | undefined,
): boolean {
  if (!isIdentifier(value)) return false;
  const declared = frameDeclarationOf(value);
  if (declared === undefined) return false;
  if (isFunctionDeclaration(declared)) return suffixLength === 1;
  if (!isParameterDeclaration(declared) && !isVariableDeclaration(declared)) return false;
  if (isParameterDeclaration(declared) && env?.entries.get(declared)?.kind === 'values') {
    return false;
  }
  return !identifierHasSources(value, declared);
}

function identifierHasSources(
  name: Identifier,
  declared: ParameterDeclaration | VariableDeclaration,
): boolean {
  if (framedAssignedSources(name).length > 0) return true;
  const found = bindingIdentifiers(declared.name).find(
    (identifier) => identifier.text === name.text,
  );
  const bound = found !== undefined && isBindingElement(found.parent) ? found.parent : undefined;
  if (bound?.initializer !== undefined) return true;
  const selected = frameBindingOf(name);
  if (selected !== undefined) return selected.binding.initializer !== undefined;
  return bound !== undefined && computedBindingContainer(bound)?.binding.initializer !== undefined;
}

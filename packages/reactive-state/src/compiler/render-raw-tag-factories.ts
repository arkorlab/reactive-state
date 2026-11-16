import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isSpreadElement,
  isVoidExpression,
  type MethodDeclaration,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, overloadsOf, returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedAppliedArguments } from './framed-keys.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { constantValue } from './numbers.ts';
import {
  boundCallTargets,
  tagPathKey,
  type TagParameterEntry,
  type TagParameterEnv,
  type TagParameterValue,
  type TagPath,
} from './render-raw-tag-calls.ts';
import { canonicalArrayTagIndex, type ObjectTagSink } from './render-raw-tag-paths.ts';

/** Factory-call and parameter-bound path expansions for template tag candidates. */

type CalleeStepOutcome = 'done' | 'expand' | 'unresolved';

export type FactoryStepExpander = (
  value: Expression,
  suffix: readonly (string | undefined)[],
  sink: ObjectTagSink,
) => boolean;

interface FactoryCalleeItem {
  readonly node: Expression;
  readonly suffix: readonly (string | undefined)[];
  readonly given: readonly Expression[] | null;
  readonly env: TagParameterEnv | undefined;
}

interface FactoryResolveContext {
  readonly call?: CallExpression | undefined;
  readonly callSitePos: number;
  readonly outerSuffix: readonly (string | undefined)[];
  readonly pending: TagPath[];
  readonly callees: FactoryCalleeItem[];
  readonly step: FactoryStepExpander;
}

const FACTORY_SEARCH = { depth: 8, limit: 64 } as const;

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
  for (const value of entry.values) {
    pending.push({ env: entry.callerEnv, node: value, suffix: fullSuffix });
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
    for (const value of entry.values) {
      pending.push({ env: entry.callerEnv, node: value, suffix: tail });
    }
    return;
  }
  const index = canonicalArrayTagIndex(head);
  const selected = index === undefined ? undefined : entry.values[index];
  if (selected !== undefined) {
    pending.push({ env: entry.callerEnv, node: selected, suffix: tail });
  }
}

/** Resolves factory call return paths, returning `true` when any candidate callee remains opaque. */
export function expandFactoryCallTagPaths(
  call: CallExpression,
  outerSuffix: readonly (string | undefined)[],
  env: TagParameterEnv | undefined,
  options: {
    readonly step: FactoryStepExpander;
    readonly pending: TagPath[];
    readonly depth: number;
  },
): boolean {
  if (options.depth >= FACTORY_SEARCH.depth) return true;
  const initial = seedFactoryCallees(call, env);
  if (initial === undefined) return true;
  const callees = [...initial];
  return drainFactoryCallees(callees, {
    call,
    callSitePos: call.pos,
    callees,
    outerSuffix,
    pending: options.pending,
    step: options.step,
  });
}

/** Resolves a factory expression invoked as a template tag (`makeRaw\`...\`\`${date}\``). */
export function expandTaggedFactoryPaths(
  calleeTag: Expression,
  callSitePos: number,
  outerSuffix: readonly (string | undefined)[],
  options: {
    readonly env: TagParameterEnv | undefined;
    readonly step: FactoryStepExpander;
    readonly pending: TagPath[];
    readonly depth: number;
  },
): boolean {
  if (options.depth >= FACTORY_SEARCH.depth) return true;
  const callees: FactoryCalleeItem[] = [
    { env: options.env, given: null, node: calleeTag, suffix: [] },
  ];
  return drainFactoryCallees(callees, {
    callSitePos,
    callees,
    outerSuffix,
    pending: options.pending,
    step: options.step,
  });
}

function drainFactoryCallees(
  callees: FactoryCalleeItem[],
  context: FactoryResolveContext,
): boolean {
  const seen = new Set<string>();
  let steps = 0;
  for (let current = callees.pop(); current !== undefined; current = callees.pop()) {
    steps += 1;
    if (steps > FACTORY_SEARCH.limit) return true;
    const value = unwrapped(current.node);
    const key = `${tagPathKey(value, current.suffix, current.env)}:${String(current.given?.length ?? -1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (stepFactoryCallee(value, current, context) === 'unresolved') return true;
  }
  return false;
}

function seedFactoryCallees(
  call: CallExpression,
  env: TagParameterEnv | undefined,
): readonly FactoryCalleeItem[] | undefined {
  const callee = unwrapped(call.expression);
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    const [target, , argList] = call.arguments;
    if (target === undefined || isSpreadElement(target)) return undefined;
    return [{ env, given: extractAppliedList(call, argList), node: target, suffix: [] }];
  }
  return [{ env, given: call.arguments, node: call.expression, suffix: [] }];
}

function stepFactoryCallee(
  value: Expression,
  current: FactoryCalleeItem,
  context: FactoryResolveContext,
): CalleeStepOutcome {
  if (current.suffix.length === 0) {
    const direct = stepZeroSuffixCallee(value, current, context);
    if (direct !== 'expand') return direct;
  }
  if (current.suffix.length === 1 && isDirectCallableLeaf(value)) {
    return stepCallableMethodSuffix(value, current, context);
  }
  return expandIndirectCallee(value, current, context);
}

function stepZeroSuffixCallee(
  value: Expression,
  current: FactoryCalleeItem,
  context: FactoryResolveContext,
): CalleeStepOutcome {
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    pushCallableReturnPaths(value, current, context);
    return 'done';
  }
  if (isIdentifier(value)) return stepIdentifierZeroSuffix(value, current, context);
  if (isCallExpression(value)) return stepBoundCalleeCall(value, current, context);
  return 'expand';
}

function stepIdentifierZeroSuffix(
  name: Identifier,
  current: FactoryCalleeItem,
  context: FactoryResolveContext,
): CalleeStepOutcome {
  const declared = frameDeclarationOf(name);
  if (declared === undefined || !isFunctionDeclaration(declared)) return 'expand';
  for (const source of framedAssignedSources(name)) {
    context.callees.push({ ...current, node: source.value, suffix: [...source.keys] });
  }
  const impls = overloadsOf(declared).filter((fn) => fn.body !== undefined);
  if (impls.length === 0) return 'unresolved';
  for (const fn of impls) pushCallableReturnPaths(fn, current, context);
  return 'done';
}

function stepBoundCalleeCall(
  value: CallExpression,
  current: FactoryCalleeItem,
  context: FactoryResolveContext,
): CalleeStepOutcome {
  const bound = boundCallTargets(value, (inner, innerSuffix, nextPending) => {
    return context.step(inner, innerSuffix, {
      env: current.env,
      methods: [],
      pending: nextPending,
    });
  });
  if (bound.exhausted) return 'unresolved';
  if (!bound.handled) return 'expand';
  for (const target of bound.targets) {
    context.callees.push({
      env: current.env,
      given: mergeCallArguments(target.given, current.given),
      node: target.node,
      suffix: [],
    });
  }
  return 'done';
}

function stepCallableMethodSuffix(
  value: Expression,
  current: FactoryCalleeItem,
  context: FactoryResolveContext,
): CalleeStepOutcome {
  if (isIdentifier(value)) {
    for (const source of framedAssignedSources(value)) {
      context.callees.push({
        ...current,
        node: source.value,
        suffix: [...source.keys, ...current.suffix],
      });
    }
  }
  const [member] = current.suffix;
  if (member === 'call') {
    context.callees.push({
      env: current.env,
      given: sliceCallReceiverArg(current.given),
      node: value,
      suffix: [],
    });
    return 'done';
  }
  if (member === 'apply') {
    context.callees.push({
      env: current.env,
      given: extractMethodApplyArgs(context.call, current.given),
      node: value,
      suffix: [],
    });
    return 'done';
  }
  if (member === undefined) {
    context.callees.push({ env: current.env, given: null, node: value, suffix: [] });
    context.pending.push({ env: current.env, node: value, suffix: context.outerSuffix });
    return 'done';
  }
  return 'unresolved';
}

function expandIndirectCallee(
  value: Expression,
  current: FactoryCalleeItem,
  context: FactoryResolveContext,
): CalleeStepOutcome {
  if (globalPathOf(value) !== undefined) return 'unresolved';
  const stepPaths: TagPath[] = [];
  const stepMethods: MethodDeclaration[] = [];
  if (
    context.step(value, current.suffix, {
      env: current.env,
      methods: stepMethods,
      pending: stepPaths,
    })
  ) {
    return 'unresolved';
  }
  for (const method of stepMethods) {
    if (method.body === undefined) return 'unresolved';
    pushCallableReturnPaths(method, current, context);
  }
  for (const next of stepPaths) {
    context.callees.push({
      env: next.env,
      given: current.given,
      node: next.node,
      suffix: next.suffix,
    });
  }
  if (stepMethods.length > 0 || stepPaths.length > 0) return 'done';
  return isClosedMissingMemberLiteral(value, current.suffix) ? 'done' : 'unresolved';
}

function isClosedMissingMemberLiteral(
  value: Expression,
  suffix: readonly (string | undefined)[],
): boolean {
  return suffix.length > 0 && (isObjectLiteralExpression(value) || isArrayLiteralExpression(value));
}

function isDirectCallableLeaf(value: Expression): boolean {
  if (isArrowFunction(value) || isFunctionExpression(value)) return true;
  if (!isIdentifier(value)) return false;
  const declared = frameDeclarationOf(value);
  return declared !== undefined && isFunctionDeclaration(declared);
}

function pushCallableReturnPaths(
  fn: Answering,
  current: FactoryCalleeItem,
  context: FactoryResolveContext,
): void {
  const calleeEnv = buildFactoryParameterEnv(context.callSitePos, fn, current.given, current.env);
  for (const returned of returnedBy(fn)) {
    context.pending.push({ env: calleeEnv, node: returned, suffix: context.outerSuffix });
  }
}

function buildOpaqueParameterEnv(
  fn: Answering,
  callSitePos: number,
  callerEnv: TagParameterEnv | undefined,
): TagParameterEnv | undefined {
  const params = runtimeParameters(fn);
  if (params.length === 0) return callerEnv;
  const entries = new Map<ParameterDeclaration, TagParameterEntry>(callerEnv?.entries);
  for (const param of params) entries.set(param, { kind: 'opaque' });
  return { entries, id: callSitePos };
}

function buildFactoryParameterEnv(
  callSitePos: number,
  fn: Answering,
  given: readonly Expression[] | null,
  callerEnv: TagParameterEnv | undefined,
): TagParameterEnv | undefined {
  const params = runtimeParameters(fn);
  if (params.length === 0) return callerEnv;
  if (given === null) return buildOpaqueParameterEnv(fn, callSitePos, callerEnv);
  const entries = new Map<ParameterDeclaration, TagParameterEntry>(callerEnv?.entries);
  const firstSpread = given.findIndex((arg) => isSpreadElement(arg));
  const callArgs = { callerEnv, firstSpread, given };
  for (const [index, param] of params.entries()) {
    entries.set(param, bindOneParameter(param, index, callArgs));
  }
  return { entries, id: callSitePos };
}

function bindOneParameter(
  param: ParameterDeclaration,
  index: number,
  callArgs: {
    readonly given: readonly Expression[];
    readonly firstSpread: number;
    readonly callerEnv: TagParameterEnv | undefined;
  },
): TagParameterEntry {
  const { callerEnv, firstSpread, given } = callArgs;
  if (firstSpread !== -1 && index >= firstSpread) return { kind: 'opaque' };
  if (param.dotDotDotToken !== undefined) {
    return firstSpread === -1
      ? { callerEnv, kind: 'values', rest: true, values: given.slice(index) }
      : { kind: 'opaque' };
  }
  const arg = given[index];
  const values: Expression[] = [];
  if (arg !== undefined && !isDefinitelyUndefined(arg)) values.push(arg);
  if (param.initializer !== undefined && (arg === undefined || !isDefinitelyPresent(arg))) {
    values.push(param.initializer);
  }
  return { callerEnv, kind: 'values', values };
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

function mergeCallArguments(
  prefix: readonly Expression[] | null,
  rest: readonly Expression[] | null,
): readonly Expression[] | null {
  return prefix === null || rest === null ? null : [...prefix, ...rest];
}

function sliceCallReceiverArg(given: readonly Expression[] | null): readonly Expression[] | null {
  if (given === null) return null;
  const [first, ...rest] = given;
  return first !== undefined && isSpreadElement(first) ? null : rest;
}

function extractMethodApplyArgs(
  call: CallExpression | undefined,
  given: readonly Expression[] | null,
): readonly Expression[] | null {
  if (call === undefined || given === null) return null;
  const [first, list] = given;
  if (first !== undefined && isSpreadElement(first)) return null;
  return extractAppliedList(call, list);
}

function extractAppliedList(
  call: CallExpression,
  list: Expression | undefined,
): readonly Expression[] | null {
  if (list === undefined) return [];
  if (isSpreadElement(list)) return null;
  return framedAppliedArguments(call, list) ?? null;
}

import {
  type CallExpression,
  type Expression,
  isArrowFunction,
  isCallExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type ParameterDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { GLOBAL_OBJECTS, globalPathOf } from './code-globals.ts';
import { framedAppliedArguments } from './framed-keys.ts';
import { writtenArguments } from './framed-native-calls.ts';
import { framedSourceValues } from './framed-sources.ts';
import { reflectedRead } from './render-intl-reflections.ts';
import { callableIdentifierLeaf } from './render-raw-tag-envs.ts';

/** Bounded unwrapping of `.bind`, `.call`, `.apply` and `Reflect.apply` tag expressions. */

export type BoundArgCount = number | 'unknown';

export interface TagBoundValue {
  readonly env: TagParameterEnv | undefined;
  readonly node: Expression;
}

export interface TagParameterValue {
  readonly kind: 'values';
  readonly rest?: boolean | undefined;
  readonly values: readonly TagBoundValue[];
}

export type TagParameterEntry = TagParameterValue | { readonly kind: 'opaque' };

export interface TagParameterEnv {
  readonly depth: number;
  readonly entries: ReadonlyMap<ParameterDeclaration, TagParameterEntry>;
  readonly id: number;
}

export interface TagPath {
  readonly boundArgs?: BoundArgCount | undefined;
  readonly env?: TagParameterEnv | undefined;
  readonly node: Expression;
  readonly suffix: readonly (string | undefined)[];
}

export interface BoundCallTarget {
  readonly env: TagParameterEnv | undefined;
  readonly given: readonly TagBoundValue[] | null;
  readonly node: Expression;
}

export interface BoundCallResolution {
  readonly exhausted: boolean;
  readonly handled: boolean;
  readonly targets: readonly BoundCallTarget[];
}

export type ExpandTagPath = (
  value: Expression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
  env: TagParameterEnv | undefined,
) => boolean;

type WrapperMethod = 'apply' | 'bind' | 'call';

interface CallState {
  readonly call: CallExpression;
  readonly expand: ExpandTagPath;
  exhausted: boolean;
  nonBoundCall: boolean;
  steps: number;
}

interface CallContext {
  readonly env: TagParameterEnv | undefined;
  readonly state: CallState;
}

type TagCallable =
  | {
      readonly env: TagParameterEnv | undefined;
      readonly kind: 'target';
      readonly node: Expression;
    }
  | { readonly kind: 'method'; readonly method: WrapperMethod }
  | { readonly kind: 'reflect-apply' }
  | {
      readonly given: readonly TagBoundValue[] | null;
      readonly kind: 'bound';
      readonly self: TagCallable | undefined;
      readonly target: TagCallable;
    };

const WRAPPER_METHODS: readonly WrapperMethod[] = ['apply', 'bind', 'call'];
const PLAIN_GLOBAL_NAMESPACES: ReadonlySet<string> = new Set([
  'Atomics',
  'Intl',
  'JSON',
  'Math',
  'Reflect',
]);
const CALL_SEARCH = { limit: 64 } as const;

/** Resolves bound function targets and bound argument prefixes produced by `call`. */
export function boundCallTargets(
  call: CallExpression,
  expand: ExpandTagPath,
  env?: TagParameterEnv,
): BoundCallResolution {
  const state: CallState = {
    call,
    exhausted: false,
    expand,
    nonBoundCall: false,
    steps: 0,
  };
  const targets: BoundCallTarget[] = [];
  const evaluated = evaluateTagCall(call, { env, state });
  for (const item of evaluated) {
    const target = boundLeafTarget(item);
    if (target !== undefined) targets.push(target);
  }
  return {
    exhausted: state.exhausted,
    handled: targets.length > 0 && !state.nonBoundCall,
    targets,
  };
}

/** Pushes underlying target expressions for bound functions produced by `call`. */
export function pushBoundTagPaths(
  call: CallExpression,
  expand: ExpandTagPath,
  pending: TagPath[],
  options?: {
    readonly boundArgs?: BoundArgCount | undefined;
    readonly env?: TagParameterEnv | undefined;
  },
): { readonly exhausted: boolean; readonly handled: boolean } {
  const resolved = boundCallTargets(call, expand, options?.env);
  for (const target of resolved.targets) {
    pending.push({
      boundArgs: combineBoundArgCounts(target.given, options?.boundArgs),
      env: target.env,
      node: target.node,
      suffix: [],
    });
  }
  return { exhausted: resolved.exhausted, handled: resolved.handled };
}

function combineBoundArgCounts(
  given: readonly TagBoundValue[] | null,
  outer: BoundArgCount | undefined,
): BoundArgCount | undefined {
  let combined: BoundArgCount | undefined = 'unknown';
  if (outer !== 'unknown' && given?.every((arg) => !isSpreadElement(arg.node)) === true) {
    const total = given.length + (outer ?? 0);
    combined = total === 0 ? undefined : total;
  }
  return combined;
}

export function tagPathKey(
  value: Expression,
  suffix: readonly (string | undefined)[],
  env?: TagParameterEnv,
  boundArgs?: BoundArgCount,
): string {
  const scope = env === undefined ? '' : `@${String(env.id)}`;
  const bound = boundArgs === undefined ? '' : `#${String(boundArgs)}`;
  return `${String(value.pos)}:${String(value.end)}:${suffix.map((part = '*') => part).join('.')}${scope}${bound}`;
}

function boundLeafTarget(item: TagCallable): BoundCallTarget | undefined {
  if (item.kind !== 'bound') return undefined;
  let current: TagCallable = item;
  let given: readonly TagBoundValue[] | null = [];
  while (current.kind === 'bound') {
    given = given === null || current.given === null ? null : [...current.given, ...given];
    current = current.target;
  }
  return current.kind === 'target' ? { env: current.env, given, node: current.node } : undefined;
}

function takeCallStep(state: CallState): boolean {
  state.steps += 1;
  if (state.steps <= CALL_SEARCH.limit) return true;
  state.exhausted = true;
  return false;
}

function evaluateTagCall(call: CallExpression, context: CallContext): readonly TagCallable[] {
  if (!takeCallStep(context.state)) return [];
  const args = writtenArguments(call).map((node) => ({ env: context.env, node }));
  const callee = unwrapped(call.expression);
  if (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) {
    return evaluateMemberTagCall(callee, args, context);
  }
  return wrapperCallablesOf(callee, context, true).flatMap((fn) =>
    invokeCallable(fn, undefined, args, context),
  );
}

function evaluateMemberTagCall(
  callee: Expression & { readonly expression: Expression },
  args: readonly TagBoundValue[],
  context: CallContext,
): readonly TagCallable[] {
  const results: TagCallable[] = [];
  let receivers: readonly TagCallable[] | undefined;
  const callables = wrapperCallablesOf(callee, context, true);
  for (const fn of callables) {
    if (fn.kind === 'method') {
      receivers ??= wrapperCallablesOf(callee.expression, context, fn.method !== 'bind');
      for (const self of receivers) results.push(...invokeCallable(fn, self, args, context));
      continue;
    }
    results.push(...invokeCallable(fn, undefined, args, context));
  }
  return results;
}

function invokeCallable(
  fn: TagCallable,
  self: TagCallable | undefined,
  args: readonly TagBoundValue[] | null,
  context: CallContext,
): readonly TagCallable[] {
  let currentFn = fn;
  let currentSelf = self;
  let currentArgs = args;
  while (currentFn.kind === 'bound') {
    if (!takeCallStep(context.state)) return [];
    currentArgs =
      currentArgs === null || currentFn.given === null
        ? null
        : [...currentFn.given, ...currentArgs];
    currentSelf = currentFn.self;
    currentFn = currentFn.target;
  }
  if (!takeCallStep(context.state) || currentFn.kind === 'target') return [];
  if (currentFn.kind === 'reflect-apply') return invokeReflectApply(currentArgs, context);
  return currentSelf === undefined
    ? []
    : invokeMethodCallable(currentFn.method, currentSelf, currentArgs, context);
}

function invokeMethodCallable(
  method: WrapperMethod,
  self: TagCallable,
  args: readonly TagBoundValue[] | null,
  context: CallContext,
): readonly TagCallable[] {
  if (args === null) {
    return method === 'bind' ? [{ given: null, kind: 'bound', self: undefined, target: self }] : [];
  }
  const [first, ...rest] = args;
  if (method === 'bind') return bindCallable(self, first, rest, context);
  if (first !== undefined && isSpreadElement(first.node)) return [];
  const receivers =
    first === undefined
      ? [undefined]
      : wrapperCallablesOf(first.node, contextWithEnv(context, first.env), false);
  if (method === 'call') {
    return receivers.flatMap((each) => invokeCallable(self, each, rest, context));
  }
  return invokeAppliedTargets([self], receivers, args[1], context);
}

function bindCallable(
  self: TagCallable,
  first: TagBoundValue | undefined,
  rest: readonly TagBoundValue[],
  context: CallContext,
): readonly TagCallable[] {
  if (first === undefined || isSpreadElement(first.node)) {
    const given = first === undefined ? [] : null;
    return [{ given, kind: 'bound', self: undefined, target: self }];
  }
  const given = rest.some((arg) => isSpreadElement(arg.node)) ? null : rest;
  return wrapperCallablesOf(first.node, contextWithEnv(context, first.env), false).map(
    (boundSelf) => {
      return {
        given,
        kind: 'bound',
        self: boundSelf,
        target: self,
      };
    },
  );
}

function invokeReflectApply(
  args: readonly TagBoundValue[] | null,
  context: CallContext,
): readonly TagCallable[] {
  if (args === null) return [];
  const [target, thisArg, list] = args;
  if (target === undefined || isSpreadElement(target.node)) return [];
  if (thisArg !== undefined && isSpreadElement(thisArg.node)) return [];
  const targets = wrapperCallablesOf(target.node, contextWithEnv(context, target.env), true);
  const receivers =
    thisArg === undefined
      ? [undefined]
      : wrapperCallablesOf(thisArg.node, contextWithEnv(context, thisArg.env), false);
  return invokeAppliedTargets(targets, receivers, list, context);
}

function invokeAppliedTargets(
  targets: readonly TagCallable[],
  receivers: readonly (TagCallable | undefined)[],
  list: TagBoundValue | undefined,
  context: CallContext,
): readonly TagCallable[] {
  const elements = appliedElements(context.state.call, list);
  if (elements === undefined) return bindOpaqueApplied(targets, receivers);
  const results: TagCallable[] = [];
  for (const target of targets) {
    for (const self of receivers) {
      results.push(...invokeCallable(target, self, elements, context));
    }
  }
  return results;
}

function bindOpaqueApplied(
  targets: readonly TagCallable[],
  receivers: readonly (TagCallable | undefined)[],
): readonly TagCallable[] {
  const hasBind = targets.some((target) => target.kind === 'method' && target.method === 'bind');
  if (!hasBind) return [];
  return receivers
    .filter((self): self is TagCallable => self !== undefined)
    .map((self) => ({ given: null, kind: 'bound', self: undefined, target: self }));
}

function appliedElements(
  call: CallExpression,
  list: TagBoundValue | undefined,
): readonly TagBoundValue[] | undefined {
  if (list === undefined) return [];
  if (isSpreadElement(list.node)) return undefined;
  const listed = framedAppliedArguments(call, list.node);
  if (listed === undefined) return undefined;
  return writtenArguments(call, listed).map((node) => ({ env: list.env, node }));
}

function contextWithEnv(context: CallContext, env: TagParameterEnv | undefined): CallContext {
  return env === context.env ? context : { env, state: context.state };
}

function wrapperCallablesOf(
  expression: Expression,
  context: CallContext,
  trackNonBound: boolean,
): readonly TagCallable[] {
  const results: TagCallable[] = [
    { env: context.env, kind: 'target', node: unwrapped(expression) },
  ];
  const pending: TagPath[] = [{ env: context.env, node: expression, suffix: [] }];
  const seen = new Set<string>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (!takeCallStep(context.state)) break;
    const value = unwrapped(current.node);
    const key = tagPathKey(value, current.suffix, current.env, current.boundArgs);
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      stepWrapperCallablePath(value, current.suffix, contextWithEnv(context, current.env), {
        pending,
        results,
        trackNonBound,
      })
    ) {
      break;
    }
  }
  return results;
}

function stepWrapperCallablePath(
  value: Expression,
  suffix: readonly (string | undefined)[],
  context: CallContext,
  state: {
    readonly pending: TagPath[];
    readonly results: TagCallable[];
    readonly trackNonBound: boolean;
  },
): boolean {
  const direct = globalPathOf(value);
  if (direct !== undefined) {
    const globals = globalWrapperCallables([...direct, ...suffix]);
    if (state.trackNonBound && globals.length === 0) context.state.nonBoundCall = true;
    state.results.push(...globals);
    return false;
  }
  const local = localWrapperCallables(value, suffix, context);
  state.results.push(...local.callables);
  if (context.state.exhausted) return true;
  if (local.handled) return false;
  const before = state.pending.length;
  if (context.state.expand(value, suffix, state.pending, context.env)) {
    context.state.exhausted = true;
    return true;
  }
  if (state.trackNonBound && local.callables.length === 0 && state.pending.length === before) {
    context.state.nonBoundCall = true;
  }
  return false;
}

function globalWrapperCallables(parts: readonly (string | undefined)[]): readonly TagCallable[] {
  let index = 0;
  while (parts.length - index > 1 && isKnownGlobalHolder(parts[index])) index += 1;
  const trimmed = parts.slice(index);
  if (trimmed.length < 2) return [];
  const root = trimmed[0];
  const last = trimmed.at(-1);
  const results: TagCallable[] = [];
  if (
    trimmed.length === 2 &&
    (root === undefined || root === 'Reflect') &&
    (last === undefined || last === 'apply')
  ) {
    results.push({ kind: 'reflect-apply' });
  }
  if (root !== undefined && trimmed.length === 2 && PLAIN_GLOBAL_NAMESPACES.has(root)) {
    return results;
  }
  for (const method of matchingWrapperMethods(last)) {
    results.push({ kind: 'method', method });
  }
  return results;
}

function isKnownGlobalHolder(name: string | undefined): boolean {
  return name !== undefined && GLOBAL_OBJECTS.has(name);
}

function localWrapperCallables(
  value: Expression,
  suffix: readonly (string | undefined)[],
  context: CallContext,
): { readonly callables: readonly TagCallable[]; readonly handled: boolean } {
  if (suffix.length === 0) {
    return isCallExpression(value)
      ? evaluateNestedBoundCall(value, context)
      : { callables: [], handled: false };
  }
  const method = exactWrapperMethod(suffix.at(-1));
  if (method === undefined) return { callables: [], handled: false };
  if (
    (suffix.length === 1 && (isArrowFunction(value) || isFunctionExpression(value))) ||
    callableCallLeaf(value) ||
    callableIdentifierLeaf(value, suffix.length, context.env)
  ) {
    return { callables: [{ kind: 'method', method }], handled: false };
  }
  return { callables: [], handled: false };
}

function evaluateNestedBoundCall(
  call: CallExpression,
  context: CallContext,
): { readonly callables: readonly TagCallable[]; readonly handled: boolean } {
  const innerState: CallState = {
    call,
    exhausted: false,
    expand: context.state.expand,
    nonBoundCall: false,
    steps: context.state.steps,
  };
  const evaluated = evaluateTagCall(call, { env: context.env, state: innerState });
  context.state.steps = innerState.steps;
  if (innerState.exhausted) context.state.exhausted = true;
  const callables = evaluated.filter((item) => item.kind === 'bound');
  const handled =
    callables.length > 0 && !innerState.nonBoundCall && evaluated.length === callables.length;
  return { callables, handled };
}

function callableCallLeaf(value: Expression): boolean {
  return (
    isCallExpression(value) &&
    reflectedRead(value) === undefined &&
    framedSourceValues(value) === undefined
  );
}

function matchingWrapperMethods(last: string | undefined): readonly WrapperMethod[] {
  if (last === undefined) return WRAPPER_METHODS;
  const exact = exactWrapperMethod(last);
  return exact === undefined ? [] : [exact];
}

function exactWrapperMethod(name: string | undefined): WrapperMethod | undefined {
  return WRAPPER_METHODS.find((candidate) => candidate === name);
}

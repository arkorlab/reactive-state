import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrowFunction,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  type ParameterDeclaration,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { GLOBAL_OBJECTS, globalPathOf } from './code-globals.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { computedBindingContainer, framedAppliedArguments } from './framed-keys.ts';
import { writtenArguments } from './framed-native-calls.ts';
import { framedSourceValues } from './framed-sources.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { reflectedRead } from './render-intl-reflections.ts';
import { bindingIdentifiers } from './scope.ts';

/** Bounded unwrapping of `.bind`, `.call`, `.apply` and `Reflect.apply` tag expressions. */

export type BoundArgCount = number | 'unknown';

export interface TagBoundValue {
  readonly node: Expression;
  readonly env: TagParameterEnv | undefined;
}

export interface TagParameterValue {
  readonly kind: 'values';
  readonly values: readonly TagBoundValue[];
  readonly rest?: boolean | undefined;
}

export type TagParameterEntry = TagParameterValue | { readonly kind: 'opaque' };

export interface TagParameterEnv {
  readonly id: number;
  readonly entries: ReadonlyMap<ParameterDeclaration, TagParameterEntry>;
}

export interface TagPath {
  readonly node: Expression;
  readonly suffix: readonly (string | undefined)[];
  readonly env?: TagParameterEnv | undefined;
  readonly boundArgs?: BoundArgCount | undefined;
}

export interface BoundCallTarget {
  readonly node: Expression;
  readonly given: readonly Expression[] | null;
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
) => boolean;

type WrapperMethod = 'apply' | 'bind' | 'call';

interface CallContext {
  readonly call: CallExpression;
  readonly expand: ExpandTagPath;
  steps: number;
  exhausted: boolean;
  nonBoundCall: boolean;
}

type TagCallable =
  | { readonly kind: 'target'; readonly node: Expression }
  | { readonly kind: 'method'; readonly method: WrapperMethod }
  | { readonly kind: 'reflect-apply' }
  | {
      readonly kind: 'bound';
      readonly target: TagCallable;
      readonly self: TagCallable | undefined;
      readonly given: readonly Expression[] | null;
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
export function boundCallTargets(call: CallExpression, expand: ExpandTagPath): BoundCallResolution {
  const context: CallContext = {
    call,
    exhausted: false,
    expand,
    nonBoundCall: false,
    steps: 0,
  };
  const targets: BoundCallTarget[] = [];
  for (const item of evaluateTagCall(call, context)) {
    const target = boundLeafTarget(item);
    if (target !== undefined) targets.push(target);
  }
  return {
    exhausted: context.exhausted,
    handled: targets.length > 0 && !context.nonBoundCall,
    targets,
  };
}

/** Pushes underlying target expressions for bound functions produced by `call`. */
export function pushBoundTagPaths(
  call: CallExpression,
  expand: ExpandTagPath,
  pending: TagPath[],
  options?: {
    readonly env?: TagParameterEnv | undefined;
    readonly boundArgs?: BoundArgCount | undefined;
  },
): { readonly exhausted: boolean; readonly handled: boolean } {
  const resolved = boundCallTargets(call, expand);
  for (const target of resolved.targets) {
    pending.push({
      boundArgs: combineBoundArgCounts(target.given, options?.boundArgs),
      env: options?.env,
      node: target.node,
      suffix: [],
    });
  }
  return { exhausted: resolved.exhausted, handled: resolved.handled };
}

function combineBoundArgCounts(
  given: readonly Expression[] | null,
  outer: BoundArgCount | undefined,
): BoundArgCount | undefined {
  let combined: BoundArgCount | undefined = 'unknown';
  if (outer !== 'unknown' && given?.every((arg) => !isSpreadElement(arg)) === true) {
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
  let given: readonly Expression[] | null = [];
  while (current.kind === 'bound') {
    given = given === null || current.given === null ? null : [...current.given, ...given];
    current = current.target;
  }
  return current.kind === 'target' ? { given, node: current.node } : undefined;
}

function takeCallStep(context: CallContext): boolean {
  context.steps += 1;
  if (context.steps <= CALL_SEARCH.limit) return true;
  context.exhausted = true;
  return false;
}

function evaluateTagCall(call: CallExpression, context: CallContext): readonly TagCallable[] {
  if (!takeCallStep(context)) return [];
  const args = writtenArguments(call);
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
  args: readonly Expression[],
  context: CallContext,
): readonly TagCallable[] {
  const results: TagCallable[] = [];
  let receivers: readonly TagCallable[] | undefined;
  for (const fn of wrapperCallablesOf(callee, context, true)) {
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
  args: readonly Expression[] | null,
  context: CallContext,
): readonly TagCallable[] {
  let currentFn = fn;
  let currentSelf = self;
  let currentArgs = args;
  while (currentFn.kind === 'bound') {
    if (!takeCallStep(context)) return [];
    currentArgs =
      currentArgs === null || currentFn.given === null
        ? null
        : [...currentFn.given, ...currentArgs];
    currentSelf = currentFn.self;
    currentFn = currentFn.target;
  }
  if (!takeCallStep(context) || currentFn.kind === 'target') return [];
  if (currentFn.kind === 'reflect-apply') return invokeReflectApply(currentArgs, context);
  return currentSelf === undefined
    ? []
    : invokeMethodCallable(currentFn.method, currentSelf, currentArgs, context);
}

function invokeMethodCallable(
  method: WrapperMethod,
  self: TagCallable,
  args: readonly Expression[] | null,
  context: CallContext,
): readonly TagCallable[] {
  if (args === null) {
    return method === 'bind' ? [{ given: null, kind: 'bound', self: undefined, target: self }] : [];
  }
  const [first, ...rest] = args;
  if (method === 'bind') return bindCallable(self, first, rest, context);
  if (first !== undefined && isSpreadElement(first)) return [];
  const receivers = first === undefined ? [undefined] : wrapperCallablesOf(first, context, false);
  if (method === 'call') {
    return receivers.flatMap((each) => invokeCallable(self, each, rest, context));
  }
  return invokeAppliedTargets([self], receivers, args[1], context);
}

function bindCallable(
  self: TagCallable,
  first: Expression | undefined,
  rest: readonly Expression[],
  context: CallContext,
): readonly TagCallable[] {
  if (first === undefined || isSpreadElement(first)) {
    const given = first === undefined ? [] : null;
    return [{ given, kind: 'bound', self: undefined, target: self }];
  }
  const given = rest.some((arg) => isSpreadElement(arg)) ? null : rest;
  return wrapperCallablesOf(first, context, false).map((boundSelf) => {
    return {
      given,
      kind: 'bound',
      self: boundSelf,
      target: self,
    };
  });
}

function invokeReflectApply(
  args: readonly Expression[] | null,
  context: CallContext,
): readonly TagCallable[] {
  if (args === null) return [];
  const [target, thisArg, list] = args;
  if (target === undefined || isSpreadElement(target)) return [];
  if (thisArg !== undefined && isSpreadElement(thisArg)) return [];
  const targets = wrapperCallablesOf(target, context, true);
  const receivers =
    thisArg === undefined ? [undefined] : wrapperCallablesOf(thisArg, context, false);
  return invokeAppliedTargets(targets, receivers, list, context);
}

function invokeAppliedTargets(
  targets: readonly TagCallable[],
  receivers: readonly (TagCallable | undefined)[],
  list: Expression | undefined,
  context: CallContext,
): readonly TagCallable[] {
  const elements = appliedElements(context.call, list);
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
  list: Expression | undefined,
): readonly Expression[] | undefined {
  if (list === undefined) return [];
  if (isSpreadElement(list)) return undefined;
  const listed = framedAppliedArguments(call, list);
  return listed === undefined ? undefined : writtenArguments(call, listed);
}

function wrapperCallablesOf(
  expression: Expression,
  context: CallContext,
  trackNonBound: boolean,
): readonly TagCallable[] {
  const results: TagCallable[] = [{ kind: 'target', node: unwrapped(expression) }];
  const pending: TagPath[] = [{ node: expression, suffix: [] }];
  const seen = new Set<string>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (!takeCallStep(context)) break;
    const value = unwrapped(current.node);
    const key = tagPathKey(value, current.suffix);
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      stepWrapperCallablePath(value, current.suffix, context, { pending, results, trackNonBound })
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
    if (state.trackNonBound && globals.length === 0) context.nonBoundCall = true;
    state.results.push(...globals);
    return false;
  }
  const locals = localWrapperCallables(value, suffix, context);
  state.results.push(...locals);
  const before = state.pending.length;
  if (context.expand(value, suffix, state.pending)) {
    context.exhausted = true;
    return true;
  }
  if (state.trackNonBound && locals.length === 0 && state.pending.length === before) {
    context.nonBoundCall = true;
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
): readonly TagCallable[] {
  if (suffix.length === 0) {
    return isCallExpression(value)
      ? evaluateTagCall(value, context).filter((item) => item.kind === 'bound')
      : [];
  }
  const method = exactWrapperMethod(suffix.at(-1));
  if (method === undefined) return [];
  if (
    (suffix.length === 1 && (isArrowFunction(value) || isFunctionExpression(value))) ||
    callableCallLeaf(value) ||
    callableIdentifierLeaf(value, suffix.length)
  ) {
    return [{ kind: 'method', method }];
  }
  return [];
}

function callableCallLeaf(value: Expression): boolean {
  return (
    isCallExpression(value) &&
    reflectedRead(value) === undefined &&
    framedSourceValues(value) === undefined
  );
}

function callableIdentifierLeaf(value: Expression, suffixLength: number): boolean {
  if (!isIdentifier(value)) return false;
  const declared = frameDeclarationOf(value);
  if (declared === undefined) return false;
  if (isFunctionDeclaration(declared)) return suffixLength === 1;
  if (!isParameterDeclaration(declared) && !isVariableDeclaration(declared)) return false;
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

function matchingWrapperMethods(last: string | undefined): readonly WrapperMethod[] {
  if (last === undefined) return WRAPPER_METHODS;
  const exact = exactWrapperMethod(last);
  return exact === undefined ? [] : [exact];
}

function exactWrapperMethod(name: string | undefined): WrapperMethod | undefined {
  return WRAPPER_METHODS.find((candidate) => candidate === name);
}

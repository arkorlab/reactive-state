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

export interface TagPath {
  readonly node: Expression;
  readonly suffix: readonly (string | undefined)[];
}

export type ExpandTagPath = (
  value: Expression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
) => void;

type WrapperMethod = 'apply' | 'bind' | 'call';

interface CallContext {
  readonly call: CallExpression;
  readonly expand: ExpandTagPath;
  steps: number;
  exhausted: boolean;
}

type TagCallable =
  | { readonly kind: 'target'; readonly node: Expression }
  | { readonly kind: 'method'; readonly method: WrapperMethod }
  | { readonly kind: 'reflect-apply' }
  | {
      readonly kind: 'bound';
      readonly target: TagCallable;
      readonly self: TagCallable | undefined;
      readonly given: readonly Expression[];
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

/** Pushes underlying target expressions for bound functions produced by `call`. */
export function pushBoundTagPaths(
  call: CallExpression,
  expand: ExpandTagPath,
  pending: TagPath[],
): boolean {
  const context: CallContext = { call, exhausted: false, expand, steps: 0 };
  for (const item of evaluateTagCall(call, context)) {
    const target = boundLeafTarget(item);
    if (target !== undefined) pending.push({ node: target, suffix: [] });
  }
  return context.exhausted;
}

export function tagPathKey(value: Expression, suffix: readonly (string | undefined)[]): string {
  return `${value.pos}:${value.end}:${suffix.map((part) => part ?? '*').join('.')}`;
}

function boundLeafTarget(item: TagCallable): Expression | undefined {
  if (item.kind !== 'bound') return undefined;
  let current: TagCallable = item.target;
  while (current.kind === 'bound') current = current.target;
  return current.kind === 'target' ? current.node : undefined;
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
  return wrapperCallablesOf(callee, context).flatMap((fn) =>
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
  for (const fn of wrapperCallablesOf(callee, context)) {
    if (fn.kind === 'method') {
      receivers ??= wrapperCallablesOf(callee.expression, context);
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
  args: readonly Expression[],
  context: CallContext,
): readonly TagCallable[] {
  if (!takeCallStep(context) || fn.kind === 'target') return [];
  if (fn.kind === 'bound')
    return invokeCallable(fn.target, fn.self, [...fn.given, ...args], context);
  if (fn.kind === 'reflect-apply') return invokeReflectApply(args, context);
  return self === undefined ? [] : invokeMethodCallable(fn.method, self, args, context);
}

function invokeMethodCallable(
  method: WrapperMethod,
  self: TagCallable,
  args: readonly Expression[],
  context: CallContext,
): readonly TagCallable[] {
  const [first, ...rest] = args;
  if (method === 'bind') return bindCallable(self, first, rest, context);
  if (first !== undefined && isSpreadElement(first)) return [];
  const receivers = first === undefined ? [undefined] : wrapperCallablesOf(first, context);
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
    return [{ given: [], kind: 'bound', self: undefined, target: self }];
  }
  return wrapperCallablesOf(first, context).map((boundSelf) => ({
    given: rest,
    kind: 'bound',
    self: boundSelf,
    target: self,
  }));
}

function invokeReflectApply(
  args: readonly Expression[],
  context: CallContext,
): readonly TagCallable[] {
  const [target, thisArg, list] = args;
  if (target === undefined || isSpreadElement(target)) return [];
  if (thisArg !== undefined && isSpreadElement(thisArg)) return [];
  const targets = wrapperCallablesOf(target, context);
  const receivers = thisArg === undefined ? [undefined] : wrapperCallablesOf(thisArg, context);
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
    .map((self) => ({ given: [], kind: 'bound', self: undefined, target: self }));
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

function wrapperCallablesOf(expression: Expression, context: CallContext): readonly TagCallable[] {
  const results: TagCallable[] = [{ kind: 'target', node: unwrapped(expression) }];
  const pending: TagPath[] = [{ node: expression, suffix: [] }];
  const seen = new Set<string>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (!takeCallStep(context)) return results;
    const value = unwrapped(current.node);
    const key = tagPathKey(value, current.suffix);
    if (seen.has(key)) continue;
    seen.add(key);
    const direct = globalPathOf(value);
    if (direct !== undefined) {
      results.push(...globalWrapperCallables([...direct, ...current.suffix]));
      continue;
    }
    results.push(...localWrapperCallables(value, current.suffix, context));
    context.expand(value, current.suffix, pending);
  }
  return results;
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
  if (trimmed.length === 2 && root !== undefined && PLAIN_GLOBAL_NAMESPACES.has(root)) {
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

function matchingWrapperMethods(name: string | undefined): readonly WrapperMethod[] {
  if (name === undefined) return WRAPPER_METHODS;
  const exact = exactWrapperMethod(name);
  return exact === undefined ? [] : [exact];
}

function exactWrapperMethod(name: string | undefined): WrapperMethod | undefined {
  return WRAPPER_METHODS.find((method) => method === name);
}

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
  isObjectLiteralExpression,
  isSpreadElement,
  type MethodDeclaration,
} from 'typescript/ast';

import { type Answering, overloadsOf, returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedAppliedArguments } from './framed-keys.ts';
import { framedAssignedSources } from './framed-writes.ts';
import {
  boundCallTargets,
  type TagBoundValue,
  type TagParameterEnv,
  type TagPath,
  tagPathKey,
} from './render-raw-tag-calls.ts';
import { buildFactoryParameterEnv } from './render-raw-tag-envs.ts';
import type { ObjectTagSink } from './render-raw-tag-paths.ts';

/** Factory-call return-path expansions for template tag candidates. */

type CalleeStepOutcome = 'done' | 'expand' | 'unresolved';

export type FactoryStepExpander = (
  value: Expression,
  suffix: readonly (string | undefined)[],
  sink: ObjectTagSink,
) => boolean;

interface FactoryCalleeItem {
  readonly env: TagParameterEnv | undefined;
  readonly given: readonly TagBoundValue[] | null;
  readonly node: Expression;
  readonly suffix: readonly (string | undefined)[];
}

interface FactoryResolveContext {
  readonly call?: CallExpression | undefined;
  readonly callees: FactoryCalleeItem[];
  readonly outerSuffix: readonly (string | undefined)[];
  readonly pending: TagPath[];
  readonly step: FactoryStepExpander;
}

const FACTORY_SEARCH = { depth: 8, limit: 64 } as const;

/** Resolves factory call return paths, returning `true` when any candidate callee remains opaque. */
export function expandFactoryCallTagPaths(
  call: CallExpression,
  outerSuffix: readonly (string | undefined)[],
  env: TagParameterEnv | undefined,
  options: {
    readonly depth: number;
    readonly pending: TagPath[];
    readonly step: FactoryStepExpander;
  },
): boolean {
  if (options.depth >= FACTORY_SEARCH.depth) return true;
  const initial = seedFactoryCallees(call, env);
  if (initial === undefined) return true;
  const callees = [...initial];
  return drainFactoryCallees(callees, {
    call,
    callees,
    outerSuffix,
    pending: options.pending,
    step: options.step,
  });
}

/** Resolves a factory expression invoked as a template tag (`makeRaw\`...\`\`${date}\``). */
export function expandTaggedFactoryPaths(
  calleeTag: Expression,
  outerSuffix: readonly (string | undefined)[],
  options: {
    readonly depth: number;
    readonly env: TagParameterEnv | undefined;
    readonly pending: TagPath[];
    readonly step: FactoryStepExpander;
  },
): boolean {
  if (options.depth >= FACTORY_SEARCH.depth) return true;
  const callees: FactoryCalleeItem[] = [
    { env: options.env, given: null, node: calleeTag, suffix: [] },
  ];
  return drainFactoryCallees(callees, {
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
    const key = `${tagPathKey(value, current.suffix, current.env)}:(${givenArgsKey(current.given)})`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (stepFactoryCallee(value, current, context) === 'unresolved') return true;
  }
  return false;
}

function givenArgsKey(given: readonly TagBoundValue[] | null): string {
  if (given === null) return '?';
  return given
    .map((arg) => {
      const scope = arg.env === undefined ? '' : `@${String(arg.env.id)}`;
      return `${String(arg.node.pos)}:${String(arg.node.end)}${scope}`;
    })
    .join(',');
}

function seedFactoryCallees(
  call: CallExpression,
  env: TagParameterEnv | undefined,
): readonly FactoryCalleeItem[] | undefined {
  const callee = unwrapped(call.expression);
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    const [target, , argList] = call.arguments;
    if (target === undefined || isSpreadElement(target)) return undefined;
    const listArg = argList === undefined ? undefined : { env, node: argList };
    return [{ env, given: extractAppliedList(call, listArg), node: target, suffix: [] }];
  }
  return [
    {
      env,
      given: call.arguments.map((node) => ({ env, node })),
      node: call.expression,
      suffix: [],
    },
  ];
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
  const bound = boundCallTargets(
    value,
    (inner, innerSuffix, nextPending, innerEnv) => {
      return context.step(inner, innerSuffix, {
        env: innerEnv,
        methods: [],
        pending: nextPending,
      });
    },
    current.env,
  );
  if (bound.exhausted) return 'unresolved';
  if (!bound.handled) return 'expand';
  for (const target of bound.targets) {
    context.callees.push({
      env: target.env,
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
  const calleeEnv = buildFactoryParameterEnv(fn, current.given, current.env);
  for (const returned of returnedBy(fn)) {
    context.pending.push({ env: calleeEnv, node: returned, suffix: context.outerSuffix });
  }
}

function mergeCallArguments(
  prefix: readonly TagBoundValue[] | null,
  rest: readonly TagBoundValue[] | null,
): readonly TagBoundValue[] | null {
  return prefix === null || rest === null ? null : [...prefix, ...rest];
}

function sliceCallReceiverArg(
  given: readonly TagBoundValue[] | null,
): readonly TagBoundValue[] | null {
  if (given === null) return null;
  const [first, ...rest] = given;
  return first !== undefined && isSpreadElement(first.node) ? null : rest;
}

function extractMethodApplyArgs(
  call: CallExpression | undefined,
  given: readonly TagBoundValue[] | null,
): readonly TagBoundValue[] | null {
  if (call === undefined || given === null) return null;
  const [first, list] = given;
  if (first !== undefined && isSpreadElement(first.node)) return null;
  return extractAppliedList(call, list);
}

function extractAppliedList(
  call: CallExpression,
  list: TagBoundValue | undefined,
): readonly TagBoundValue[] | null {
  if (list === undefined) return [];
  if (isSpreadElement(list.node)) return null;
  const listed = framedAppliedArguments(call, list.node);
  return listed === undefined ? null : listed.map((node) => ({ env: list.env, node }));
}

import {
  type ArrayBindingElement,
  type BindingElement,
  type BindingName,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBindingElement,
  isIdentifier,
  isOmittedExpression,
  isSpreadElement,
  type ParameterDeclaration,
} from 'typescript/ast';

import { type Answering, isAnswering, parametersOf } from './answers.ts';
import { metadataCallee } from './input-callees.ts';
import {
  arrayChangedBefore,
  arrayIndex,
  type ArrayScope,
  collectAliasIdentifiers,
  restArrayChangedBefore,
} from './proxy-arrays.ts';
import { expressionReachesScope, inlineUnmutatedSpreadArray } from './proxy-containers.ts';
import { parameterFrame } from './proxy-presence.ts';
import {
  type Context,
  type Origin,
  type OriginKey,
  peeled,
  propertyKey,
  sourceValue,
  writtenBefore,
} from './proxy-values.ts';
import { bindingIdentifiers } from './scope.ts';
import { interveningEvaluation } from './written-evaluation.ts';

/** Bound helper-call scope for propagating parameter mutations back to a caller container. */
export interface HelperMutationScope {
  readonly childContext: Context;
  readonly restContainers: ReadonlySet<Identifier>;
  readonly scope: ArrayScope;
}

interface ExpandedHelperArgs {
  readonly given: readonly Origin[];
  readonly openTail: boolean;
  readonly tailArgs: readonly Expression[];
}

/** Builds bound parameter mutation scopes when `call` invokes a source helper with `matchesTarget`. */
export function helperCallScopes(
  call: CallExpression,
  matchesTarget: (candidate: Expression) => boolean,
  baseOrigin: Origin,
  seenCalls: ReadonlySet<CallExpression>,
): readonly HelperMutationScope[] {
  if (seenCalls.has(call)) {
    return [];
  }
  const callee =
    baseOrigin.context.functionOf?.(call.expression) ?? metadataCallee(call.expression);
  if (callee === undefined || !isAnswering(callee)) {
    return [];
  }
  const expanded = expandHelperArguments(call, baseOrigin);
  const { aliasSeeds, restSeeds } = matchCalleeParameters(
    callee,
    expanded,
    matchesTarget,
    baseOrigin.context,
  );
  if (aliasSeeds.length === 0 && restSeeds.length === 0) {
    return [];
  }
  const aliases = new Set(
    aliasSeeds.flatMap((seed) => collectAliasIdentifiers(seed, callee, callee)),
  );
  const restContainers = new Set(
    restSeeds.flatMap((seed) => collectAliasIdentifiers(seed, callee, callee)),
  );
  const childContext: Context = {
    ...baseOrigin.context,
    calls: new Set([...baseOrigin.context.calls, call]),
    frames: [
      ...baseOrigin.context.frames,
      { fn: callee, given: expanded.given, openTail: expanded.openTail },
    ],
  };
  return [
    {
      childContext,
      restContainers,
      scope: { afterEnd: 0, aliases, owner: callee, readSite: callee },
    },
  ];
}

/** Expands known prefix arguments of `call` while retaining raw arguments at/after unknown spreads. */
function expandHelperArguments(call: CallExpression, baseOrigin: Origin): ExpandedHelperArgs {
  const given: Origin[] = [];
  const tailArgs: Expression[] = [];
  let openTail = false;
  for (const arg of call.arguments) {
    if (openTail) {
      tailArgs.push(arg);
      continue;
    }
    if (!isSpreadElement(arg)) {
      given.push({
        ...baseOrigin,
        excluded: undefined,
        keys: [],
        spread: undefined,
        value: arg,
      });
      continue;
    }
    const tuple = resolveHelperSpread(arg.expression, baseOrigin);
    if (tuple === undefined) {
      openTail = true;
      tailArgs.push(arg);
      continue;
    }
    given.push(...tuple);
  }
  return { given, openTail, tailArgs };
}

/** Converts an unmutated `ArrayLiteralExpression` into flat helper argument `Origin`s. */
function tupleLiteralOrigins(
  literal: Expression,
  baseOrigin: Origin,
): readonly Origin[] | undefined {
  const inlined = inlineUnmutatedSpreadArray(literal, baseOrigin.context, new Set());
  return inlined?.map((each) => {
    return {
      ...baseOrigin,
      excluded: undefined,
      keys: [],
      spread: undefined,
      value: each,
    };
  });
}

/** Expands a literal tuple, unmutated `const` array, or intact rest parameter for helper calls. */
function resolveHelperSpread(expr: Expression, baseOrigin: Origin): readonly Origin[] | undefined {
  const value = peeled(expr);
  if (isArrayLiteralExpression(value)) {
    return tupleLiteralOrigins(value, baseOrigin);
  }
  if (!isIdentifier(value) || writtenBefore(value, baseOrigin.context)) {
    return undefined;
  }
  const binding = parameterFrame(value, baseOrigin.context.frames);
  const restName = binding?.parameter.name;
  if (
    restName !== undefined &&
    binding?.parameter.dotDotDotToken !== undefined &&
    isIdentifier(restName)
  ) {
    const { frame, index } = binding;
    const changed =
      frame.openTail === true ||
      restArrayChangedBefore(frame.fn, restName, value, baseOrigin.context);
    return changed ? undefined : frame.given?.slice(index);
  }
  const held = sourceValue(value, baseOrigin.context);
  if (
    !isArrayLiteralExpression(held) ||
    interveningEvaluation(held, value) ||
    arrayChangedBefore(value, baseOrigin.context)
  ) {
    return undefined;
  }
  return tupleLiteralOrigins(held, baseOrigin);
}

interface HelperParameterState {
  readonly aliasSeeds: Identifier[];
  readonly context: Context;
  readonly expanded: ExpandedHelperArgs;
  readonly matchesTarget: (candidate: Expression) => boolean;
  readonly restSeeds: Identifier[];
}

/** Identifies formal parameter identifiers of `callee` that can receive `matchesTarget`. */
function matchCalleeParameters(
  callee: Answering,
  expanded: ExpandedHelperArgs,
  matchesTarget: (candidate: Expression) => boolean,
  context: Context,
): { readonly aliasSeeds: readonly Identifier[]; readonly restSeeds: readonly Identifier[] } {
  const aliasSeeds: Identifier[] = [];
  const restSeeds: Identifier[] = [];
  const state: HelperParameterState = { aliasSeeds, context, expanded, matchesTarget, restSeeds };
  for (const [index, parameter] of parametersOf(callee).entries()) {
    if (parameter.dotDotDotToken !== undefined) {
      matchRestParameter(parameter, index, state);
      continue;
    }
    matchSingleParameter(parameter, index, state);
  }
  return { aliasSeeds, restSeeds };
}

/** Matches an identifier or destructured `...rest` parameter at `index` against `state.expanded`. */
function matchRestParameter(
  parameter: ParameterDeclaration,
  index: number,
  state: HelperParameterState,
): void {
  const { context, expanded, matchesTarget, restSeeds } = state;
  if (isIdentifier(parameter.name)) {
    const receivesTarget =
      expanded.given.slice(index).some((arg) => matchesTarget(arg.value)) ||
      expanded.tailArgs.some((arg) => argumentReachesTarget(arg, [], matchesTarget, context));
    if (receivesTarget) {
      restSeeds.push(parameter.name);
    }
    return;
  }
  for (const declared of bindingIdentifiers(parameter.name)) {
    const path = bindingPathToIdentifier(parameter.name, declared, context);
    if (path !== undefined) {
      recordRestBindingSeed(declared, index, path, state);
    }
  }
}

/** Classifies one destructured binding inside a rest parameter into `restSeeds` or `aliasSeeds`. */
function recordRestBindingSeed(
  declared: Identifier,
  restStart: number,
  path: readonly OriginKey[],
  state: HelperParameterState,
): void {
  const [firstKey, ...rest] = path;
  if (isLeafArrayRestIdentifier(declared)) {
    const anyReach = restCandidateExpressions(restStart, null, state.expanded).some((arg) =>
      argumentReachesTarget(arg, [], state.matchesTarget, state.context),
    );
    if (anyReach) {
      state.restSeeds.push(declared);
    }
    return;
  }
  const offset = firstKey === undefined || firstKey === null ? null : arrayIndex(firstKey);
  if (firstKey !== null && offset === undefined) {
    return;
  }
  const hits = restCandidateExpressions(restStart, offset ?? null, state.expanded).some((arg) =>
    argumentReachesTarget(arg, rest, state.matchesTarget, state.context),
  );
  if (hits) {
    state.aliasSeeds.push(declared);
  }
}

/** Candidate caller expressions supplying `offset` (`null` for any slot) of a rest parameter. */
function restCandidateExpressions(
  restStart: number,
  offset: number | null,
  expanded: ExpandedHelperArgs,
): readonly Expression[] {
  if (offset === null) {
    return [...expanded.given.slice(restStart).map((each) => each.value), ...expanded.tailArgs];
  }
  const slot = restStart + offset;
  const known = slot < expanded.given.length ? expanded.given[slot] : undefined;
  if (known !== undefined) {
    return [known.value];
  }
  return expanded.openTail ? expanded.tailArgs : [];
}

/** Whether `declared` is the direct identifier of an array rest element (`[...declared]`). */
function isLeafArrayRestIdentifier(declared: Identifier): boolean {
  const parent = declared.parent;
  return (
    isBindingElement(parent) &&
    parent.dotDotDotToken !== undefined &&
    parent.name === declared &&
    isArrayBindingPattern(parent.parent)
  );
}

/** Matches an ordinary or destructured parameter at `index` against `state.expanded` arguments. */
function matchSingleParameter(
  parameter: ParameterDeclaration,
  index: number,
  state: HelperParameterState,
): void {
  const args = candidateParameterExpressions(parameter, index, state.expanded);
  if (isIdentifier(parameter.name)) {
    if (args.some((arg) => argumentReachesTarget(arg, [], state.matchesTarget, state.context))) {
      state.aliasSeeds.push(parameter.name);
    }
    return;
  }
  for (const declared of bindingIdentifiers(parameter.name)) {
    const path = bindingPathToIdentifier(parameter.name, declared, state.context);
    if (
      path !== undefined &&
      args.some((arg) => argumentReachesTarget(arg, path, state.matchesTarget, state.context))
    ) {
      if (isLeafArrayRestIdentifier(declared)) {
        state.restSeeds.push(declared);
      } else {
        state.aliasSeeds.push(declared);
      }
    }
  }
}

/** Returns expressions that can supply `parameter` at `index` for `expanded`. */
function candidateParameterExpressions(
  parameter: ParameterDeclaration,
  index: number,
  expanded: ExpandedHelperArgs,
): readonly Expression[] {
  const known = index < expanded.given.length ? expanded.given[index] : undefined;
  if (known !== undefined) {
    return parameter.initializer === undefined
      ? [known.value]
      : [known.value, parameter.initializer];
  }
  const fallback = parameter.initializer === undefined ? [] : [parameter.initializer];
  return expanded.openTail ? [...expanded.tailArgs, ...fallback] : fallback;
}

/** Checks whether `arg` (or a spread element `...arr`) reaches `matchesTarget` along `path`. */
function argumentReachesTarget(
  arg: Expression,
  path: readonly OriginKey[],
  matchesTarget: (candidate: Expression) => boolean,
  context: Context,
): boolean {
  if (isSpreadElement(arg)) {
    return expressionReachesScope(
      { expr: arg.expression, remaining: [null, ...path] },
      matchesTarget,
      context,
    );
  }
  return path.length === 0
    ? matchesTarget(arg)
    : expressionReachesScope({ expr: arg, remaining: path }, matchesTarget, context);
}

/** Computes the member key path from a destructuring `pattern` down to `target`. */
function bindingPathToIdentifier(
  pattern: BindingName | undefined,
  target: Identifier,
  context: Context,
): readonly OriginKey[] | undefined {
  if (pattern === undefined) {
    return undefined;
  }
  if (isIdentifier(pattern)) {
    return pattern === target ? [] : undefined;
  }
  return isArrayBindingPattern(pattern)
    ? arrayBindingPath(pattern.elements, target, context)
    : objectBindingPath(pattern.elements, target, context);
}

/** Finds the element key path inside an `ArrayBindingPattern` leading to `target`. */
function arrayBindingPath(
  elements: readonly ArrayBindingElement[],
  target: Identifier,
  context: Context,
): readonly OriginKey[] | undefined {
  for (const [index, element] of elements.entries()) {
    if (isOmittedExpression(element)) {
      continue;
    }
    const sub = bindingPathToIdentifier(element.name, target, context);
    if (sub !== undefined) {
      return element.dotDotDotToken === undefined
        ? [String(index), ...sub]
        : sliceRestSubpath(index, sub);
    }
  }
  return undefined;
}

/** Shifts `sub` inside an array rest element `...subPattern` starting at `restStart`. */
function sliceRestSubpath(
  restStart: number,
  sub: readonly OriginKey[],
): readonly OriginKey[] | undefined {
  if (sub.length === 0) {
    return [null];
  }
  const [firstKey, ...rest] = sub;
  if (firstKey === undefined || firstKey === null) {
    return [null, ...rest];
  }
  const offset = arrayIndex(firstKey);
  return offset === undefined ? undefined : [String(restStart + offset), ...rest];
}

/** Finds the property key path inside an `ObjectBindingPattern` leading to `target`. */
function objectBindingPath(
  elements: readonly BindingElement[],
  target: Identifier,
  context: Context,
): readonly OriginKey[] | undefined {
  for (const element of elements) {
    const sub = bindingPathToIdentifier(element.name, target, context);
    if (sub !== undefined) {
      return element.dotDotDotToken === undefined
        ? [objectElementKey(element, context), ...sub]
        : sub;
    }
  }
  return undefined;
}

/** Extracts the static or dynamic key read by an object `BindingElement`. */
function objectElementKey(element: BindingElement, context: Context): OriginKey {
  if (element.propertyName === undefined) {
    return element.name !== undefined && isIdentifier(element.name) ? element.name.text : null;
  }
  return propertyKey(element.propertyName, context) ?? null;
}

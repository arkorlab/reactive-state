import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isElementAccessExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isIfStatement,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  type Node,
  type ObjectLiteralExpression,
  type TemplateExpression,
} from 'typescript/ast';

import { returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedCondition } from './framed-sources.ts';
import { assignedNames } from './local-date-inputs.ts';
import { isDateValue } from './local-reads.ts';
import {
  collectWrapperBindings,
  type ForwardedSlotsResult,
  isIdentifierForParam,
  isWholeArgumentsReference,
  type RawWrapperQuery,
  type RawWrapperSearch,
  type WrapperBindings,
  type WrapperFunction,
} from './render-raw-wrapper-bindings.ts';
import { carriesDatedSubstitution } from './render-tag-date-carriers.ts';
import { nodeCoercesDatedSubstitution } from './render-tag-date-coercions.ts';

/** Custom template tags and helpers that forward or coerce Date-bearing substitutions. */

interface CallForwardContext {
  readonly bindings: WrapperBindings;
  readonly query: RawWrapperQuery;
  readonly nextSeen: ReadonlySet<string>;
}

interface SpreadSlotContext {
  readonly bindings: WrapperBindings;
  readonly query: RawWrapperSearch;
  readonly forwardedSlots: Set<number>;
}

interface BodyWalkItem {
  readonly node: Node;
  readonly bindings: WrapperBindings;
}

/** Zero-based template substitution indices whose expressions carry direct or typed Date values. */
export function datedTemplateSpanIndices(template: TemplateExpression): ReadonlySet<number> {
  const indices = new Set<number>();
  for (const [index, span] of template.templateSpans.entries()) {
    if (isDateValue(span.expression)) indices.add(index);
  }
  return indices;
}

/** Checks whether `fn` forwards any Date-bearing substitution to String.raw or coerces it directly. */
export function wrapperForwardsRawDate(fn: WrapperFunction, query: RawWrapperQuery): boolean {
  if (query.datedIndices.size === 0 || fn.body === undefined) return false;
  const visitKey = wrapperVisitKey(fn, query);
  if (query.seenWrappers.has(visitKey)) return false;
  const bindings = collectWrapperBindings(fn, query.paramOffset ?? 1, query.boundArgs);
  const nextSeen = new Set([...query.seenWrappers, visitKey]);
  if (
    query.outerConsumedAsText === true &&
    returnedBy(fn).some((ret) =>
      carriesDatedSubstitution(ret, bindings, query.datedIndices, new Set()),
    )
  ) {
    return true;
  }
  return walkWrapperBody(fn.body, bindings, query, nextSeen);
}

function wrapperVisitKey(fn: WrapperFunction, query: RawWrapperSearch): string {
  const offset = query.paramOffset ?? 1;
  const bound = query.boundArgs ?? 0;
  const maxSubs = query.maxTemplateSubs ?? 'inf';
  const scope = query.env === undefined ? '' : `@${String(query.env.id)}`;
  const indices = [...query.datedIndices].toSorted((a, b) => a - b).join(',');
  return `${String(fn.pos)}:${String(offset)}:${String(bound)}:${String(maxSubs)}:${indices}${scope}`;
}

function walkWrapperBody(
  body: Node,
  rootBindings: WrapperBindings,
  query: RawWrapperQuery,
  nextSeen: ReadonlySet<string>,
): boolean {
  const pending: BodyWalkItem[] = [{ bindings: rootBindings, node: body }];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const { bindings, node: current } = item;
    if (isIfStatement(current) && framedCondition(current.expression) === false) {
      if (current.elseStatement !== undefined) {
        pending.push({ bindings, node: current.elseStatement });
      }
      continue;
    }
    const activeBindings =
      current.pos !== body.pos && isFunctionLikeDeclaration(current) && !isArrowFunction(current)
        ? { ...bindings, hasImplicitArguments: false }
        : bindings;
    if (nodeMatchesOrCoerces(current, activeBindings, query, nextSeen)) return true;
    current.forEachChild((child) => {
      pending.push({ bindings: activeBindings, node: child });
    });
  }
  return false;
}

function nodeMatchesOrCoerces(
  node: Node,
  bindings: WrapperBindings,
  query: RawWrapperQuery,
  nextSeen: ReadonlySet<string>,
): boolean {
  if (nodeForwardsRawDate(node, bindings, query, nextSeen)) return true;
  return nodeCoercesDatedSubstitution(node, {
    bindings,
    callSiteMaxSubs: (expr) => callSiteMaxSubstitutions(expr, bindings, query),
    nextSeen,
    query,
  });
}

function nodeForwardsRawDate(
  node: Node,
  bindings: WrapperBindings,
  query: RawWrapperQuery,
  nextSeen: ReadonlySet<string>,
): boolean {
  if (isTaggedTemplateExpression(node) && isTemplateExpression(node.template)) {
    const innerDated = forwardedTemplateIndices(node.template, bindings, query.datedIndices);
    return (
      innerDated.size > 0 &&
      query.maySelectTag(node.tag, {
        datedIndices: innerDated,
        env: query.env,
        paramOffset: 1,
        seenWrappers: nextSeen,
        spanCount: node.template.templateSpans.length,
      })
    );
  }
  return isCallExpression(node) && callForwardsRawDate(node, { bindings, nextSeen, query });
}

function callForwardsRawDate(call: CallExpression, context: CallForwardContext): boolean {
  const callee = unwrapped(call.expression);
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    const [target, , argList] = call.arguments;
    return (
      target !== undefined &&
      !isSpreadElement(target) &&
      appliedCallForwardsRawDate(target, argList, context)
    );
  }
  if (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) {
    const member = frameMemberName(callee);
    if (member === 'apply') {
      return appliedCallForwardsRawDate(callee.expression, call.arguments[1], context);
    }
    if (member === 'call') {
      return directCallForwardsRawDate(callee.expression, call.arguments.slice(1), context);
    }
  }
  return directCallForwardsRawDate(callee, call.arguments, context);
}

function appliedCallForwardsRawDate(
  target: Expression,
  argList: Expression | undefined,
  context: CallForwardContext,
): boolean {
  if (argList === undefined || isSpreadElement(argList)) return false;
  const list = unwrapped(argList);
  const { bindings, nextSeen, query } = context;
  if (isWholeArgumentsReference(list, bindings) && bindings.paramOffset === 1) {
    return query.maySelectTag(target, {
      datedIndices: query.datedIndices,
      env: query.env,
      maxTemplateSubs: query.maxTemplateSubs,
      paramOffset: 1,
      seenWrappers: nextSeen,
      spanCount: query.spanCount,
    });
  }
  return (
    isArrayLiteralExpression(list) &&
    directCallForwardsRawDate(
      target,
      list.elements.filter((element) => !isOmittedExpression(element)),
      context,
    )
  );
}

function directCallForwardsRawDate(
  target: Expression,
  args: readonly Expression[],
  context: CallForwardContext,
): boolean {
  const [first, ...rest] = args;
  if (first === undefined) return false;
  const { bindings, nextSeen, query } = context;
  if (isSpreadElement(first)) {
    return (
      bindings.paramOffset === 1 &&
      isIdentifierForParam(unwrapped(first.expression), bindings.wholeRestParam) &&
      query.maySelectTag(target, {
        datedIndices: query.datedIndices,
        env: query.env,
        maxTemplateSubs: query.maxTemplateSubs,
        paramOffset: 1,
        seenWrappers: nextSeen,
        spanCount: query.spanCount,
      })
    );
  }
  const maxSubs = callSiteMaxSubstitutions(first, bindings, query);
  if (maxSubs <= 0) return false;
  const forwarded = forwardedSubstitutionSlots(rest, maxSubs, bindings, query);
  return (
    forwarded.forwardedSlots.size > 0 &&
    query.maySelectTag(target, {
      datedIndices: forwarded.forwardedSlots,
      env: query.env,
      maxTemplateSubs: Number.isFinite(maxSubs) ? maxSubs : undefined,
      paramOffset: 1,
      seenWrappers: nextSeen,
      spanCount: forwarded.effectiveSpanCount,
    })
  );
}

function forwardedSubstitutionSlots(
  restArgs: readonly Expression[],
  maxSubs: number,
  bindings: WrapperBindings,
  query: RawWrapperSearch,
): ForwardedSlotsResult {
  const forwardedSlots = new Set<number>();
  let slot = 0;
  for (const arg of restArgs) {
    if (isSpreadElement(arg)) {
      slot = appendSpreadSubstitutionSlots(arg.expression, slot, maxSubs, {
        bindings,
        forwardedSlots,
        query,
      });
      continue;
    }
    if (slot < maxSubs && carriesDatedSubstitution(arg, bindings, query.datedIndices, new Set())) {
      forwardedSlots.add(slot);
    }
    slot += 1;
  }
  const highest = forwardedSlots.size === 0 ? 0 : Math.max(...forwardedSlots) + 1;
  const effectiveSpanCount = Number.isFinite(maxSubs) ? maxSubs : Math.max(slot, highest);
  return { effectiveSpanCount, forwardedSlots };
}

function appendSpreadSubstitutionSlots(
  spreadExpr: Expression,
  slot: number,
  maxSubs: number,
  context: SpreadSlotContext,
): number {
  const { bindings, forwardedSlots, query } = context;
  const target = unwrapped(spreadExpr);
  const { restSubs } = bindings;
  if (restSubs !== undefined && isIdentifierForParam(target, restSubs.param)) {
    for (const datedIndex of query.datedIndices) {
      if (datedIndex < restSubs.startIndex) continue;
      const mappedSlot = slot + (datedIndex - restSubs.startIndex);
      if (mappedSlot < maxSubs) forwardedSlots.add(mappedSlot);
    }
    return slot + Math.max(0, query.spanCount - restSubs.startIndex);
  }
  if (carriesDatedSubstitution(target, bindings, query.datedIndices, new Set())) {
    const limit = Number.isFinite(maxSubs) ? maxSubs : slot + query.spanCount;
    for (let index = slot; index < limit; index += 1) forwardedSlots.add(index);
  }
  return slot + 1;
}

function forwardedTemplateIndices(
  template: TemplateExpression,
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
): ReadonlySet<number> {
  const inner = new Set<number>();
  for (const [index, span] of template.templateSpans.entries()) {
    if (carriesDatedSubstitution(span.expression, bindings, datedIndices, new Set())) {
      inner.add(index);
    }
  }
  return inner;
}

function callSiteMaxSubstitutions(
  callSiteExpr: Expression,
  bindings: WrapperBindings,
  query: RawWrapperSearch,
): number {
  const effectiveMax = query.maxTemplateSubs ?? query.spanCount;
  const value = unwrapped(callSiteExpr);
  if (isIdentifierForParam(value, bindings.templateParam)) return effectiveMax;
  if (query.maxTemplateSubs !== undefined && isFirstParameterReference(value, bindings)) {
    return query.maxTemplateSubs;
  }
  if (!isObjectLiteralExpression(value)) return Infinity;
  const rawValue = ownRawPropertyInitializer(value);
  if (rawValue === undefined) return Infinity;
  if (forwardsCallSiteRaw(rawValue, bindings)) return effectiveMax;
  if (query.maxTemplateSubs !== undefined && forwardsFirstParameterRaw(rawValue, bindings)) {
    return query.maxTemplateSubs;
  }
  if (
    isArrayLiteralExpression(rawValue) &&
    !rawValue.elements.some((element) => isSpreadElement(element))
  ) {
    return Math.max(0, rawValue.elements.length - 1);
  }
  return Infinity;
}

function isFirstParameterReference(value: Expression, bindings: WrapperBindings): boolean {
  if (!isIdentifier(value)) return false;
  for (const [param, slot] of bindings.positionalSubs) {
    if (slot === 0 && isParameterDeclaration(param) && isIdentifierForParam(value, param)) {
      return true;
    }
  }
  return false;
}

function forwardsFirstParameterRaw(rawValue: Expression, bindings: WrapperBindings): boolean {
  if (isFirstParameterReference(rawValue, bindings)) return true;
  return (
    (isPropertyAccessExpression(rawValue) || isElementAccessExpression(rawValue)) &&
    frameMemberName(rawValue) === 'raw' &&
    isFirstParameterReference(unwrapped(rawValue.expression), bindings)
  );
}

export function ownRawPropertyInitializer(object: ObjectLiteralExpression): Expression | undefined {
  for (const property of object.properties.toReversed()) {
    const step = matchRawProperty(property);
    if (step === undefined) continue;
    return step.value;
  }
  return undefined;
}

function matchRawProperty(
  property: ObjectLiteralExpression['properties'][number],
): { readonly value: Expression | undefined } | undefined {
  if (isSpreadAssignment(property)) return { value: undefined };
  if (isShorthandPropertyAssignment(property)) {
    if (!isIdentifier(property.name)) return { value: undefined };
    return property.name.text === 'raw' ? { value: property.name } : undefined;
  }
  if (!isPropertyAssignment(property)) return { value: undefined };
  const names = assignedNames(property.name);
  if (names === undefined) return { value: undefined };
  if (!names.includes('raw')) return undefined;
  return { value: names.length === 1 ? unwrapped(property.initializer) : undefined };
}

export function forwardsCallSiteRaw(rawValue: Expression, bindings: WrapperBindings): boolean {
  if (isIdentifierForParam(rawValue, bindings.templateParam)) return true;
  if (
    bindings.rawParam !== undefined &&
    isIdentifier(rawValue) &&
    rawValue.text === bindings.rawParam.localName &&
    isIdentifierForParam(rawValue, bindings.rawParam.param)
  ) {
    return true;
  }
  return (
    (isPropertyAccessExpression(rawValue) || isElementAccessExpression(rawValue)) &&
    frameMemberName(rawValue) === 'raw' &&
    isIdentifierForParam(unwrapped(rawValue.expression), bindings.templateParam)
  );
}

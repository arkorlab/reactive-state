import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isIfStatement,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
  type TemplateExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedCondition } from './framed-sources.ts';
import { assignedNames } from './local-date-inputs.ts';
import { isDateValue } from './local-reads.ts';
import type { TagParameterEnv } from './render-raw-tag-calls.ts';
import { canonicalArrayTagIndex } from './render-raw-tag-paths.ts';
import {
  collectWrapperBindings,
  isIdentifierForParam,
  type WrapperBindings,
  type WrapperFunction,
} from './render-raw-wrapper-bindings.ts';

/** Custom template tag wrappers that forward Date substitutions into native String.raw. */

export interface RawWrapperSearch {
  readonly datedIndices: ReadonlySet<number>;
  readonly spanCount: number;
  readonly seenWrappers: ReadonlySet<Node>;
  readonly env?: TagParameterEnv | undefined;
}

export type MaySelectRawTag = (tag: Expression, search: RawWrapperSearch) => boolean;

export interface RawWrapperQuery extends RawWrapperSearch {
  readonly maySelectTag: MaySelectRawTag;
}

export interface ForwardedSlotsResult {
  readonly forwardedSlots: ReadonlySet<number>;
  readonly effectiveSpanCount: number;
}

interface CallForwardContext {
  readonly bindings: WrapperBindings;
  readonly query: RawWrapperQuery;
  readonly nextSeen: ReadonlySet<Node>;
}

interface SpreadSlotContext {
  readonly bindings: WrapperBindings;
  readonly query: RawWrapperSearch;
  readonly forwardedSlots: Set<number>;
}

/** Zero-based template substitution indices whose expressions carry direct or typed Date values. */
export function datedTemplateSpanIndices(template: TemplateExpression): ReadonlySet<number> {
  const indices = new Set<number>();
  for (const [index, span] of template.templateSpans.entries()) {
    if (isDateValue(span.expression)) indices.add(index);
  }
  return indices;
}

/** Checks whether `fn` forwards any Date-bearing template substitution to native String.raw. */
export function wrapperForwardsRawDate(fn: WrapperFunction, query: RawWrapperQuery): boolean {
  if (query.datedIndices.size === 0 || query.seenWrappers.has(fn) || fn.body === undefined) {
    return false;
  }
  const bindings = collectWrapperBindings(fn);
  const nextSeen = new Set([...query.seenWrappers, fn]);
  const pending: Node[] = [fn.body];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current !== fn.body && isFunctionLikeDeclaration(current)) continue;
    if (isIfStatement(current) && framedCondition(current.expression) === false) {
      if (current.elseStatement !== undefined) pending.push(current.elseStatement);
      continue;
    }
    if (nodeForwardsRawDate(current, bindings, query, nextSeen)) return true;
    current.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

function nodeForwardsRawDate(
  node: Node,
  bindings: WrapperBindings,
  query: RawWrapperQuery,
  nextSeen: ReadonlySet<Node>,
): boolean {
  if (isTaggedTemplateExpression(node) && isTemplateExpression(node.template)) {
    const innerDated = forwardedTemplateIndices(node.template, bindings, query.datedIndices);
    return (
      innerDated.size > 0 &&
      query.maySelectTag(node.tag, {
        datedIndices: innerDated,
        env: query.env,
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
  if (isWholeArgumentsReference(list, bindings)) {
    return query.maySelectTag(target, {
      datedIndices: query.datedIndices,
      env: query.env,
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
      isIdentifierForParam(unwrapped(first.expression), bindings.wholeRestParam) &&
      query.maySelectTag(target, {
        datedIndices: query.datedIndices,
        env: query.env,
        seenWrappers: nextSeen,
        spanCount: query.spanCount,
      })
    );
  }
  const maxSubs = callSiteMaxSubstitutions(first, bindings, query.spanCount);
  if (maxSubs <= 0) return false;
  const forwarded = forwardedSubstitutionSlots(rest, maxSubs, bindings, query);
  return (
    forwarded.forwardedSlots.size > 0 &&
    query.maySelectTag(target, {
      datedIndices: forwarded.forwardedSlots,
      env: query.env,
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

function carriesDatedSubstitution(
  expression: Expression,
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
  seen: Set<Node>,
): boolean {
  const value = unwrapped(expression);
  if (seen.has(value)) return false;
  seen.add(value);
  if (isIdentifier(value)) return identifierCarriesDated(value, bindings, datedIndices, seen);
  if (isElementAccessExpression(value)) {
    return elementAccessCarriesDated(value, bindings, datedIndices);
  }
  if (isArrayLiteralExpression(value)) {
    return arrayElementsCarryDated(value, bindings, datedIndices, seen);
  }
  if (isConditionalExpression(value)) {
    return (
      carriesDatedSubstitution(value.whenTrue, bindings, datedIndices, seen) ||
      carriesDatedSubstitution(value.whenFalse, bindings, datedIndices, seen)
    );
  }
  return (
    isBinaryExpression(value) &&
    isLogicalForwardOperator(value.operatorToken.kind) &&
    (carriesDatedSubstitution(value.left, bindings, datedIndices, seen) ||
      carriesDatedSubstitution(value.right, bindings, datedIndices, seen))
  );
}

function arrayElementsCarryDated(
  array: ArrayLiteralExpression,
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
  seen: Set<Node>,
): boolean {
  return array.elements.some((element) => {
    if (isOmittedExpression(element)) return false;
    const inner = isSpreadElement(element) ? element.expression : element;
    return carriesDatedSubstitution(inner, bindings, datedIndices, seen);
  });
}

function isLogicalForwardOperator(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.BarBarToken ||
    kind === SyntaxKind.QuestionQuestionToken ||
    kind === SyntaxKind.AmpersandAmpersandToken
  );
}

function identifierCarriesDated(
  name: Identifier,
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
  seen: Set<Node>,
): boolean {
  const declared = frameDeclarationOf(name);
  if (declared === undefined) return false;
  const positional = bindings.positionalSubs.get(declared);
  if (positional !== undefined) return datedIndices.has(positional);
  const { restSubs } = bindings;
  if (restSubs !== undefined && isIdentifierForParam(name, restSubs.param)) {
    return hasDatedFromIndex(datedIndices, restSubs.startIndex);
  }
  if (isIdentifierForParam(name, bindings.wholeRestParam)) return datedIndices.size > 0;
  return (
    isVariableDeclaration(declared) &&
    declared.initializer !== undefined &&
    carriesDatedSubstitution(declared.initializer, bindings, datedIndices, seen)
  );
}

function hasDatedFromIndex(datedIndices: ReadonlySet<number>, startIndex: number): boolean {
  for (const index of datedIndices) {
    if (index >= startIndex) return true;
  }
  return false;
}

function elementAccessCarriesDated(
  access: Expression & { readonly expression: Expression; readonly argumentExpression: Expression },
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
): boolean {
  const receiver = unwrapped(access.expression);
  const slot = canonicalArrayTagIndex(frameMemberName(access));
  const { restSubs } = bindings;
  if (restSubs !== undefined && isIdentifierForParam(receiver, restSubs.param)) {
    return slot === undefined
      ? hasDatedFromIndex(datedIndices, restSubs.startIndex)
      : datedIndices.has(restSubs.startIndex + slot);
  }
  if (isWholeArgumentsReference(receiver, bindings)) {
    return slot === undefined ? datedIndices.size > 0 : slot >= 1 && datedIndices.has(slot - 1);
  }
  return false;
}

function callSiteMaxSubstitutions(
  callSiteExpr: Expression,
  bindings: WrapperBindings,
  spanCount: number,
): number {
  const value = unwrapped(callSiteExpr);
  if (isIdentifierForParam(value, bindings.templateParam)) return spanCount;
  if (!isObjectLiteralExpression(value)) return Infinity;
  const rawValue = ownRawPropertyInitializer(value);
  if (rawValue === undefined) return Infinity;
  if (forwardsCallSiteRaw(rawValue, bindings)) return spanCount;
  if (
    isArrayLiteralExpression(rawValue) &&
    !rawValue.elements.some((element) => isSpreadElement(element))
  ) {
    return Math.max(0, rawValue.elements.length - 1);
  }
  return Infinity;
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

function isWholeArgumentsReference(value: Expression, bindings: WrapperBindings): boolean {
  if (isIdentifierForParam(value, bindings.wholeRestParam)) return true;
  return (
    bindings.hasImplicitArguments &&
    isIdentifier(value) &&
    value.text === 'arguments' &&
    frameDeclarationOf(value) === undefined
  );
}

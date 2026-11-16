import {
  type CallExpression,
  type Expression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  type Node,
  type ParameterDeclaration,
  type TemplateExpression,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import {
  createQuietRawWalkState,
  type QuietRawProof,
  resolveQuietCallableWithState,
} from './render-date-raw-factories.ts';
import {
  forwardsCallSiteRaw,
  type ForwardedSlotsResult,
  ownRawPropertyInitializer,
  type RawWrapperSearch,
} from './render-raw-tag-wrappers.ts';
import {
  collectWrapperBindings,
  findRawBindingLocalName,
  isIdentifierForParam,
  type WrapperBindings,
  type WrapperFunction,
} from './render-raw-wrapper-bindings.ts';

/** Quiet synchronous String.raw wrapper verification for projected Date template substitutions. */

const RAW_DATE_FIELDS: ReadonlySet<string> = new Set(['Date', 'String', 'String.raw']);

export interface QuietRawWrapperState extends RawWrapperSearch {
  readonly rawProofOf: (target: Expression, consumer: Expression) => QuietRawProof | undefined;
}

interface QuietSpineContext {
  readonly bindings: WrapperBindings;
  readonly nextSeen: ReadonlySet<Node>;
  readonly state: QuietRawWrapperState;
}

interface InnerTargetCheck {
  readonly datedIndices: ReadonlySet<number>;
  readonly spanCount: number;
  readonly nextSeen: ReadonlySet<Node>;
  readonly state: QuietRawWrapperState;
  readonly proof: QuietRawProof;
}

interface QuietCallArgContext {
  readonly bindings: WrapperBindings;
  readonly state: QuietRawWrapperState;
  readonly forwardedSlots: Set<number>;
}

/** Resolves quiet synchronous wrapper tags on projected-Date templates and returns read prefix proof. */
export function wrappedRawTagProof(
  tag: Expression,
  outerConsumer: Expression,
  state: QuietRawWrapperState,
): QuietRawProof | undefined {
  if (state.datedIndices.size === 0) return undefined;
  const walk = createQuietRawWalkState(outerConsumer);
  const fn = resolveQuietCallableWithState(tag, walk);
  if (fn === undefined || state.seenWrappers.has(fn)) return undefined;
  if (answersLater(fn) || !quietWrapperParameters(fn)) return undefined;
  const returned = singleReturnedExpression(fn);
  if (returned === undefined) return undefined;
  const bindings = collectWrapperBindings(fn);
  const nextSeen = new Set([...state.seenWrappers, fn]);
  return verifyLeftmostRawSpine(returned, outerConsumer, walk.proof, {
    bindings,
    nextSeen,
    state,
  })
    ? walk.proof
    : undefined;
}

function verifyLeftmostRawSpine(
  returned: Expression,
  outerConsumer: Expression,
  proof: QuietRawProof,
  context: QuietSpineContext,
): boolean {
  let current: Expression = returned;
  const seen = new Set<Node>();
  while (!seen.has(current)) {
    seen.add(current);
    if (matchesQuietWrappedNode(current, outerConsumer, proof, context)) return true;
    if (!isCallExpression(current)) return false;
    const callee = unwrapped(current.expression);
    if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return false;
    current = unwrapped(callee.expression);
  }
  return false;
}

function matchesQuietWrappedNode(
  candidate: Expression,
  outerConsumer: Expression,
  proof: QuietRawProof,
  context: QuietSpineContext,
): boolean {
  const { bindings, nextSeen, state } = context;
  if (isTaggedTemplateExpression(candidate) && isTemplateExpression(candidate.template)) {
    const innerDated = quietTemplateForwardedIndices(
      candidate.template,
      bindings,
      state.datedIndices,
    );
    return (
      innerDated !== undefined &&
      innerDated.size > 0 &&
      verifyInnerRawTarget(candidate.tag, candidate.template, outerConsumer, {
        datedIndices: innerDated,
        nextSeen,
        proof,
        spanCount: candidate.template.templateSpans.length,
        state,
      })
    );
  }
  if (!isCallExpression(candidate)) return false;
  const forwarded = quietCallForwardedSlots(candidate, bindings, state);
  return (
    forwarded !== undefined &&
    forwarded.forwardedSlots.size > 0 &&
    verifyInnerRawTarget(candidate.expression, candidate, outerConsumer, {
      datedIndices: forwarded.forwardedSlots,
      nextSeen,
      proof,
      spanCount: forwarded.effectiveSpanCount,
      state,
    })
  );
}

function verifyInnerRawTarget(
  innerTarget: Expression,
  innerConsumer: Expression,
  outerConsumer: Expression,
  check: InnerTargetCheck,
): boolean {
  const innerProof = check.state.rawProofOf(innerTarget, innerConsumer);
  if (
    innerProof !== undefined &&
    framedQuietTextPrefix(
      innerConsumer,
      RAW_DATE_FIELDS,
      (call) => innerProof.calls.has(call),
      innerProof.fields,
    )
  ) {
    mergeSameOwnerProof(innerProof, outerConsumer, check.proof);
    return true;
  }
  const nested = wrappedRawTagProof(innerTarget, innerConsumer, {
    datedIndices: check.datedIndices,
    rawProofOf: check.state.rawProofOf,
    seenWrappers: check.nextSeen,
    spanCount: check.spanCount,
  });
  if (
    nested === undefined ||
    !framedQuietTextPrefix(
      innerConsumer,
      RAW_DATE_FIELDS,
      (call) => nested.calls.has(call),
      nested.fields,
    )
  ) {
    return false;
  }
  mergeSameOwnerProof(nested, outerConsumer, check.proof);
  return true;
}

function mergeSameOwnerProof(
  source: QuietRawProof,
  outerConsumer: Expression,
  target: QuietRawProof,
): void {
  for (const field of source.fields) {
    if (framedPrefixSameOwner(field, outerConsumer)) target.fields.add(field);
  }
  for (const call of source.calls) {
    if (framedPrefixSameOwner(call, outerConsumer)) target.calls.add(call);
  }
}

function quietTemplateForwardedIndices(
  template: TemplateExpression,
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
): ReadonlySet<number> | undefined {
  const inner = new Set<number>();
  for (const [index, span] of template.templateSpans.entries()) {
    const expr = unwrapped(span.expression);
    const paramIndex = directPositionalParamIndex(expr, bindings);
    if (paramIndex !== undefined) {
      if (datedIndices.has(paramIndex)) inner.add(index);
      continue;
    }
    if (!framedQuietPrimitive(expr)) return undefined;
  }
  return inner;
}

function quietCallForwardedSlots(
  call: CallExpression,
  bindings: WrapperBindings,
  state: QuietRawWrapperState,
): ForwardedSlotsResult | undefined {
  const [first, ...rest] = call.arguments;
  if (first === undefined) return undefined;
  if (isSpreadElement(first)) {
    return call.arguments.length === 1 &&
      isIdentifierForParam(unwrapped(first.expression), bindings.wholeRestParam)
      ? { effectiveSpanCount: state.spanCount, forwardedSlots: state.datedIndices }
      : undefined;
  }
  if (!quietCallSiteForwardsTemplate(first, bindings)) return undefined;
  return collectQuietCallSlots(rest, bindings, state);
}

function collectQuietCallSlots(
  restArgs: readonly Expression[],
  bindings: WrapperBindings,
  state: QuietRawWrapperState,
): ForwardedSlotsResult | undefined {
  const forwardedSlots = new Set<number>();
  let slot = 0;
  for (const arg of restArgs) {
    const nextSlot = stepQuietCallArg(arg, slot, { bindings, forwardedSlots, state });
    if (nextSlot === undefined) return undefined;
    slot = nextSlot;
  }
  return { effectiveSpanCount: state.spanCount, forwardedSlots };
}

function stepQuietCallArg(
  arg: Expression,
  slot: number,
  context: QuietCallArgContext,
): number | undefined {
  if (isSpreadElement(arg)) return stepSpreadQuietCallArg(arg.expression, slot, context);
  const { bindings, forwardedSlots, state } = context;
  const paramIndex = directPositionalParamIndex(unwrapped(arg), bindings);
  if (paramIndex !== undefined) {
    if (slot < state.spanCount && state.datedIndices.has(paramIndex)) forwardedSlots.add(slot);
    return slot + 1;
  }
  return framedQuietPrimitive(arg) ? slot + 1 : undefined;
}

function stepSpreadQuietCallArg(
  spreadExpr: Expression,
  slot: number,
  context: QuietCallArgContext,
): number | undefined {
  const { bindings, forwardedSlots, state } = context;
  const { restSubs } = bindings;
  if (restSubs === undefined || !isIdentifierForParam(unwrapped(spreadExpr), restSubs.param)) {
    return undefined;
  }
  for (const datedIndex of state.datedIndices) {
    if (datedIndex < restSubs.startIndex) continue;
    const mappedSlot = slot + (datedIndex - restSubs.startIndex);
    if (mappedSlot < state.spanCount) forwardedSlots.add(mappedSlot);
  }
  return slot + Math.max(0, state.spanCount - restSubs.startIndex);
}

function directPositionalParamIndex(
  expr: Expression,
  bindings: WrapperBindings,
): number | undefined {
  if (!isIdentifier(expr)) return undefined;
  const declared = frameDeclarationOf(expr);
  return declared === undefined ? undefined : bindings.positionalSubs.get(declared);
}

function quietCallSiteForwardsTemplate(
  callSiteExpr: Expression,
  bindings: WrapperBindings,
): boolean {
  const value = unwrapped(callSiteExpr);
  if (isIdentifierForParam(value, bindings.templateParam)) return true;
  if (!isObjectLiteralExpression(value) || value.properties.length !== 1) return false;
  const rawValue = ownRawPropertyInitializer(value);
  return rawValue !== undefined && forwardsCallSiteRaw(rawValue, bindings);
}

function quietWrapperParameters(fn: WrapperFunction): boolean {
  for (const [index, param] of fn.parameters.entries()) {
    if (param.initializer !== undefined) return false;
    if (isIdentifier(param.name)) continue;
    if (index === 0 && param.dotDotDotToken === undefined && isQuietRawPattern(param)) continue;
    return false;
  }
  return true;
}

function isQuietRawPattern(param: ParameterDeclaration): boolean {
  if (!isObjectBindingPattern(param.name) || param.name.elements.length !== 1) return false;
  const [element] = param.name.elements;
  return (
    element !== undefined &&
    element.initializer === undefined &&
    findRawBindingLocalName(param) !== undefined
  );
}

function singleReturnedExpression(fn: WrapperFunction): Expression | undefined {
  if (fn.body === undefined) return undefined;
  if (!isBlock(fn.body)) return unwrapped(fn.body);
  const [first] = fn.body.statements;
  return first !== undefined &&
    fn.body.statements.length === 1 &&
    isReturnStatement(first) &&
    first.expression !== undefined
    ? unwrapped(first.expression)
    : undefined;
}

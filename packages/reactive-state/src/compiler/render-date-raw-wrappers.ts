import {
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  type Node,
  SyntaxKind,
  type TemplateExpression,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import {
  createQuietRawWalkState,
  forkQuietRawWalkState,
  quietFactoryBodyReturn,
  type QuietRawProof,
  type QuietRawWalkState,
  resolveQuietCallableWithState,
} from './render-date-raw-factories.ts';
import { forwardsCallSiteRaw, ownRawPropertyInitializer } from './render-raw-tag-wrappers.ts';
import {
  collectWrapperBindings,
  directPositionalParamIndex,
  type ForwardedSlotsResult,
  isIdentifierForParam,
  isQuietDatedArrayCarrier,
  isQuietDatedCarrier,
  isQuietDatedPositional,
  isQuietOperand,
  quietWrapperParameters,
  type RawWrapperSearch,
  type WrapperBindings,
} from './render-raw-wrapper-bindings.ts';
import { isCoercingDateMethodName } from './render-tag-date-coercions.ts';

/** Quiet synchronous tag and helper verification for projected Date template substitutions. */

const RAW_DATE_FIELDS: ReadonlySet<string> = new Set(['Date', 'String', 'String.raw']);
const ARRAY_TEXT_METHODS: ReadonlySet<string> = new Set(['join', 'toLocaleString', 'toString']);

export type QuietTargetProofFn = (
  target: Expression,
  consumer: Expression,
  walk?: QuietRawWalkState,
) => QuietRawProof | undefined;

export interface QuietRawWrapperState extends RawWrapperSearch {
  readonly rawProofOf: QuietTargetProofFn;
  readonly stringProofOf?: QuietTargetProofFn | undefined;
  readonly parentWalk?: QuietRawWalkState | undefined;
}

interface QuietSpineContext {
  readonly bindings: WrapperBindings;
  readonly nextSeen: ReadonlySet<string>;
  readonly outerConsumer: Expression;
  readonly proof: QuietRawProof;
  readonly state: QuietRawWrapperState;
  readonly walk: QuietRawWalkState;
}

interface InnerTargetCheck {
  readonly datedIndices: ReadonlySet<number>;
  readonly spanCount: number;
  readonly nextSeen: ReadonlySet<string>;
  readonly state: QuietRawWrapperState;
  readonly proof: QuietRawProof;
  readonly walk: QuietRawWalkState;
}

interface QuietCallArgContext {
  readonly bindings: WrapperBindings;
  readonly state: QuietRawWrapperState;
  readonly forwardedSlots: Set<number>;
}

/** Resolves quiet synchronous wrapper or coercing tags on projected-Date templates. */
export function wrappedRawTagProof(
  tag: Expression,
  outerConsumer: Expression,
  state: QuietRawWrapperState,
): QuietRawProof | undefined {
  if (state.datedIndices.size === 0) return undefined;
  const paramOffset = state.paramOffset ?? 1;
  const walk =
    state.parentWalk === undefined
      ? createQuietRawWalkState(outerConsumer)
      : forkQuietRawWalkState(outerConsumer, state.parentWalk);
  const fn = resolveQuietCallableWithState(tag, walk);
  if (fn === undefined || answersLater(fn) || !quietWrapperParameters(fn, paramOffset)) {
    return undefined;
  }
  const wrapperKey = `${String(fn.pos)}:${String(fn.end)}:${String(paramOffset)}@${String(walk.callScope)}`;
  if (state.seenWrappers.has(wrapperKey) || fn.body === undefined) return undefined;
  const bodyWalk = forkQuietRawWalkState(outerConsumer, walk);
  bodyWalk.allowedOwners.add(fn);
  const returned = quietFactoryBodyReturn(fn.body, bodyWalk);
  if (returned === undefined) return undefined;
  const bindings = collectWrapperBindings(fn, paramOffset);
  const nextSeen = new Set([...state.seenWrappers, wrapperKey]);
  return verifyLeftmostRawSpine(returned, {
    bindings,
    nextSeen,
    outerConsumer,
    proof: walk.proof,
    state,
    walk,
  })
    ? walk.proof
    : undefined;
}

function verifyLeftmostRawSpine(returned: Expression, context: QuietSpineContext): boolean {
  let current: Expression = returned;
  const seen = new Set<Node>();
  while (!seen.has(current)) {
    seen.add(current);
    if (matchesQuietWrappedNode(current, context)) return true;
    if (!isCallExpression(current)) return false;
    const callee = unwrapped(current.expression);
    if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return false;
    current = unwrapped(callee.expression);
  }
  return false;
}

function matchesQuietWrappedNode(candidate: Expression, context: QuietSpineContext): boolean {
  const { bindings, nextSeen, outerConsumer, proof, state, walk } = context;
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
        walk,
      })
    );
  }
  if (isTemplateExpression(candidate)) {
    return (
      quietUntaggedTemplateCoerces(candidate, bindings, state.datedIndices) &&
      verifyLocalQuietPrefix(candidate)
    );
  }
  if (isBinaryExpression(candidate) && candidate.operatorToken.kind === SyntaxKind.PlusToken) {
    return (
      quietBinaryPlusCoerces(candidate.left, candidate.right, bindings, state.datedIndices) &&
      verifyLocalQuietPrefix(candidate)
    );
  }
  if (isNewExpression(candidate)) {
    return verifyQuietStringTarget(
      candidate.expression,
      candidate.arguments ?? [],
      candidate,
      context,
    );
  }
  return isCallExpression(candidate) && matchesQuietCallNode(candidate, context);
}

function matchesQuietCallNode(call: CallExpression, context: QuietSpineContext): boolean {
  const { bindings, nextSeen, outerConsumer, proof, state, walk } = context;
  if ((state.paramOffset ?? 1) === 1) {
    const forwarded = quietCallForwardedSlots(call, bindings, state);
    if (
      forwarded !== undefined &&
      forwarded.forwardedSlots.size > 0 &&
      verifyInnerRawTarget(call.expression, call, outerConsumer, {
        datedIndices: forwarded.forwardedSlots,
        nextSeen,
        proof,
        spanCount: forwarded.effectiveSpanCount,
        state,
        walk,
      })
    ) {
      return true;
    }
  }
  if (verifyQuietStringTarget(call.expression, call.arguments, call, context)) return true;
  if (
    quietDirectMethodCoerces(call, bindings, state.datedIndices) &&
    verifyLocalQuietPrefix(call)
  ) {
    return true;
  }
  return verifyQuietHelperCall(call, context);
}

function verifyLocalQuietPrefix(consumer: Expression): boolean {
  return framedQuietTextPrefix(consumer, RAW_DATE_FIELDS);
}

function verifyQuietStringTarget(
  target: Expression,
  args: readonly Expression[],
  consumer: Expression,
  context: QuietSpineContext,
): boolean {
  const { bindings, outerConsumer, proof, state, walk } = context;
  const [first, ...rest] = args;
  if (
    first === undefined ||
    state.stringProofOf === undefined ||
    !isQuietDatedCarrier(unwrapped(first), bindings, state.datedIndices) ||
    rest.some((arg) => !isQuietOperand(arg, bindings))
  ) {
    return false;
  }
  const innerWalk = forkQuietRawWalkState(consumer, walk);
  const innerProof = state.stringProofOf(target, consumer, innerWalk);
  if (
    innerProof === undefined ||
    !framedQuietTextPrefix(
      consumer,
      RAW_DATE_FIELDS,
      (c) => innerProof.calls.has(c),
      innerProof.fields,
    )
  ) {
    return false;
  }
  mergeSameOwnerProof(innerProof, outerConsumer, proof);
  return true;
}

function verifyQuietHelperCall(call: CallExpression, context: QuietSpineContext): boolean {
  const { bindings, nextSeen, outerConsumer, proof, state, walk } = context;
  const forwarded = collectQuietCallSlots(call.arguments, bindings, state);
  if (forwarded === undefined || forwarded.forwardedSlots.size === 0) return false;
  const innerWalk = forkQuietRawWalkState(call, walk);
  const nested = wrappedRawTagProof(call.expression, call, {
    datedIndices: forwarded.forwardedSlots,
    paramOffset: 0,
    parentWalk: innerWalk,
    rawProofOf: state.rawProofOf,
    seenWrappers: nextSeen,
    spanCount: forwarded.effectiveSpanCount,
    stringProofOf: state.stringProofOf,
  });
  if (
    nested === undefined ||
    !framedQuietTextPrefix(call, RAW_DATE_FIELDS, (c) => nested.calls.has(c), nested.fields)
  ) {
    return false;
  }
  mergeSameOwnerProof(nested, outerConsumer, proof);
  return true;
}

function quietDirectMethodCoerces(
  call: CallExpression,
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
): boolean {
  const callee = unwrapped(call.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return false;
  const method = frameMemberName(callee);
  if (method === undefined) return false;
  const recv = unwrapped(callee.expression);
  const quietArgs = call.arguments.every((arg) => isQuietOperand(arg, bindings));
  if (isQuietDatedPositional(recv, bindings, datedIndices)) {
    return quietArgs && isCoercingDateMethodName(method);
  }
  if (isQuietDatedArrayCarrier(recv, bindings, datedIndices)) {
    return quietArgs && ARRAY_TEXT_METHODS.has(method);
  }
  if (method === 'concat' && framedQuietPrimitive(recv)) {
    return (
      call.arguments.every((arg) => {
        return (
          isQuietOperand(arg, bindings) ||
          isQuietDatedCarrier(unwrapped(arg), bindings, datedIndices)
        );
      }) &&
      call.arguments.some((arg) => isQuietDatedCarrier(unwrapped(arg), bindings, datedIndices))
    );
  }
  return false;
}

function quietUntaggedTemplateCoerces(
  template: TemplateExpression,
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
): boolean {
  for (const span of template.templateSpans) {
    const expr = unwrapped(span.expression);
    if (isQuietDatedCarrier(expr, bindings, datedIndices)) return true;
    if (!isQuietOperand(span.expression, bindings)) return false;
  }
  return false;
}

function quietBinaryPlusCoerces(
  left: Expression,
  right: Expression,
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
): boolean {
  return (
    (isQuietDatedCarrier(unwrapped(left), bindings, datedIndices) &&
      isQuietOperand(right, bindings)) ||
    (isQuietOperand(left, bindings) &&
      isQuietDatedCarrier(unwrapped(right), bindings, datedIndices))
  );
}

function verifyInnerRawTarget(
  innerTarget: Expression,
  innerConsumer: Expression,
  outerConsumer: Expression,
  check: InnerTargetCheck,
): boolean {
  const innerWalk = forkQuietRawWalkState(innerConsumer, check.walk);
  const innerProof = check.state.rawProofOf(innerTarget, innerConsumer, innerWalk);
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
    parentWalk: innerWalk,
    rawProofOf: check.state.rawProofOf,
    seenWrappers: check.nextSeen,
    spanCount: check.spanCount,
    stringProofOf: check.state.stringProofOf,
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
  const highest = forwardedSlots.size === 0 ? 0 : Math.max(...forwardedSlots) + 1;
  return { effectiveSpanCount: Math.max(state.spanCount, slot, highest), forwardedSlots };
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
    if (state.datedIndices.has(paramIndex)) forwardedSlots.add(slot);
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

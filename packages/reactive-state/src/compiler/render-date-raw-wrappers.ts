import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyName,
  SyntaxKind,
  type TemplateExpression,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameBindingOf, frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { assignedNames } from './local-date-inputs.ts';
import { canonicalArrayTagIndex } from './render-raw-tag-paths.ts';
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
  readonly rawFieldsOf: (
    target: Expression,
    consumer: Expression,
  ) => ReadonlySet<Expression> | undefined;
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
  readonly fields: Set<Expression>;
}

interface QuietCallArgContext {
  readonly bindings: WrapperBindings;
  readonly state: QuietRawWrapperState;
  readonly forwardedSlots: Set<number>;
}

interface QuietWrapperStep {
  readonly fn?: WrapperFunction;
  readonly next?: Expression;
}

/** Resolves quiet synchronous wrapper tags on projected-Date templates and returns read prefix fields. */
export function wrappedRawTagFields(
  tag: Expression,
  outerConsumer: Expression,
  state: QuietRawWrapperState,
): ReadonlySet<Expression> | undefined {
  if (state.datedIndices.size === 0) return undefined;
  const resolved = resolveQuietWrapperFunction(tag, outerConsumer);
  if (resolved === undefined || state.seenWrappers.has(resolved.fn)) return undefined;
  const { fields, fn } = resolved;
  if (answersLater(fn) || !quietWrapperParameters(fn)) return undefined;
  const returned = singleReturnedExpression(fn);
  if (returned === undefined) return undefined;
  const bindings = collectWrapperBindings(fn);
  const nextSeen = new Set([...state.seenWrappers, fn]);
  return verifyLeftmostRawSpine(returned, outerConsumer, fields, {
    bindings,
    nextSeen,
    state,
  })
    ? fields
    : undefined;
}

function verifyLeftmostRawSpine(
  returned: Expression,
  outerConsumer: Expression,
  fields: Set<Expression>,
  context: QuietSpineContext,
): boolean {
  let current: Expression = returned;
  const seen = new Set<Node>();
  while (!seen.has(current)) {
    seen.add(current);
    if (matchesQuietWrappedNode(current, outerConsumer, fields, context)) return true;
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
  fields: Set<Expression>,
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
        fields,
        nextSeen,
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
      fields,
      nextSeen,
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
  if (framedOriginCoowned(innerTarget, outerConsumer)) {
    const innerFields = check.state.rawFieldsOf(innerTarget, innerConsumer);
    if (
      innerFields !== undefined &&
      framedQuietTextPrefix(innerConsumer, RAW_DATE_FIELDS, undefined, innerFields)
    ) {
      addSameOwnerFields(innerFields, outerConsumer, check.fields);
      return true;
    }
  }
  const nested = wrappedRawTagFields(innerTarget, outerConsumer, {
    datedIndices: check.datedIndices,
    rawFieldsOf: check.state.rawFieldsOf,
    seenWrappers: check.nextSeen,
    spanCount: check.spanCount,
  });
  if (nested === undefined || !framedQuietTextPrefix(innerConsumer, RAW_DATE_FIELDS)) return false;
  addSameOwnerFields(nested, outerConsumer, check.fields);
  return true;
}

function addSameOwnerFields(
  source: ReadonlySet<Expression>,
  outerConsumer: Expression,
  target: Set<Expression>,
): void {
  for (const field of source) {
    if (framedPrefixSameOwner(field, outerConsumer)) target.add(field);
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

function resolveQuietWrapperFunction(
  tag: Expression,
  outerConsumer: Expression,
): { readonly fn: WrapperFunction; readonly fields: Set<Expression> } | undefined {
  const fields = new Set<Expression>();
  const tail: string[] = [];
  const seen = new Set<Node>();
  let current: Expression | undefined = unwrapped(tag);
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const step = stepQuietWrapperTarget(current, outerConsumer, tail, fields);
    if (step === undefined) return undefined;
    if (step.fn !== undefined) return { fields, fn: step.fn };
    current = step.next === undefined ? undefined : unwrapped(step.next);
  }
  return undefined;
}

function stepQuietWrapperTarget(
  value: Expression,
  outerConsumer: Expression,
  tail: string[],
  fields: Set<Expression>,
): QuietWrapperStep | undefined {
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const name = frameMemberName(value);
    if (name === undefined || !framedPrefixSameOwner(value, outerConsumer)) return undefined;
    fields.add(value);
    tail.unshift(name);
    return { next: value.expression };
  }
  if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.CommaToken) {
    return framedQuietPrimitive(value.left) ? { next: value.right } : undefined;
  }
  if (tail.length > 0 && isArrayLiteralExpression(value)) {
    return stepQuietArrayElement(value, tail);
  }
  if (tail.length > 0 && isObjectLiteralExpression(value)) {
    return stepQuietObjectMember(value, tail);
  }
  return stepQuietIdentifierOrFunction(value, outerConsumer, tail.length);
}

function stepQuietArrayElement(
  array: ArrayLiteralExpression,
  tail: string[],
): QuietWrapperStep | undefined {
  const index = canonicalArrayTagIndex(tail[0]);
  if (index === undefined || index >= array.elements.length) return undefined;
  for (let slot = 0; slot < index; slot += 1) {
    const before = array.elements[slot];
    if (before !== undefined && isSpreadElement(before)) return undefined;
  }
  const element = array.elements[index];
  if (element === undefined || isOmittedExpression(element) || isSpreadElement(element)) {
    return undefined;
  }
  tail.shift();
  return { next: element };
}

function stepQuietObjectMember(
  object: ObjectLiteralExpression,
  tail: string[],
): QuietWrapperStep | undefined {
  const [head] = tail;
  if (head === undefined || head === '__proto__') return undefined;
  for (const property of object.properties.toReversed()) {
    const matched = matchQuietObjectProperty(property, head, tail.length);
    if (matched === undefined) continue;
    if (matched.fn === undefined && matched.next === undefined) return undefined;
    tail.shift();
    return matched;
  }
  return undefined;
}

function matchQuietObjectProperty(
  property: ObjectLiteralExpression['properties'][number],
  head: string,
  tailLength: number,
): QuietWrapperStep | undefined {
  if (isSpreadAssignment(property)) return {};
  if (isShorthandPropertyAssignment(property)) {
    if (!isIdentifier(property.name)) return {};
    return property.name.text === head ? { next: property.name } : undefined;
  }
  if (isMethodDeclaration(property)) {
    const hit = matchQuietPropertyName(property.name, head);
    if (hit === undefined) return undefined;
    return tailLength === 1 && hit.sole ? { fn: property } : {};
  }
  if (!isPropertyAssignment(property)) return {};
  const hit = matchQuietPropertyName(property.name, head);
  if (hit === undefined) return undefined;
  return hit.sole ? { next: property.initializer } : {};
}

function matchQuietPropertyName(
  name: PropertyName,
  head: string,
): { readonly sole: boolean } | undefined {
  const names = assignedNames(name);
  if (names === undefined) return { sole: false };
  return names.includes(head) ? { sole: names.length === 1 } : undefined;
}

function stepQuietIdentifierOrFunction(
  value: Expression,
  outerConsumer: Expression,
  tailLength: number,
): QuietWrapperStep | undefined {
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    return tailLength === 0 ? { fn: value } : undefined;
  }
  if (!isIdentifier(value)) return undefined;
  const declared = frameDeclarationOf(value);
  if (declared !== undefined && isFunctionDeclaration(declared)) {
    return tailLength === 0 &&
      framedPrefixSameOwner(declared, outerConsumer) &&
      framedAssignedSources(value).length === 0
      ? { fn: declared }
      : undefined;
  }
  const next = sameOwnerConstInitializer(value, outerConsumer);
  return next === undefined ? undefined : { next };
}

function sameOwnerConstInitializer(
  name: Identifier,
  outerConsumer: Expression,
): Expression | undefined {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  if (
    !framedPrefixSameOwner(binding, outerConsumer) ||
    !isVariableDeclaration(binding) ||
    !isVariableDeclarationList(binding.parent) ||
    binding.initializer === undefined
  ) {
    return undefined;
  }
  const statement = binding.parent.parent;
  if (
    !isVariableStatement(statement) ||
    !/^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
  ) {
    return undefined;
  }
  const initial = unwrapped(binding.initializer);
  if (
    (isArrayLiteralExpression(initial) || isObjectLiteralExpression(initial)) &&
    framedQuietSource(name) === undefined
  ) {
    return undefined;
  }
  return binding.initializer;
}

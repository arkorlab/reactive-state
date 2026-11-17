import {
  type ArrayLiteralExpression,
  type ArrowFunction,
  type BindingElement,
  type CallExpression,
  type Expression,
  type FunctionExpression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isForOfStatement,
  isFunctionExpression,
  isIdentifier,
  isOmittedExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { frameBindingOf, frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedCondition } from './framed-sources.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { constantValue } from './numbers.ts';
import { canonicalArrayTagIndex } from './render-raw-tag-paths.ts';
import {
  hasDatedFromIndex,
  isIdentifierForParam,
  isWholeArgumentsReference,
  rangeHasDated,
  type WrapperBindings,
} from './render-raw-wrapper-bindings.ts';
import { bindingIdentifiers } from './scope.ts';

/** Tracks expressions inside a tag or helper body that carry Date-bearing substitution values. */

const ELEMENT_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'every',
  'filter',
  'find',
  'findLast',
  'flatMap',
  'forEach',
  'map',
  'some',
]);
const REDUCE_METHODS: ReadonlySet<string> = new Set(['reduce', 'reduceRight']);
const PASSTHROUGH_ARRAY_METHODS: ReadonlySet<string> = new Set([
  'filter',
  'flat',
  'reverse',
  'sort',
  'toReversed',
  'toSorted',
  'values',
]);

export interface DatedCarrierContext {
  readonly bindings: WrapperBindings;
  readonly datedIndices: ReadonlySet<number>;
}

export function carriesDatedSubstitution(
  expression: Expression,
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
  seen: Set<Node>,
): boolean {
  if (datedIndices.size === 0) return false;
  const value = unwrapped(expression);
  if (seen.has(value)) return false;
  seen.add(value);
  const ctx: DatedCarrierContext = { bindings, datedIndices };
  if (isIdentifier(value)) return identifierCarriesDated(value, ctx, seen);
  if (isElementAccessExpression(value)) return elementAccessCarriesDated(value, ctx, seen);
  if (isArrayLiteralExpression(value)) return arrayElementsCarryDated(value, ctx, seen);
  if (isCallExpression(value)) return callResultCarriesDated(value, ctx, seen);
  if (isConditionalExpression(value)) return conditionalCarriesDated(value, ctx, seen);
  return binaryCarriesDated(value, ctx, seen);
}

function conditionalCarriesDated(
  value: Expression & {
    readonly condition: Expression;
    readonly whenTrue: Expression;
    readonly whenFalse: Expression;
  },
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  const branch = framedCondition(value.condition);
  if (branch === true) {
    return carriesDatedSubstitution(value.whenTrue, ctx.bindings, ctx.datedIndices, seen);
  }
  if (branch === false) {
    return carriesDatedSubstitution(value.whenFalse, ctx.bindings, ctx.datedIndices, seen);
  }
  return (
    carriesDatedSubstitution(value.whenTrue, ctx.bindings, ctx.datedIndices, seen) ||
    carriesDatedSubstitution(value.whenFalse, ctx.bindings, ctx.datedIndices, seen)
  );
}

function binaryCarriesDated(value: Expression, ctx: DatedCarrierContext, seen: Set<Node>): boolean {
  if (!isBinaryExpression(value)) return false;
  const kind = value.operatorToken.kind;
  if (kind === SyntaxKind.CommaToken) {
    return carriesDatedSubstitution(value.right, ctx.bindings, ctx.datedIndices, seen);
  }
  return (
    isLogicalForwardOperator(kind) &&
    (carriesDatedSubstitution(value.left, ctx.bindings, ctx.datedIndices, seen) ||
      carriesDatedSubstitution(value.right, ctx.bindings, ctx.datedIndices, seen))
  );
}

function isLogicalForwardOperator(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.BarBarToken ||
    kind === SyntaxKind.QuestionQuestionToken ||
    kind === SyntaxKind.AmpersandAmpersandToken
  );
}

function arrayElementsCarryDated(
  array: ArrayLiteralExpression,
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  return array.elements.some((element) => {
    if (isOmittedExpression(element)) return false;
    if (
      isSpreadElement(element) &&
      isWholeArgumentsReference(unwrapped(element.expression), ctx.bindings)
    ) {
      return ctx.datedIndices.size > 0;
    }
    const inner = isSpreadElement(element) ? element.expression : element;
    return carriesDatedSubstitution(inner, ctx.bindings, ctx.datedIndices, seen);
  });
}

function identifierCarriesDated(
  name: Identifier,
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  for (const assigned of framedAssignedSources(name)) {
    if (
      assigned.keys.length === 0 &&
      carriesDatedSubstitution(assigned.value, ctx.bindings, ctx.datedIndices, seen)
    ) {
      return true;
    }
  }
  const declared = frameDeclarationOf(name);
  if (declared === undefined) return false;
  if (isParameterDeclaration(declared)) return parameterCarriesDated(name, declared, ctx, seen);
  return isVariableDeclaration(declared) && variableCarriesDated(name, declared, ctx, seen);
}

function parameterCarriesDated(
  name: Identifier,
  declared: ParameterDeclaration,
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  const { bindings, datedIndices } = ctx;
  const positional = bindings.positionalSubs.get(declared);
  if (positional !== undefined) {
    return bindings.wildcardSubs ? datedIndices.size > 0 : datedIndices.has(positional);
  }
  if (declared === bindings.restSubs?.param) {
    return restBindingCarriesDated(name, declared, bindings.restSubs.startIndex, datedIndices);
  }
  if (declared === bindings.wholeRestParam) {
    return restBindingCarriesDated(name, declared, -bindings.paramOffset, datedIndices);
  }
  return callbackParameterCarriesDated(declared, ctx, seen);
}

function restBindingCarriesDated(
  name: Identifier,
  declared: ParameterDeclaration,
  startIndex: number,
  datedIndices: ReadonlySet<number>,
): boolean {
  if (isIdentifier(declared.name) && name.text === declared.name.text) {
    return startIndex <= 0 ? datedIndices.size > 0 : hasDatedFromIndex(datedIndices, startIndex);
  }
  const bound = findBindingElement(declared, name.text);
  if (bound === undefined || !isArrayBindingPattern(bound.parent)) return false;
  const elementIndex = bound.parent.elements.indexOf(bound);
  if (elementIndex === -1) return false;
  const subSlot = startIndex + elementIndex;
  if (bound.dotDotDotToken !== undefined) {
    return subSlot <= 0 ? datedIndices.size > 0 : hasDatedFromIndex(datedIndices, subSlot);
  }
  return subSlot >= 0 && datedIndices.has(subSlot);
}

function findBindingElement(
  declared: ParameterDeclaration | VariableDeclaration,
  text: string,
): BindingElement | undefined {
  const found = bindingIdentifiers(declared.name).find((id) => id.text === text);
  return found !== undefined && isBindingElement(found.parent) ? found.parent : undefined;
}

function variableCarriesDated(
  name: Identifier,
  declared: VariableDeclaration,
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  if (isVariableDeclarationList(declared.parent) && isForOfStatement(declared.parent.parent)) {
    return forOfVariableCarriesDated(name, declared.parent.parent.expression, {
      ctx,
      seen,
    });
  }
  if (declared.initializer === undefined) return false;
  const selected = frameBindingOf(name);
  if (selected?.keys.length === 1) {
    return indexedSourceCarriesDated(declared.initializer, selected.keys[0], ctx, seen);
  }
  return (
    (selected === undefined || selected.keys.length === 0) &&
    carriesDatedSubstitution(declared.initializer, ctx.bindings, ctx.datedIndices, seen)
  );
}

function forOfVariableCarriesDated(
  name: Identifier,
  iterable: Expression,
  walk: { readonly ctx: DatedCarrierContext; readonly seen: Set<Node> },
): boolean {
  const iter = unwrapped(iterable);
  if (
    isCallExpression(iter) &&
    (isPropertyAccessExpression(iter.expression) || isElementAccessExpression(iter.expression)) &&
    frameMemberName(iter.expression) === 'entries'
  ) {
    const selected = frameBindingOf(name);
    if (selected?.keys.length === 1 && selected.keys[0] === '0') return false;
    return carriesDatedSubstitution(
      iter.expression.expression,
      walk.ctx.bindings,
      walk.ctx.datedIndices,
      walk.seen,
    );
  }
  return carriesDatedSubstitution(iter, walk.ctx.bindings, walk.ctx.datedIndices, walk.seen);
}

function callbackParameterCarriesDated(
  declared: ParameterDeclaration,
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  const parent = declared.parent;
  if (!isArrowFunction(parent) && !isFunctionExpression(parent)) return false;
  const paramIndex = parent.parameters.indexOf(declared);
  if (paramIndex === -1) return false;
  return inlineCallbackSlotDated(parent, paramIndex, ctx, seen);
}

function inlineCallbackSlotDated(
  callback: ArrowFunction | FunctionExpression,
  paramIndex: number,
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  const { at, parent } = useOf(callback);
  if (!isCallExpression(parent)) return false;
  const callee = unwrapped(parent.expression);
  if (globalPathOf(callee)?.join('.') === 'Array.from') {
    const [iterable, mapFn] = parent.arguments;
    return (
      paramIndex === 0 &&
      mapFn !== undefined &&
      unwrapped(mapFn) === at &&
      iterable !== undefined &&
      iterableOrArgumentsDated(iterable, ctx, seen)
    );
  }
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return false;
  if (parent.arguments[0] === undefined || unwrapped(parent.arguments[0]) !== at) return false;
  const method = frameMemberName(callee);
  if (method === undefined) return false;
  if (ELEMENT_CALLBACK_METHODS.has(method)) {
    return (
      paramIndex === 0 &&
      carriesDatedSubstitution(callee.expression, ctx.bindings, ctx.datedIndices, seen)
    );
  }
  if (!REDUCE_METHODS.has(method)) return false;
  const matchesSlot = paramIndex === 1 || (paramIndex === 0 && parent.arguments.length < 2);
  return (
    matchesSlot && carriesDatedSubstitution(callee.expression, ctx.bindings, ctx.datedIndices, seen)
  );
}

function iterableOrArgumentsDated(
  iterable: Expression,
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  const target = unwrapped(iterable);
  if (isWholeArgumentsReference(target, ctx.bindings)) return ctx.datedIndices.size > 0;
  return carriesDatedSubstitution(target, ctx.bindings, ctx.datedIndices, seen);
}

function elementAccessCarriesDated(
  access: Expression & { readonly expression: Expression; readonly argumentExpression: Expression },
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  return indexedSourceCarriesDated(access.expression, frameMemberName(access), ctx, seen);
}

function indexedSourceCarriesDated(
  source: Expression,
  rawKey: string | undefined,
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  const receiver = unwrapped(source);
  const slot = canonicalArrayTagIndex(rawKey);
  const { bindings, datedIndices } = ctx;
  const { restSubs } = bindings;
  if (restSubs !== undefined && isIdentifierForParam(receiver, restSubs.param)) {
    if (bindings.wildcardSubs) return datedIndices.size > 0;
    return slot === undefined
      ? hasDatedFromIndex(datedIndices, restSubs.startIndex)
      : datedIndices.has(restSubs.startIndex + slot);
  }
  if (isWholeArgumentsReference(receiver, bindings)) {
    if (bindings.wildcardSubs) return datedIndices.size > 0;
    const offset = bindings.paramOffset;
    return slot === undefined
      ? datedIndices.size > 0
      : slot >= offset && datedIndices.has(slot - offset);
  }
  if (
    slot !== undefined &&
    isArrayLiteralExpression(receiver) &&
    !hasSpreadBefore(receiver, slot)
  ) {
    const el = receiver.elements[slot];
    return (
      el !== undefined &&
      !isOmittedExpression(el) &&
      !isSpreadElement(el) &&
      carriesDatedSubstitution(el, bindings, datedIndices, seen)
    );
  }
  return carriesDatedSubstitution(receiver, bindings, datedIndices, seen);
}

function hasSpreadBefore(array: ArrayLiteralExpression, limit: number): boolean {
  for (let index = 0; index <= limit && index < array.elements.length; index += 1) {
    const item = array.elements[index];
    if (item !== undefined && isSpreadElement(item)) return true;
  }
  return false;
}

function callResultCarriesDated(
  call: CallExpression,
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  const callee = unwrapped(call.expression);
  const path = globalPathOf(callee)?.join('.');
  if (path === 'Array.from') return arrayFromCarriesDated(call, ctx, seen);
  if (path === 'Array.of' || path === 'Array') {
    return call.arguments.some((arg) => {
      return carriesDatedSubstitution(
        isSpreadElement(arg) ? arg.expression : arg,
        ctx.bindings,
        ctx.datedIndices,
        seen,
      );
    });
  }
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return false;
  const method = frameMemberName(callee);
  if (method === undefined) return false;
  if (
    method === 'call' &&
    globalPathOf(unwrapped(callee.expression))?.join('.') === 'Array.prototype.slice'
  ) {
    const [target, start, end] = call.arguments;
    return (
      target !== undefined &&
      !isSpreadElement(target) &&
      sliceCarriesDated(target, start, end, { ctx, seen })
    );
  }
  return arrayMethodResultCarriesDated(call, callee.expression, method, { ctx, seen });
}

function arrayFromCarriesDated(
  call: CallExpression,
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  const [iterable, mapFn] = call.arguments;
  if (iterable === undefined || isSpreadElement(iterable)) return false;
  if (mapFn === undefined) return iterableOrArgumentsDated(iterable, ctx, seen);
  const fn = unwrapped(mapFn);
  return (
    (isArrowFunction(fn) || isFunctionExpression(fn)) &&
    returnedBy(fn).some((ret) =>
      carriesDatedSubstitution(ret, ctx.bindings, ctx.datedIndices, seen),
    )
  );
}

function arrayMethodResultCarriesDated(
  call: CallExpression,
  receiver: Expression,
  method: string,
  walk: { readonly ctx: DatedCarrierContext; readonly seen: Set<Node> },
): boolean {
  const { ctx, seen } = walk;
  if (method === 'slice')
    return sliceCarriesDated(receiver, call.arguments[0], call.arguments[1], { ctx, seen });
  if (method === 'at') {
    const key = call.arguments[0] === undefined ? undefined : constantValue(call.arguments[0]);
    const rawKey = typeof key === 'number' && key >= 0 ? String(key) : undefined;
    return indexedSourceCarriesDated(receiver, rawKey, ctx, seen);
  }
  if (method === 'concat') return arrayConcatCarriesDated(call, receiver, ctx, seen);
  if (method === 'map' || method === 'flatMap') {
    const first = call.arguments[0];
    const fn = first === undefined ? undefined : unwrapped(first);
    return (
      fn !== undefined &&
      (isArrowFunction(fn) || isFunctionExpression(fn)) &&
      returnedBy(fn).some((ret) =>
        carriesDatedSubstitution(ret, ctx.bindings, ctx.datedIndices, seen),
      )
    );
  }
  return (
    PASSTHROUGH_ARRAY_METHODS.has(method) &&
    carriesDatedSubstitution(receiver, ctx.bindings, ctx.datedIndices, seen)
  );
}

function arrayConcatCarriesDated(
  call: CallExpression,
  receiver: Expression,
  ctx: DatedCarrierContext,
  seen: Set<Node>,
): boolean {
  const recv = unwrapped(receiver);
  if (carriesDatedSubstitution(recv, ctx.bindings, ctx.datedIndices, seen)) return true;
  if (!isArrayLiteralExpression(recv)) return false;
  return call.arguments.some((arg) => {
    return carriesDatedSubstitution(
      isSpreadElement(arg) ? arg.expression : arg,
      ctx.bindings,
      ctx.datedIndices,
      seen,
    );
  });
}

function sliceCarriesDated(
  target: Expression,
  startArg: Expression | undefined,
  endArg: Expression | undefined,
  walk: { readonly ctx: DatedCarrierContext; readonly seen: Set<Node> },
): boolean {
  const { ctx, seen } = walk;
  const recv = unwrapped(target);
  const start = nonNegativeIntConstant(startArg) ?? 0;
  const end = nonNegativeIntConstant(endArg);
  if (isWholeArgumentsReference(recv, ctx.bindings)) {
    return rangeHasDated(
      ctx.datedIndices,
      start - ctx.bindings.paramOffset,
      end === undefined ? undefined : end - ctx.bindings.paramOffset,
    );
  }
  if (
    ctx.bindings.restSubs !== undefined &&
    isIdentifierForParam(recv, ctx.bindings.restSubs.param)
  ) {
    const base = ctx.bindings.restSubs.startIndex;
    return rangeHasDated(
      ctx.datedIndices,
      base + start,
      end === undefined ? undefined : base + end,
    );
  }
  return carriesDatedSubstitution(recv, ctx.bindings, ctx.datedIndices, seen);
}

function nonNegativeIntConstant(arg: Expression | undefined): number | undefined {
  if (arg === undefined || isSpreadElement(arg)) return undefined;
  const val = constantValue(arg);
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 ? val : undefined;
}

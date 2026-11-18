import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isNewExpression,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTypeOfExpression,
  type Node,
  SyntaxKind,
  type TemplateExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { computedBindingContainer, framedMemberNames } from './framed-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { LOCAL_METHODS } from './local-reads.ts';
import { constantValue } from './numbers.ts';
import {
  isIdentifierForParam,
  isWholeArgumentsReference,
  type RawWrapperQuery,
  type WrapperBindings,
} from './render-raw-wrapper-bindings.ts';
import {
  anyCallArgCarriesDated,
  argElementsSlotCarriesDated,
  type CallArgumentList,
  callArgSlotCarriesDated,
  carriesDatedExpr,
  collectCallArgDatedSlots,
  unpackCallExpression,
  type UnwrappedCall,
} from './render-tag-date-calls.ts';

/** Detects native text coercions and local-time Date reads inside custom template tag bodies. */

const STRING_ONLY_LOCALE_METHODS: ReadonlySet<string> = new Set([
  'localeCompare',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
]);
const STRINGS: ReadonlySet<string> = new Set(['String']);
const RAW_TAGS: ReadonlySet<string> = new Set(['String.raw']);
const SAFE_GLOBAL_CALLS: ReadonlySet<string> = new Set([
  'Array',
  'Array.from',
  'Array.isArray',
  'Array.of',
  'Boolean',
  'Date',
  'Date.UTC',
  'isFinite',
  'isNaN',
  'JSON.stringify',
  'Number',
  'Number.isFinite',
  'Number.isNaN',
  'Object.is',
  'Object.prototype.toString',
  'String.fromCharCode',
  'String.fromCodePoint',
]);
const ELEMENT_MAPPER_METHODS: ReadonlySet<string> = new Set([
  'every',
  'filter',
  'find',
  'findLast',
  'flatMap',
  'forEach',
  'map',
  'some',
]);
const REDUCE_MAPPER_METHODS: ReadonlySet<string> = new Set(['reduce', 'reduceRight']);

export interface WrapperCoerceContext {
  readonly bindings: WrapperBindings;
  readonly query: RawWrapperQuery;
  readonly nextSeen: ReadonlySet<string>;
  readonly callSiteMaxSubs: (callSiteExpr: Expression) => number;
}

export function isCoercingDateMethodName(name: string): boolean {
  return name === 'toString' || (LOCAL_METHODS.has(name) && !STRING_ONLY_LOCALE_METHODS.has(name));
}

export function isOuterTemplateConsumedAsText(template: TemplateExpression): boolean {
  if (!isTaggedTemplateExpression(template.parent) || template.parent.template !== template) {
    return false;
  }
  const { at, parent } = useOf(template.parent);
  if (isBinaryExpression(parent)) {
    return (
      parent.operatorToken.kind === SyntaxKind.PlusToken ||
      parent.operatorToken.kind === SyntaxKind.PlusEqualsToken
    );
  }
  if (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) {
    return parent.expression === at && frameMemberName(parent) === 'toString';
  }
  if (isCallExpression(parent) || isNewExpression(parent)) {
    return (
      framedNativeConstructor(parent.expression, STRINGS) &&
      parent.arguments?.[0] !== undefined &&
      unwrapped(parent.arguments[0]) === at
    );
  }
  return parent.kind === SyntaxKind.TemplateSpan;
}

export function nodeCoercesDatedSubstitution(node: Node, context: WrapperCoerceContext): boolean {
  if (isTemplateExpression(node)) return untaggedTemplateCoerces(node, context);
  if (isBinaryExpression(node)) return binaryAdditionCoerces(node, context);
  if (isNewExpression(node)) return constructedStringCoerces(node, context);
  if (isBindingElement(node)) return patternDestructureCoerces(node, context);
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    return memberReadCoerces(node, context);
  }
  return isCallExpression(node) && callExpressionCoerces(node, context);
}

function untaggedTemplateCoerces(node: TemplateExpression, context: WrapperCoerceContext): boolean {
  if (isTaggedTemplateExpression(node.parent) && node.parent.template === node) return false;
  return node.templateSpans.some((span) => carriesDatedExpr(span.expression, context));
}

function binaryAdditionCoerces(
  node: Expression & {
    readonly left: Expression;
    readonly right: Expression;
    readonly operatorToken: { readonly kind: SyntaxKind };
  },
  context: WrapperCoerceContext,
): boolean {
  const kind = node.operatorToken.kind;
  if (kind !== SyntaxKind.PlusToken && kind !== SyntaxKind.PlusEqualsToken) return false;
  return carriesDatedExpr(node.left, context) || carriesDatedExpr(node.right, context);
}

function constructedStringCoerces(
  node: Expression & {
    readonly expression: Expression;
    readonly arguments?: readonly Expression[];
  },
  context: WrapperCoerceContext,
): boolean {
  const args = node.arguments ?? [];
  if (args.length === 0 || !argElementsSlotCarriesDated(args, 0, context)) return false;
  return context.query.maySelectTag(node.expression, {
    datedIndices: new Set([0]),
    env: context.query.env,
    paramOffset: 0,
    seenWrappers: context.nextSeen,
    spanCount: 1,
  });
}

function patternDestructureCoerces(
  node: Node & { readonly parent: Node; readonly dotDotDotToken?: Node | undefined },
  context: WrapperCoerceContext,
): boolean {
  if (!isBindingElement(node) || !isObjectBindingPattern(node.parent)) return false;
  if (node.dotDotDotToken !== undefined) return false;
  const selected = computedBindingContainer(node);
  if (selected?.binding.initializer === undefined || selected.keys.length > 0) return false;
  if (!carriesDatedExpr(selected.binding.initializer, context)) return false;
  const names = framedMemberNames(node);
  return names === undefined || names.some((name) => isCoercingDateMethodName(name));
}

function memberReadCoerces(
  node: Expression & { readonly expression: Expression },
  context: WrapperCoerceContext,
): boolean {
  if (isBenignMemberSite(node) || !carriesDatedExpr(node.expression, context)) return false;
  const names = framedMemberNames(node);
  if (names !== undefined) {
    return names.some((name) => isCoercingDateMethodName(name));
  }
  const { at, parent } = useOf(node);
  if (!isCallExpression(parent) || parent.expression !== at) return false;
  if (isElementAccessExpression(node) && isSymbolToPrimitive(node.argumentExpression)) {
    const [hint] = parent.arguments;
    return hint === undefined || constantValue(hint) !== 'number';
  }
  const recv = unwrapped(node.expression);
  if (isWholeArgumentsReference(recv, context.bindings)) return false;
  return (
    context.bindings.restSubs === undefined ||
    !isIdentifierForParam(recv, context.bindings.restSubs.param)
  );
}

function isSymbolToPrimitive(expr: Expression): boolean {
  return globalPathOf(unwrapped(expr))?.join('.') === 'Symbol.toPrimitive';
}

function isBenignMemberSite(node: Expression): boolean {
  const { at, parent } = useOf(unwrapped(node));
  if (isDeleteExpression(parent) || isTypeOfExpression(parent)) return true;
  return (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === at
  );
}

function callExpressionCoerces(call: CallExpression, context: WrapperCoerceContext): boolean {
  const unpacked = unpackCallExpression(call, context.bindings);
  if (unpacked === undefined) return false;
  if (nativeMethodOrCallbackCoerces(unpacked, context)) return true;
  return helperCallCoerces(unpacked, context);
}

function nativeMethodOrCallbackCoerces(
  unpacked: UnwrappedCall,
  context: WrapperCoerceContext,
): boolean {
  const target = unwrapped(unpacked.target);
  const path = globalPathOf(target)?.join('.');
  if (path !== undefined && borrowedGlobalCoerces(path, unpacked, context)) return true;
  if (path === 'Array.from') return arrayFromCallbackCoerces(unpacked.args, context);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) return false;
  const method = frameMemberName(target);
  if (method === undefined) return false;
  return memberMethodCallCoerces(method, unpacked, context);
}

function borrowedGlobalCoerces(
  path: string,
  unpacked: UnwrappedCall,
  context: WrapperCoerceContext,
): boolean {
  const recvDated = unpacked.receiver !== undefined && carriesDatedExpr(unpacked.receiver, context);
  if (path === 'Array.prototype.join') {
    return recvDated || callArgSlotCarriesDated(unpacked.args, 0, context);
  }
  if (
    path === 'Array.prototype.toString' ||
    path === 'Array.prototype.toLocaleString' ||
    path === 'Object.prototype.toLocaleString'
  ) {
    return recvDated;
  }
  if (path.startsWith('Date.prototype.')) {
    const method = path.slice('Date.prototype.'.length);
    return recvDated && isCoercingDateMethodName(method);
  }
  if (path.startsWith('String.prototype.')) {
    const method = path.slice('String.prototype.'.length);
    return stringMethodCoerces(method, unpacked, context, true);
  }
  return false;
}

function memberMethodCallCoerces(
  method: string,
  unpacked: UnwrappedCall,
  context: WrapperCoerceContext,
): boolean {
  const recv = unpacked.receiver;
  const recvDated = recv !== undefined && carriesDatedExpr(recv, context);
  if (method === 'join') {
    return recvDated || callArgSlotCarriesDated(unpacked.args, 0, context);
  }
  if (recvDated && (ELEMENT_MAPPER_METHODS.has(method) || REDUCE_MAPPER_METHODS.has(method))) {
    return arrayMapperCallbackCoerces(method, unpacked.args, context);
  }
  return stringMethodCoerces(method, unpacked, context, false);
}

function stringMethodCoerces(
  method: string,
  unpacked: UnwrappedCall,
  context: WrapperCoerceContext,
  borrowedStringProto: boolean,
): boolean {
  const recv = unpacked.receiver;
  const recvDated = recv !== undefined && carriesDatedExpr(recv, context);
  if (method === 'concat') {
    if (
      !borrowedStringProto &&
      recv !== undefined &&
      (recvDated || isArrayLiteralExpression(unwrapped(recv)))
    ) {
      return false;
    }
    return recvDated || anyCallArgCarriesDated(unpacked.args, context);
  }
  if (method === 'padStart' || method === 'padEnd') {
    return recvDated || callArgSlotCarriesDated(unpacked.args, 1, context);
  }
  if (method === 'replace' || method === 'replaceAll') {
    return (
      recvDated ||
      callArgSlotCarriesDated(unpacked.args, 0, context) ||
      callArgSlotCarriesDated(unpacked.args, 1, context)
    );
  }
  return false;
}

function arrayFromCallbackCoerces(args: CallArgumentList, context: WrapperCoerceContext): boolean {
  if (args.kind !== 'elements') return false;
  const [iterable, mapFn] = args.elements;
  if (
    iterable === undefined ||
    mapFn === undefined ||
    isSpreadElement(iterable) ||
    isSpreadElement(mapFn)
  ) {
    return false;
  }
  const iterTarget = unwrapped(iterable);
  const iterDated =
    (isWholeArgumentsReference(iterTarget, context.bindings) &&
      context.query.datedIndices.size > 0) ||
    carriesDatedExpr(iterTarget, context);
  return iterDated && externalCallbackCoerces(mapFn, new Set([0]), 1, context);
}

function arrayMapperCallbackCoerces(
  method: string,
  args: CallArgumentList,
  context: WrapperCoerceContext,
): boolean {
  if (args.kind !== 'elements') return false;
  const [callback, initial] = args.elements;
  if (callback === undefined || isSpreadElement(callback)) return false;
  if (REDUCE_MAPPER_METHODS.has(method)) {
    const slots = new Set(initial === undefined ? [0, 1] : [1]);
    return externalCallbackCoerces(callback, slots, 2, context);
  }
  return externalCallbackCoerces(callback, new Set([0]), 1, context);
}

function externalCallbackCoerces(
  callback: Expression,
  datedIndices: ReadonlySet<number>,
  spanCount: number,
  context: WrapperCoerceContext,
): boolean {
  const actual = unwrapped(callback);
  if (isArrowFunction(actual) || isFunctionExpression(actual)) return false;
  return context.query.maySelectTag(actual, {
    datedIndices,
    env: context.query.env,
    paramOffset: 0,
    seenWrappers: context.nextSeen,
    spanCount,
  });
}

function helperCallCoerces(unpacked: UnwrappedCall, context: WrapperCoerceContext): boolean {
  const target = unwrapped(unpacked.target);
  if (isSkippedHelperTarget(target, unpacked.receiver, context)) return false;
  if (unpacked.args.kind === 'whole-arguments') {
    if (context.query.datedIndices.size === 0) return false;
    const shifted = shiftIndices(context.query.datedIndices, context.bindings.paramOffset);
    return context.query.maySelectTag(target, {
      datedIndices: shifted,
      env: context.query.env,
      paramOffset: 0,
      seenWrappers: context.nextSeen,
      spanCount: context.query.spanCount + context.bindings.paramOffset,
    });
  }
  const forwarded = collectCallArgDatedSlots(unpacked.args, context);
  if (forwarded.forwardedSlots.size === 0) return false;
  const firstArg = unpacked.args.kind === 'elements' ? unpacked.args.elements[0] : undefined;
  const maxSubs =
    firstArg === undefined || isSpreadElement(firstArg)
      ? Infinity
      : context.callSiteMaxSubs(firstArg);
  return context.query.maySelectTag(target, {
    datedIndices: forwarded.forwardedSlots,
    env: context.query.env,
    maxTemplateSubs: Number.isFinite(maxSubs) ? maxSubs : undefined,
    paramOffset: 0,
    seenWrappers: context.nextSeen,
    spanCount: forwarded.effectiveSpanCount,
  });
}

function shiftIndices(indices: ReadonlySet<number>, delta: number): ReadonlySet<number> {
  const out = new Set<number>();
  for (const idx of indices) out.add(idx + delta);
  return out;
}

function isSkippedHelperTarget(
  target: Expression,
  receiver: Expression | undefined,
  context: WrapperCoerceContext,
): boolean {
  if (framedNativeConstructor(target, RAW_TAGS)) return true;
  const path = globalPathOf(target)?.join('.');
  if (path !== undefined) {
    if (path === 'String.raw' || SAFE_GLOBAL_CALLS.has(path)) return true;
    if (path.startsWith('Math.') || path.startsWith('Date.prototype.')) return true;
  }
  return receiver !== undefined && carriesDatedExpr(receiver, context);
}

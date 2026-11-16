import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAwaitExpression,
  isBinaryExpression,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isJsxSpreadAttribute,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTemplateSpan,
  isTypeOfExpression,
  isVoidExpression,
  type JsxAttributeLike,
  type JsxElement,
  type JsxSelfClosingElement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf } from './bounded.ts';
import { unwrapped } from './page-shape.ts';
import { literalKey, memberAccess, type Scope, type Source, uncast } from './page-values.ts';
import { freeReads } from './scope.ts';
import { isTakenApart, useOf } from './uses.ts';

/**
 * Checks uses of whole `props` and destructured route parameters in a page or helper function:
 * whole `props` must be read by static names or spread into an inner helper, and any route
 * parameter (or alias) that may be mutated or handed off is tainted (`page-render.ts`).
 */

const ASSIGNING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.SlashEqualsToken,
]);

const PRIMITIVE_BINARY: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AsteriskAsteriskToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.MinusToken,
  SyntaxKind.PercentToken,
  SyntaxKind.PlusToken,
  SyntaxKind.SlashToken,
]);

const EQUALITY_BINARY: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

const FORWARDING_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

const READONLY_PARAM_METHODS: ReadonlySet<string> = new Set([
  'at',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'concat',
  'endsWith',
  'flat',
  'includes',
  'indexOf',
  'join',
  'lastIndexOf',
  'localeCompare',
  'normalize',
  'padEnd',
  'padStart',
  'repeat',
  'replace',
  'replaceAll',
  'search',
  'slice',
  'split',
  'startsWith',
  'substring',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleUpperCase',
  'toLowerCase',
  'toReversed',
  'toSorted',
  'toSpliced',
  'toString',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
  'with',
]);

const CALLBACK_PARAM_METHODS: ReadonlySet<string> = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'some',
]);

const SAFE_GLOBAL_FUNCTIONS: ReadonlySet<string> = new Set([
  'Boolean',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'isFinite',
  'isNaN',
  'Number',
  'parseFloat',
  'parseInt',
  'String',
]);

const SAFE_GLOBAL_METHODS: ReadonlySet<string> = new Set([
  'Array.isArray',
  'Number.isFinite',
  'Number.isNaN',
  'Number.parseFloat',
  'Number.parseInt',
]);

export interface JsxSites {
  readonly free: ReadonlySet<Identifier>;
  readonly innerSites: ReadonlySet<Node>;
  readonly isSafeAttrElement: (element: JsxElement | JsxSelfClosingElement) => boolean;
  readonly isTransparent: (element: JsxElement) => boolean;
  readonly rootSites: ReadonlySet<Node>;
  readonly rootSpreadObjects: ReadonlySet<Node>;
}

export interface ParamState {
  readonly paramHolders: Map<string, ReadonlySet<string>>;
  readonly scope: Scope;
  searched: boolean;
  taintedAll: boolean;
  readonly taintedParams: Set<string>;
  readonly unawaitedProps: Set<string>;
}

export interface AllowedUses {
  readonly allowedDynamicPropRead?: Node | undefined;
  readonly allowedParamsAwait?: Node | undefined;
  readonly allowedParamsSource?: Node | undefined;
  readonly boundName?: string | undefined;
  readonly forwarded?: ReadonlySet<Identifier> | undefined;
}

interface UseContext {
  readonly allowed: AllowedUses;
  readonly jsx: JsxSites;
  readonly state: ParamState;
}

/** The JSX element that owns `attribute`. */
function elementOfAttribute(
  attribute: JsxAttributeLike,
): JsxElement | JsxSelfClosingElement | undefined {
  const holder = attribute.parent.parent;
  if (isJsxSelfClosingElement(holder)) return holder;
  return isJsxOpeningElement(holder) && isJsxElement(holder.parent) ? holder.parent : undefined;
}

/** Whether `target` stands where an assignment, count, `delete`, loop or pattern writes into it. */
function isWrittenTarget(target: Node): boolean {
  const { at, parent } = useOf(target);
  if (isBinaryExpression(parent) && ASSIGNING.has(parent.operatorToken.kind)) {
    return parent.left === at;
  }
  if (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if (isDeleteExpression(parent)) return true;
  if ((isForOfStatement(parent) || isForInStatement(parent)) && parent.initializer === at) {
    return true;
  }
  const inPattern =
    isArrayLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === at);
  return inPattern && isTakenApart(parent);
}

/** Whether `argument` is an arrow callback that cannot observe the 3rd (`array`) parameter. */
function isSafeArrowCallback(argument: Expression | undefined): boolean {
  if (argument === undefined) return false;
  const fn = uncast(argument);
  return (
    isArrowFunction(fn) &&
    fn.parameters.length <= 2 &&
    fn.parameters.every((parameter) => parameter.dotDotDotToken === undefined)
  );
}

/** The static method name a property or literal-bracket access names on its receiver. */
function staticMemberOf(access: Node): string | undefined {
  if (isPropertyAccessExpression(access) && isIdentifier(access.name)) {
    return access.name.text;
  }
  return isElementAccessExpression(access) ? literalKey(access.argumentExpression) : undefined;
}

/** Whether a property or element access on a route-param value neither mutates nor hands it off. */
function isSafeMemberOnParam(access: Node): boolean {
  if (isWrittenTarget(access)) return false;
  const { at, parent } = useOf(access);
  if (isTaggedTemplateExpression(parent) && parent.tag === at) return false;
  if (!isCallExpression(parent) || parent.expression !== at) return true;
  const method = staticMemberOf(access);
  if (method === undefined) return false;
  if (READONLY_PARAM_METHODS.has(method)) return true;
  return (
    CALLBACK_PARAM_METHODS.has(method) &&
    parent.arguments.length === 1 &&
    isSafeArrowCallback(parent.arguments[0])
  );
}

/** Whether `callee` names an unshadowed pure global function or static method (`String`, `Array.isArray`). */
function isSafeGlobalCallee(callee: Expression, free: ReadonlySet<Identifier>): boolean {
  const inner = uncast(callee);
  if (isIdentifier(inner)) {
    return (
      free.has(inner) && globalOf(inner) !== undefined && SAFE_GLOBAL_FUNCTIONS.has(inner.text)
    );
  }
  const access = memberAccess(inner);
  return (
    access !== undefined &&
    free.has(access.holder) &&
    globalOf(access.holder) !== undefined &&
    SAFE_GLOBAL_METHODS.has(`${access.holder.text}.${access.property}`)
  );
}

/** Whether `at` inside `parent` hands a param to `<Root>`, an intrinsic/Suspense attribute, or transparent JSX. */
function isSafeJsxParamUse(at: Node, parent: Node, jsx: JsxSites): boolean {
  const spreadField =
    isShorthandPropertyAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === at);
  if (spreadField && isObjectLiteralExpression(parent.parent)) {
    return jsx.rootSpreadObjects.has(parent.parent);
  }
  if (!isJsxExpression(parent) || !Object.is(parent.expression, at)) {
    return false;
  }
  if (isJsxAttribute(parent.parent)) {
    const element = elementOfAttribute(parent.parent);
    return element !== undefined && (jsx.rootSites.has(element) || jsx.isSafeAttrElement(element));
  }
  return (
    isJsxFragment(parent.parent) ||
    (isJsxElement(parent.parent) && jsx.isTransparent(parent.parent))
  );
}

/** Whether `at` inside `parent` coerces a param to a primitive without mutating or returning it. */
function isPrimitiveParamCoercion(at: Node, parent: Node): boolean {
  if (isTemplateSpan(parent) && parent.expression === at && isTemplateExpression(parent.parent)) {
    return !isTaggedTemplateExpression(parent.parent.parent);
  }
  if (
    (isComputedPropertyName(parent) && parent.expression === at) ||
    (isConditionalExpression(parent) && parent.condition === at) ||
    (isElementAccessExpression(parent) && parent.argumentExpression === at) ||
    isTypeOfExpression(parent) ||
    isVoidExpression(parent)
  ) {
    return true;
  }
  if (isPrefixUnaryExpression(parent)) {
    return (
      parent.operator !== SyntaxKind.PlusPlusToken && parent.operator !== SyntaxKind.MinusMinusToken
    );
  }
  return isBinaryExpression(parent) && PRIMITIVE_BINARY.has(parent.operatorToken.kind);
}

/** Climbs past parentheses, casts and value-forwarding branches (`?:`, `||`, `&&`, `??`, `,`) around `node`. */
function forwardedUseOf(node: Node): { readonly at: Node; readonly parent: Node } | undefined {
  let current = useOf(node);
  for (;;) {
    const { at, parent } = current;
    const forwards =
      (isConditionalExpression(parent) && parent.condition !== at) ||
      (isBinaryExpression(parent) && FORWARDING_OPERATORS.has(parent.operatorToken.kind));
    if (forwards) {
      current = useOf(parent);
    } else if (isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.CommaToken) {
      if (parent.left === at) return undefined;
      current = useOf(parent);
    } else {
      return current;
    }
  }
}

/** Whether `node`, holding a route parameter's value, is read without mutating or handing it off. */
function isSafeParamNode(node: Node, jsx: JsxSites): boolean {
  const step = forwardedUseOf(node);
  if (step === undefined) return true;
  const { at, parent } = step;
  if (isSafeJsxParamUse(at, parent, jsx) || isPrimitiveParamCoercion(at, parent)) {
    return true;
  }
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === at
  ) {
    return isSafeMemberOnParam(parent);
  }
  return (
    isCallExpression(parent) &&
    parent.expression !== at &&
    parent.arguments.some((argument) => Object.is(argument, at)) &&
    isSafeGlobalCallee(parent.expression, jsx.free)
  );
}

/** Whether `node`, holding an unawaited dynamic prop of `props`, is coerced without awaiting or calling it. */
function isSafeUnawaitedPropNode(node: Node, free: ReadonlySet<Identifier>): boolean {
  const { at, parent } = useOf(node);
  if (isTypeOfExpression(parent) || isVoidExpression(parent)) return true;
  if (isPrefixUnaryExpression(parent)) {
    return parent.operator === SyntaxKind.ExclamationToken;
  }
  if (isBinaryExpression(parent)) {
    return EQUALITY_BINARY.has(parent.operatorToken.kind);
  }
  if (
    !isCallExpression(parent) ||
    parent.expression === at ||
    !parent.arguments.some((argument) => Object.is(argument, at))
  ) {
    return false;
  }
  const callee = uncast(parent.expression);
  return (
    isIdentifier(callee) &&
    free.has(callee) &&
    globalOf(callee) !== undefined &&
    (callee.text === 'Boolean' || callee.text === 'String')
  );
}

/** Checks an `await params` expression (`const { … } = await params` or `(await params).slug`). */
function checkAwaitedParamsUse(awaitedNode: Node, context: UseContext): void {
  const { at, parent } = useOf(awaitedNode);
  if (at === context.allowed.allowedParamsAwait) return;
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    parent.expression !== at
  ) {
    context.state.taintedAll = true;
    return;
  }
  if (isSafeParamNode(parent, context.jsx)) return;
  const key = staticMemberOf(parent);
  if (key === undefined) {
    context.state.taintedAll = true;
  } else {
    context.state.taintedParams.add(key);
  }
}

/** Whether `sourceNode` is `<Inner params={params} />` on an inner helper element. */
function isInnerParamsAttribute(sourceNode: Node, innerSites: ReadonlySet<Node>): boolean {
  if (!isIdentifier(sourceNode) || !isJsxExpression(sourceNode.parent)) return false;
  if (!isJsxAttribute(sourceNode.parent.parent)) return false;
  const element = elementOfAttribute(sourceNode.parent.parent);
  return element !== undefined && innerSites.has(element);
}

/** Checks a use of `params` (or `props.params`), tainting affected route params when mutated or handed off. */
function checkParamsSourceNode(sourceNode: Node, context: UseContext): void {
  const { at, parent } = useOf(sourceNode);
  if (
    at === context.allowed.allowedParamsSource ||
    isInnerParamsAttribute(sourceNode, context.jsx.innerSites)
  ) {
    return;
  }
  if (isAwaitExpression(parent) && parent.expression === at) {
    checkAwaitedParamsUse(parent, context);
  } else {
    context.state.taintedAll = true;
  }
}

/** Checks a dynamic bracket read `props[key]` that neither awaits nor hands off the Promise. */
function checkDynamicWholePropsRead(accessNode: Node, context: UseContext): boolean {
  if (!isElementAccessExpression(accessNode)) return false;
  if (accessNode !== context.allowed.allowedDynamicPropRead) {
    return isSafeUnawaitedPropNode(accessNode, context.jsx.free);
  }
  if (context.allowed.boundName !== undefined) {
    context.state.unawaitedProps.add(context.allowed.boundName);
  }
  return true;
}

/** Checks one read of whole `props`; returns `false` when an opaque or dynamic read could hide `searchParams`. */
function checkWholePropsRead(
  identifier: Identifier,
  handed: ReadonlyMap<string, Source> | undefined,
  context: UseContext,
): boolean {
  const { at, parent } = useOf(identifier);
  if (isJsxSpreadAttribute(parent) && unwrapped(parent.expression) === identifier) {
    const element = elementOfAttribute(parent);
    return element !== undefined && context.jsx.innerSites.has(element);
  }
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    parent.expression !== at ||
    isWrittenTarget(parent)
  ) {
    return false;
  }
  const access = memberAccess(parent);
  if (access === undefined) {
    return checkDynamicWholePropsRead(parent, context);
  }
  const source = handed?.get(access.property);
  if (source === undefined) return false;
  if (source === 'searchParams') {
    context.state.searched = true;
  } else {
    checkParamsSourceNode(parent, context);
  }
  return true;
}

/** Checks one free identifier read inside `checkExpressionUses`. */
function checkIdentifierUse(identifier: Identifier, context: UseContext): boolean {
  const { allowed, jsx, state } = context;
  if (state.unawaitedProps.has(identifier.text)) {
    return isSafeUnawaitedPropNode(identifier, jsx.free);
  }
  const held = state.scope.locals.get(identifier.text);
  if (held?.kind === 'source' && held.source === 'props') {
    return checkWholePropsRead(identifier, held.handed, context);
  }
  if (held?.kind === 'source' && held.source === 'params') {
    checkParamsSourceNode(identifier, context);
    return true;
  }
  const params = state.paramHolders.get(identifier.text);
  if (params === undefined || allowed.forwarded?.has(identifier) === true) {
    return true;
  }
  if (!isSafeParamNode(identifier, jsx)) {
    for (const param of params) state.taintedParams.add(param);
  }
  return true;
}

/** Scans free reads in `node` for whole-`props` accesses and route-parameter mutations or handoffs. */
export function checkExpressionUses(
  node: Node,
  state: ParamState,
  jsx: JsxSites,
  allowed: AllowedUses = {},
): boolean {
  const context: UseContext = { allowed, jsx, state };
  return freeReads(node).every((identifier) => checkIdentifierUse(identifier, context));
}

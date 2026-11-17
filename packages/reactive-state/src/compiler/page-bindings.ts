import {
  type BindingElement,
  type BindingName,
  type Expression,
  type FunctionDeclaration,
  isAwaitExpression,
  isBindingElement,
  isComputedPropertyName,
  isDecorator,
  isElementAccessExpression,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxSpreadAttribute,
  isMethodDeclaration,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isVariableStatement,
  type JsxAttributeLike,
  type JsxElement,
  type JsxSelfClosingElement,
  type Node,
  type ObjectBindingPattern,
  type SourceFile,
  type Statement,
} from 'typescript/ast';

import {
  type AllowedUses,
  checkExpressionUses,
  type JsxSites,
  type ParamState,
} from './page-params.ts';
import {
  collectForwardedAliases,
  type Held,
  memberAccess,
  namesRead,
  OTHER,
  type Scope,
  SEARCH,
  type Source,
  uncast,
  valueOf,
} from './page-values.ts';
import { bindingIdentifiers, isTypeOnly } from './scope.ts';
import { isConstant } from './statements.ts';

/**
 * How a function of a page reads its parameter, binds the `const` declarations before its `return`,
 * and records every `await` it runs before returning its JSX (`page-render.ts`).
 */

/** What a function of the page reads its props in, and what it awaits or taints of them. */
export interface Reading extends ParamState {
  awaits: boolean;
  readonly destructured: string[];
}

/**
 * The prop of the page's that `props.params`, `props['searchParams']` reads of props whole: the one
 * handed under that name (`Held.handed`) — none where the receiver is not props whole or the key is dynamic.
 */
function propertySource(target: Expression, scope: Scope): Source | undefined {
  const access = memberAccess(target);
  if (access === undefined) {
    return undefined;
  }
  const whole = scope.locals.get(access.holder.text);
  return whole?.kind === 'source' && whole.source === 'props'
    ? whole.handed?.get(access.property)
    : undefined;
}

/** The prop of the page's an expression directly names without awaiting: `params`, `props['searchParams']`. */
function directSource(expression: Expression, scope: Scope): Source | undefined {
  const target = uncast(expression);
  if (isIdentifier(target)) {
    const held = scope.locals.get(target.text);
    return held?.kind === 'source' && held.source !== 'props' ? held.source : undefined;
  }
  const optional =
    (isPropertyAccessExpression(target) || isElementAccessExpression(target)) &&
    target.questionDotToken !== undefined;
  return optional ? undefined : propertySource(target, scope);
}

/** The prop of the page's an expression awaits: `await params`, `await props['searchParams']`. */
function awaitedSource(expression: Expression, scope: Scope): Source | undefined {
  const value = uncast(expression);
  if (!isAwaitExpression(value)) {
    return undefined;
  }
  const target = uncast(value.expression);
  if (!isIdentifier(target)) {
    return propertySource(target, scope);
  }
  const held = scope.locals.get(target.text);
  return held?.kind === 'source' && held.source !== 'props' ? held.source : undefined;
}

/** Computed key expression of a method, accessor or class field, evaluated with its container. */
function computedMemberName(node: Node): readonly Node[] {
  const named =
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isPropertyDeclaration(node);
  return named && isComputedPropertyName(node.name) ? [node.name.expression] : [];
}

/** Parts of a function or class field that run when its enclosing expression runs, not when called. */
function eagerPartsOfDeferred(node: Node): readonly Node[] | undefined {
  if (isFunctionLikeDeclaration(node) || isPropertyDeclaration(node)) {
    const decorators = (node.modifiers ?? []).filter((modifier) => isDecorator(modifier));
    return [...decorators, ...computedMemberName(node)];
  }
  return undefined;
}

/** Records in `reading` every `await` that `node` runs before the enclosing function returns. */
export function scanAwaits(node: Node, reading: Reading): void {
  const pending: Node[] = [node];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (isTypeOnly(each)) {
      continue;
    }
    if (isAwaitExpression(each)) {
      reading.awaits = true;
      if (awaitedSource(each, reading.scope) === 'searchParams') {
        reading.searched = true;
      }
    }
    const eager = eagerPartsOfDeferred(each);
    if (eager === undefined) {
      each.forEachChild((child) => {
        pending.push(child);
      });
    } else {
      pending.push(...eager);
    }
  }
}

/** `{ a, b: c } = await params`: each local name, with the param it is; none for another pattern. */
function paramsOf(pattern: ObjectBindingPattern): ReadonlyMap<string, string> | undefined {
  const params = new Map<string, string>();
  for (const element of pattern.elements) {
    const key = element.propertyName ?? element.name;
    const { name } = element;
    if (
      key === undefined ||
      name === undefined ||
      element.dotDotDotToken !== undefined ||
      element.initializer !== undefined ||
      !isIdentifier(name) ||
      !isIdentifier(key)
    ) {
      return undefined;
    }
    params.set(name.text, key.text);
  }
  return params;
}

interface ElementStep {
  readonly element: BindingElement;
  readonly kind: 'element';
  readonly rest: { tainted: boolean };
  readonly tainted: boolean;
}

interface PatternStep {
  readonly kind: 'pattern';
  readonly pattern: BindingName;
  readonly tainted: boolean;
}

type SearchStep = ElementStep | PatternStep;

interface SearchWalk {
  readonly pending: SearchStep[];
  readonly scope: Scope;
  readonly uninitialized: Set<string>;
}

/** Whether `expression` reads nothing still uninitialized, and computes only of search params or constants. */
function isSearchValue(expression: Expression, walk: SearchWalk): boolean {
  if (namesRead(expression).some((identifier) => walk.uninitialized.has(identifier.text))) {
    return false;
  }
  const held = valueOf(expression, walk.scope);
  return held.kind === 'constant' || held.kind === 'search';
}

/** Binds an identifier or queues the elements of a destructuring pattern in left-to-right order. */
function stepPattern(step: PatternStep, walk: SearchWalk): void {
  const { pattern, tainted } = step;
  if (isIdentifier(pattern)) {
    walk.uninitialized.delete(pattern.text);
    walk.scope.locals.set(pattern.text, tainted ? OTHER : SEARCH);
    return;
  }
  const rest = { tainted };
  const elements = isObjectBindingPattern(pattern)
    ? pattern.elements
    : pattern.elements.filter((element) => isBindingElement(element));
  for (const element of elements.toReversed()) {
    walk.pending.push({ element, kind: 'element', rest, tainted });
  }
}

/** Evaluates one destructuring element's computed key and default before queuing its target binding. */
function stepElement(step: ElementStep, walk: SearchWalk): void {
  const { element, rest, tainted } = step;
  const { name } = element;
  if (name === undefined) {
    return;
  }
  if (element.dotDotDotToken !== undefined) {
    walk.pending.push({ kind: 'pattern', pattern: name, tainted: rest.tainted });
    return;
  }
  const badKey =
    element.propertyName !== undefined &&
    isComputedPropertyName(element.propertyName) &&
    !isSearchValue(element.propertyName.expression, walk);
  if (badKey) {
    rest.tainted = true;
  }
  const badDefault = element.initializer !== undefined && !isSearchValue(element.initializer, walk);
  walk.pending.push({
    kind: 'pattern',
    pattern: name,
    tainted: tainted || badKey || badDefault,
  });
}

/** Binds what `name = await searchParams` declares, tainting bindings whose keys or defaults read more. */
function bindSearch(name: Node, scope: Scope): boolean {
  if (!isIdentifier(name) && !isObjectBindingPattern(name)) {
    return false;
  }
  const identifiers = bindingIdentifiers(name);
  if (identifiers.length === 0) {
    return false;
  }
  const walk: SearchWalk = {
    pending: [{ kind: 'pattern', pattern: name, tainted: false }],
    scope,
    uninitialized: new Set(identifiers.map((identifier) => identifier.text)),
  };
  for (let step = walk.pending.pop(); step !== undefined; step = walk.pending.pop()) {
    if (step.kind === 'pattern') {
      stepPattern(step, walk);
    } else {
      stepElement(step, walk);
    }
  }
  return true;
}

/** Binds `const { … } = await params`, recording each destructured route parameter and holder. */
function bindParams(name: Node, reading: Reading): boolean {
  const params = isObjectBindingPattern(name) ? paramsOf(name) : undefined;
  if (params === undefined || params.size === 0) {
    return false;
  }
  for (const [local, param] of params) {
    reading.scope.locals.set(local, { kind: 'param', param });
    reading.paramHolders.set(local, new Set([param]));
    reading.destructured.push(param);
  }
  return true;
}

/** Deferred expression-use check for one `const` declaration after all bindings are collected. */
export interface BoundCheck {
  readonly initializer: Expression;
  readonly initializerAllowed: AllowedUses;
  readonly name: Node;
  readonly nameAllowed: AllowedUses;
}

/** Whether `name` redeclares an identifier already bound in `locals` or within `name` itself. */
function hasDuplicateBinding(name: BindingName, locals: ReadonlyMap<string, Held>): boolean {
  const seen = new Set<string>();
  for (const identifier of bindingIdentifiers(name)) {
    if (locals.has(identifier.text) || seen.has(identifier.text)) {
      return true;
    }
    seen.add(identifier.text);
  }
  return false;
}

/** Whether `expression` is a dynamic bracket read `props[key]` on whole `props`. */
function isDynamicWholePropsRead(expression: Expression, scope: Scope): boolean {
  const inner = uncast(expression);
  if (!isElementAccessExpression(inner) || memberAccess(inner) !== undefined) {
    return false;
  }
  const holder = uncast(inner.expression);
  if (!isIdentifier(holder)) {
    return false;
  }
  const held = scope.locals.get(holder.text);
  return held?.kind === 'source' && held.source === 'props';
}

/** Binds a single-identifier `const` declaration from a direct page source or computed value. */
function bindIdentifierValue(
  name: Node,
  initializer: Expression,
  direct: Source | undefined,
  reading: Reading,
): boolean {
  if (!isIdentifier(name)) {
    return false;
  }
  if (direct !== undefined) {
    reading.scope.locals.set(name.text, { kind: 'source', source: direct });
    if (direct === 'searchParams') {
      reading.searched = true;
    }
    return true;
  }
  reading.scope.locals.set(name.text, valueOf(initializer, reading.scope));
  return true;
}

/** Holds what one declaration of a `const` declares, queuing its use checks for after binding. */
function bindDeclaration(
  declaration: { readonly name: BindingName; readonly initializer?: Expression | undefined },
  reading: Reading,
  checks: BoundCheck[],
): boolean {
  const { initializer, name } = declaration;
  if (initializer === undefined || hasDuplicateBinding(name, reading.scope.locals)) {
    return false;
  }
  scanAwaits(name, reading);
  scanAwaits(initializer, reading);
  const source = awaitedSource(initializer, reading.scope);
  const direct =
    source === undefined && isIdentifier(name)
      ? directSource(initializer, reading.scope)
      : undefined;
  const dynamicPropRead = isIdentifier(name) && isDynamicWholePropsRead(initializer, reading.scope);
  if (dynamicPropRead) {
    reading.unawaitedProps.add(name.text);
  }
  const forwarded = collectForwardedAliases(name, initializer, source, reading.paramHolders);
  for (const [alias, params] of forwarded.bindings) {
    reading.paramHolders.set(alias, params);
  }
  checks.push({
    initializer,
    initializerAllowed: {
      allowedDynamicPropRead: dynamicPropRead ? initializer : undefined,
      allowedParamsAwait: source === 'params' ? initializer : undefined,
      allowedParamsSource: direct === 'params' ? initializer : undefined,
      forwarded: forwarded.leaves,
    },
    name,
    nameAllowed: { forwarded: forwarded.leaves },
  });
  if (source === 'params') {
    return bindParams(name, reading);
  }
  if (source === 'searchParams') {
    return bindSearch(name, reading.scope);
  }
  return bindIdentifierValue(name, initializer, direct, reading);
}

/** Holds what a statement before a function's `return` declares; whether it is a `const` read. */
export function bindStatement(
  statement: Statement,
  reading: Reading,
  sourceFile: SourceFile,
  checks: BoundCheck[],
): boolean {
  return (
    isVariableStatement(statement) &&
    isConstant(statement, sourceFile) &&
    statement.declarationList.declarations.every((declaration) =>
      bindDeclaration(declaration, reading, checks),
    )
  );
}

/** Checks whole-`props` accesses and route-param mutations across all bound `const` declarations. */
export function checkBoundDeclarations(
  checks: readonly BoundCheck[],
  reading: Reading,
  jsx: JsxSites,
): boolean {
  return checks.every((check) => {
    return (
      checkExpressionUses(check.initializer, reading, jsx, check.initializerAllowed) &&
      checkExpressionUses(check.name, reading, jsx, check.nameAllowed)
    );
  });
}

/** Whether one of `sources` is the page's search params, destructured. */
export function holdsSearchParams(sources: ReadonlyMap<string, Held>): boolean {
  for (const held of sources.values()) {
    if (held.kind === 'source' && held.source === 'searchParams') {
      return true;
    }
  }
  return false;
}

/** What an attribute hands a function of the page's: its value, or what it spreads. */
function handed(attribute: JsxAttributeLike): Expression | undefined {
  if (isJsxSpreadAttribute(attribute)) {
    return uncast(attribute.expression);
  }
  const { initializer } = attribute;
  return initializer !== undefined &&
    isJsxExpression(initializer) &&
    initializer.expression !== undefined
    ? uncast(initializer.expression)
    : undefined;
}

/** Holds in `given` what props whole hand on as they are spread: each prop they were handed. */
function handOn(given: Map<string, Source>, whole: ReadonlyMap<string, Source> | undefined): void {
  if (whole === undefined) {
    return;
  }
  for (const [name, source] of whole) {
    given.set(name, source);
  }
}

/** The page's props an element hands a function of the page's, by the names it hands them under. */
export function givenTo(
  element: JsxElement | JsxSelfClosingElement,
  page: Scope,
): ReadonlyMap<string, Source> | undefined {
  const given = new Map<string, Source>();
  const attributes = isJsxElement(element) ? element.openingElement.attributes : element.attributes;
  for (const attribute of attributes.properties) {
    const value = handed(attribute);
    const held =
      value !== undefined && isIdentifier(value) ? page.locals.get(value.text) : undefined;
    if (held?.kind !== 'source') {
      return undefined;
    }
    if (isJsxSpreadAttribute(attribute) && held.source === 'props') {
      handOn(given, held.handed);
    } else if (
      isJsxAttribute(attribute) &&
      isIdentifier(attribute.name) &&
      held.source !== 'props'
    ) {
      given.set(attribute.name.text, held.source);
    } else {
      return undefined;
    }
  }
  return given;
}

/**
 * What the names an object parameter destructures hold of the props it is `given`: each, the prop
 * of the page's it was given under its name; none where an element is a rest, has a default or
 * destructures further.
 */
function patternSources(
  pattern: ObjectBindingPattern,
  given: ReadonlyMap<string, Source>,
): ReadonlyMap<string, Held> | undefined {
  const sources = new Map<string, Held>();
  for (const element of pattern.elements) {
    const key = element.propertyName ?? element.name;
    const source = key !== undefined && isIdentifier(key) ? given.get(key.text) : undefined;
    const { name } = element;
    if (
      source === undefined ||
      name === undefined ||
      element.dotDotDotToken !== undefined ||
      element.initializer !== undefined ||
      !isIdentifier(name)
    ) {
      return undefined;
    }
    sources.set(name.text, { kind: 'source', source });
  }
  return sources;
}

/**
 * What the names a function's one parameter holds of the props it is `given`: each destructured,
 * the prop of the page's it was given under its name; or the props whole, with what each of them
 * is (`Held.handed`).
 */
export function parameterSources(
  fn: FunctionDeclaration,
  given: ReadonlyMap<string, Source>,
): ReadonlyMap<string, Held> | undefined {
  const [parameter, ...more] = fn.parameters;
  if (more.length > 0) {
    return undefined;
  }
  if (parameter === undefined) {
    return new Map();
  }
  if (parameter.dotDotDotToken !== undefined || parameter.initializer !== undefined) {
    return undefined;
  }
  if (isIdentifier(parameter.name)) {
    return new Map([[parameter.name.text, { handed: given, kind: 'source', source: 'props' }]]);
  }
  return isObjectBindingPattern(parameter.name) ? patternSources(parameter.name, given) : undefined;
}

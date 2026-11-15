import {
  type BindingElement,
  type BindingName,
  type Expression,
  type FunctionDeclaration,
  isAsExpression,
  isAwaitExpression,
  isBindingElement,
  isComputedPropertyName,
  isDecorator,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxSpreadAttribute,
  isMethodDeclaration,
  isNonNullExpression,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isTypeAssertion,
  isVariableStatement,
  type JsxAttributeLike,
  type JsxElement,
  type JsxSelfClosingElement,
  type Node,
  type ObjectBindingPattern,
  type SourceFile,
  type Statement,
} from 'typescript/ast';

import { unwrapped } from './page-shape.ts';
import {
  type Held,
  namesRead,
  OTHER,
  type Scope,
  SEARCH,
  type Source,
  valueOf,
} from './page-values.ts';
import { bindingIdentifiers, isTypeOnly } from './scope.ts';
import { isConstant } from './statements.ts';

/**
 * How a function of a page reads its parameter, binds the `const` declarations before its `return`,
 * and records every `await` it runs before returning its JSX (`page-render.ts`).
 */

/** What a function of the page reads its props in, and what it awaits of them. */
export interface Reading {
  readonly scope: Scope;
  awaits: boolean;
  searched: boolean;
  readonly destructured: string[];
}

/** `expression` without the parentheses, type assertions or `!` around it. */
function uncast(expression: Expression): Expression {
  let inner = expression;
  while (
    isParenthesizedExpression(inner) ||
    isAsExpression(inner) ||
    isSatisfiesExpression(inner) ||
    isNonNullExpression(inner) ||
    isTypeAssertion(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/**
 * The prop of the page's that `props.params`, `props.searchParams` reads of props whole: the one
 * handed under that name (`Held.handed`) — the page's own of the page's — none of another name.
 */
function propertySource(target: Expression, scope: Scope): Source | undefined {
  if (!isPropertyAccessExpression(target)) {
    return undefined;
  }
  const holder = uncast(target.expression);
  if (!isIdentifier(holder)) {
    return undefined;
  }
  const whole = scope.locals.get(holder.text);
  const property = target.name.text;
  const read = property === 'params' || property === 'searchParams';
  return read && whole?.kind === 'source' && whole.source === 'props'
    ? whole.handed?.get(property)
    : undefined;
}

/** The prop of the page's an expression awaits: `await params`, `await props.searchParams`. */
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

/** Holds what one declaration of a `const` declares; whether it is of a shape read. */
function bindDeclaration(
  declaration: { readonly name: Node; readonly initializer?: Expression | undefined },
  reading: Reading,
): boolean {
  const { initializer, name } = declaration;
  if (initializer === undefined) {
    return false;
  }
  scanAwaits(name, reading);
  scanAwaits(initializer, reading);
  const { locals } = reading.scope;
  const source = awaitedSource(initializer, reading.scope);
  if (source === 'params') {
    const params = isObjectBindingPattern(name) ? paramsOf(name) : undefined;
    if (params === undefined || params.size === 0) {
      return false;
    }
    for (const [local, param] of params) {
      locals.set(local, { kind: 'param', param });
      reading.destructured.push(param);
    }
    return true;
  }
  if (source === 'searchParams') {
    return bindSearch(name, reading.scope);
  }
  if (!isIdentifier(name)) {
    return false;
  }
  locals.set(name.text, valueOf(initializer, reading.scope));
  return true;
}

/** Holds what a statement before a function's `return` declares; whether it is a `const` read. */
export function bindStatement(
  statement: Statement,
  reading: Reading,
  sourceFile: SourceFile,
): boolean {
  return (
    isVariableStatement(statement) &&
    isConstant(statement, sourceFile) &&
    statement.declarationList.declarations.every((declaration) =>
      bindDeclaration(declaration, reading),
    )
  );
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
    return unwrapped(attribute.expression);
  }
  const { initializer } = attribute;
  return initializer !== undefined && isJsxExpression(initializer)
    ? initializer.expression
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

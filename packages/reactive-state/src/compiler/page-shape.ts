import {
  type Block,
  type Expression,
  type FunctionDeclaration,
  type ImportDeclaration,
  isArrayLiteralExpression,
  isAsExpression,
  isAwaitExpression,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isInterfaceDeclaration,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxSelfClosingElement,
  isJsxText,
  isNamedExports,
  isNamespaceImport,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSatisfiesExpression,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
  type JsxAttributes,
  type JsxElement,
  type JsxSelfClosingElement,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { defaultImportNames } from './default-imports.ts';

/**
 * Whether a page of the application renders one reactive root of its route's params, and how: the
 * two shapes a page that resolves its params and hands them to a root is written in.
 *
 * - `export default async function Page({ params }) { const { projectId } = await params; return
 *   <Root projectId={projectId} />; }` — the page awaits its params itself, outside any
 *   `<Suspense>`: a blocking route.
 * - `export default function Page({ params }) { return <Suspense fallback={…}><Inner
 *   params={params} /></Suspense>; }` with, in the same file, `async function Inner({ params })`
 *   of the first shape's body — the params awaited within a `<Suspense>`.
 *
 * A param may be destructured under another name (`{ projectId: id }`). Anything else — the search
 * params, a prop the page computes, another element around the root — is no page of a root of its
 * params, and is left as it is: rendered for each request, as before.
 */

/** A page's root, as the page renders it. */
export interface PageShape {
  /** The specifier the page imports the root by. */
  readonly specifier: string;
  /** The root's element, where what is refused of the page stands. */
  readonly element: JsxElement | JsxSelfClosingElement;
  /** Each of the root's props, by the param it is given. */
  readonly props: Readonly<Record<string, string>>;
  /** The params the page destructures. */
  readonly destructured: readonly string[];
  /** Whether the page awaits its params outside any `<Suspense>`. */
  readonly blocking: boolean;
  /**
   * What the page runs beside rendering the root, which a document shared by every visitor would
   * hold without anything tracking it — `generateMetadata`, a computed constant: its name.
   */
  readonly beside: string | undefined;
}

/** The module `Suspense` is imported from. */
const REACT = 'react';

/** What a page file's top level declares: its default imports, `Suspense`'s names, its functions. */
export interface PageNames {
  /** Each default import, by its local name, with its specifier. */
  readonly defaults: ReadonlyMap<string, string>;
  /** The names `react`'s `Suspense` is read by: imported by name, or a namespace's or default's of it. */
  readonly suspense: ReadonlySet<string>;
  readonly reactNamespaces: ReadonlySet<string>;
  /** The functions the file declares at its top level, by name. */
  readonly functions: ReadonlyMap<string, FunctionDeclaration>;
}

/** What `PageNames` is while the file's top level is read. */
interface Reading {
  readonly defaults: Map<string, string>;
  readonly suspense: Set<string>;
  readonly reactNamespaces: Set<string>;
  readonly functions: Map<string, FunctionDeclaration>;
}

/** What an import of the page's declares of `PageNames`, read into `names`. */
function readImport(statement: ImportDeclaration, names: Reading): void {
  const clause = statement.importClause;
  if (
    clause === undefined ||
    clause.phaseModifier === SyntaxKind.TypeKeyword ||
    !isStringLiteral(statement.moduleSpecifier)
  ) {
    return;
  }
  const specifier = statement.moduleSpecifier.text;
  const react = specifier === REACT;
  for (const name of defaultImportNames(statement)) {
    names.defaults.set(name.text, specifier);
    if (react) {
      names.reactNamespaces.add(name.text);
    }
  }
  const named = clause.namedBindings;
  if (!react || named === undefined) {
    return;
  }
  if (isNamespaceImport(named)) {
    names.reactNamespaces.add(named.name.text);
    return;
  }
  for (const element of named.elements) {
    if (!element.isTypeOnly && (element.propertyName ?? element.name).text === 'Suspense') {
      names.suspense.add(element.name.text);
    }
  }
}

export function namesOf(sourceFile: SourceFile): PageNames {
  const names: Reading = {
    defaults: new Map(),
    functions: new Map(),
    reactNamespaces: new Set(),
    suspense: new Set(),
  };
  for (const statement of sourceFile.statements) {
    if (isFunctionDeclaration(statement) && statement.name !== undefined) {
      names.functions.set(statement.name.text, statement);
    } else if (isImportDeclaration(statement)) {
      readImport(statement, names);
    }
  }
  return names;
}

function hasModifier(node: FunctionDeclaration, kind: SyntaxKind): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

/** Whether a statement is the page's own function: `export default function`, with a body. */
export function isPageFunction(statement: Statement): statement is FunctionDeclaration {
  return (
    isFunctionDeclaration(statement) &&
    statement.body !== undefined &&
    hasModifier(statement, SyntaxKind.ExportKeyword) &&
    hasModifier(statement, SyntaxKind.DefaultKeyword)
  );
}

/** `expression` without the parentheses around it. */
export function unwrapped(expression: Expression): Expression {
  let inner = expression;
  while (isParenthesizedExpression(inner)) {
    inner = inner.expression;
  }
  return inner;
}

/**
 * The name `fn` holds the prop `property` of its one parameter by, where its parameter
 * destructures that prop alone, as written: `({ params })`, `({ params: routeParams })`.
 */
function propertyBinding(fn: FunctionDeclaration, property: string): string | undefined {
  const [parameter, ...more] = fn.parameters;
  if (parameter === undefined || more.length > 0 || !isObjectBindingPattern(parameter.name)) {
    return undefined;
  }
  const [element, ...others] = parameter.name.elements;
  if (
    element === undefined ||
    others.length > 0 ||
    element.dotDotDotToken !== undefined ||
    element.initializer !== undefined ||
    element.name === undefined ||
    !isIdentifier(element.name)
  ) {
    return undefined;
  }
  const key = element.propertyName ?? element.name;
  return isIdentifier(key) && key.text === property ? element.name.text : undefined;
}

/** `const { a, b: c } = await <params>`: each local name, with the param it holds. */
function awaitedParams(
  statement: Statement,
  params: string,
): ReadonlyMap<string, string> | undefined {
  if (!isVariableStatement(statement)) {
    return undefined;
  }
  const [declaration, ...more] = statement.declarationList.declarations;
  const initializer = declaration?.initializer;
  if (
    declaration === undefined ||
    initializer === undefined ||
    more.length > 0 ||
    !isObjectBindingPattern(declaration.name)
  ) {
    return undefined;
  }
  const awaited = unwrapped(initializer);
  if (!isAwaitExpression(awaited)) {
    return undefined;
  }
  const target = unwrapped(awaited.expression);
  if (!isIdentifier(target) || target.text !== params) {
    return undefined;
  }
  const locals = new Map<string, string>();
  for (const element of declaration.name.elements) {
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
    locals.set(name.text, key.text);
  }
  return locals;
}

/** The element `statement` returns: JSX of one element, or of one with nothing between its tags. */
function returnedElement(
  statement: Statement | undefined,
): JsxElement | JsxSelfClosingElement | undefined {
  if (
    statement === undefined ||
    !isReturnStatement(statement) ||
    statement.expression === undefined
  ) {
    return undefined;
  }
  const returned = unwrapped(statement.expression);
  return isJsxSelfClosingElement(returned) || isJsxElement(returned) ? returned : undefined;
}

/** Whether a child of JSX is white space, or a comment, alone. */
export function isBlank(child: Node): boolean {
  return (
    (isJsxText(child) && child.text.trim() === '') ||
    (isJsxExpression(child) && child.expression === undefined)
  );
}

function attributesOf(element: JsxElement | JsxSelfClosingElement): JsxAttributes {
  return isJsxElement(element) ? element.openingElement.attributes : element.attributes;
}

export function tagOf(element: JsxElement | JsxSelfClosingElement): Node {
  return isJsxElement(element) ? element.openingElement.tagName : element.tagName;
}

/** Each attribute of `attributes` as `name={identifier}`: the identifier read, by the name; else none. */
function identifierAttributes(attributes: JsxAttributes): ReadonlyMap<string, string> | undefined {
  const read = new Map<string, string>();
  for (const attribute of attributes.properties) {
    if (!isJsxAttribute(attribute) || !isIdentifier(attribute.name)) {
      return undefined;
    }
    const initializer = attribute.initializer;
    const expression =
      initializer !== undefined && isJsxExpression(initializer)
        ? initializer.expression
        : undefined;
    if (expression === undefined || !isIdentifier(expression) || read.has(attribute.name.text)) {
      return undefined;
    }
    read.set(attribute.name.text, expression.text);
  }
  return read;
}

type Rooted = Omit<PageShape, 'beside' | 'blocking'>;

/** A body of the first shape: its params awaited and destructured, then the root of them returned. */
function rootOfBody(body: Block, params: string, names: PageNames): Rooted | undefined {
  const [first, second, ...more] = body.statements;
  const locals = first === undefined ? undefined : awaitedParams(first, params);
  const element = returnedElement(second);
  if (locals === undefined || element === undefined || more.length > 0) {
    return undefined;
  }
  if (isJsxElement(element) && !element.children.every((child) => isBlank(child))) {
    return undefined;
  }
  const tag = tagOf(element);
  const specifier = isIdentifier(tag) ? names.defaults.get(tag.text) : undefined;
  const attributes = identifierAttributes(attributesOf(element));
  if (specifier === undefined || attributes === undefined) {
    return undefined;
  }
  const props: Record<string, string> = {};
  for (const [prop, local] of attributes) {
    const param = locals.get(local);
    if (param === undefined) {
      return undefined;
    }
    if (prop !== 'key') props[prop] = param;
  }
  return { destructured: [...locals.values()], element, props, specifier };
}

/** Whether a tag names `react`'s `Suspense`. */
export function isSuspense(tag: Node, names: PageNames): boolean {
  if (isIdentifier(tag)) {
    return names.suspense.has(tag.text);
  }
  return (
    isPropertyAccessExpression(tag) &&
    isIdentifier(tag.expression) &&
    names.reactNamespaces.has(tag.expression.text) &&
    tag.name.text === 'Suspense'
  );
}

/** Whether an attribute of a `<Suspense>` is its `fallback`. */
function isFallback(attribute: Node): boolean {
  return (
    isJsxAttribute(attribute) && isIdentifier(attribute.name) && attribute.name.text === 'fallback'
  );
}

/** The one element between a `<Suspense>`'s tags, the rest white space and comments. */
function onlyChild(element: JsxElement): JsxSelfClosingElement | undefined {
  const [child, ...more] = element.children.filter((each) => !isBlank(each));
  return child !== undefined && more.length === 0 && isJsxSelfClosingElement(child)
    ? child
    : undefined;
}

/** `return <Suspense fallback={…}><Inner name={params} /></Suspense>`: the function, and its prop. */
function suspended(
  body: Block,
  params: string,
  names: PageNames,
): { readonly fn: FunctionDeclaration; readonly property: string } | undefined {
  const [statement, ...more] = body.statements;
  const element = returnedElement(statement);
  if (element === undefined || more.length > 0 || !isJsxElement(element)) {
    return undefined;
  }
  const { attributes, tagName } = element.openingElement;
  const fallbackOnly = attributes.properties.every((attribute) => isFallback(attribute));
  const child = onlyChild(element);
  if (!fallbackOnly || child === undefined || !isSuspense(tagName, names)) {
    return undefined;
  }
  const read = identifierAttributes(child.attributes);
  const fn = isIdentifier(child.tagName) ? names.functions.get(child.tagName.text) : undefined;
  const [entry, ...others] = read === undefined ? [] : [...read];
  if (entry === undefined || fn === undefined || others.length > 0) {
    return undefined;
  }
  const [property, value] = entry;
  return value === params ? { fn, property } : undefined;
}

/** The types an exported constant's value may be said to be: `as const`, `satisfies Metadata`. */
function unasserted(expression: Expression): Expression {
  let value = unwrapped(expression);
  while (isAsExpression(value) || isSatisfiesExpression(value)) {
    value = unwrapped(value.expression);
  }
  return value;
}

/** Whether a property of an object literal is a literal of a name written as it is. */
function isLiteralProperty(property: Node): boolean {
  return (
    isPropertyAssignment(property) &&
    property.name.kind !== SyntaxKind.ComputedPropertyName &&
    isLiteral(property.initializer)
  );
}

/** The literals a page's configuration is written of, beside its objects and its lists. */
const LITERAL_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TrueKeyword,
]);

/** Whether an exported constant's value is a literal: a page's configuration, no code that runs. */
export function isLiteral(expression: Expression): boolean {
  const value = unasserted(expression);
  if (isObjectLiteralExpression(value)) {
    return value.properties.every((property) => isLiteralProperty(property));
  }
  if (isArrayLiteralExpression(value)) {
    return value.elements.every((element) => isLiteral(element));
  }
  if (isPrefixUnaryExpression(value)) {
    return value.operator === SyntaxKind.MinusToken && isNumericLiteral(value.operand);
  }
  return LITERAL_KINDS.has(value.kind);
}

/** Whether an export declares only types, with no value beside the page's root. */
function exportsTypes(statement: Statement): boolean {
  if (!isExportDeclaration(statement)) {
    return false;
  }
  const clause = statement.exportClause;
  return (
    statement.isTypeOnly ||
    (clause !== undefined &&
      isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly))
  );
}

/** What of a statement of the page's top level runs beside the root: its name; none for what does not. */
function besideIn(
  statement: Statement,
  own: ReadonlySet<Node>,
  sourceFile: SourceFile,
): string | undefined {
  if (
    own.has(statement) ||
    isImportDeclaration(statement) ||
    isTypeAliasDeclaration(statement) ||
    isInterfaceDeclaration(statement) ||
    exportsTypes(statement)
  ) {
    return undefined;
  }
  if (isFunctionDeclaration(statement)) {
    return statement.name?.text ?? 'a function';
  }
  if (isVariableStatement(statement)) {
    const declarations = statement.declarationList.declarations;
    const computed = declarations.find(
      (declaration) => declaration.initializer === undefined || !isLiteral(declaration.initializer),
    );
    return computed?.name.getText(sourceFile);
  }
  return statement.getText(sourceFile).split('\n', 1)[0]?.trim() ?? '';
}

/**
 * The root `sourceFile`, a page, renders of its route's params, and how; none where it is written
 * in no shape of a page of a root of its params.
 */
export function pageShapeOf(sourceFile: SourceFile): PageShape | undefined {
  const names = namesOf(sourceFile);
  const page = sourceFile.statements.find((statement) => isPageFunction(statement));
  const params = page === undefined ? undefined : propertyBinding(page, 'params');
  if (params === undefined || page?.body === undefined) {
    return undefined;
  }
  const own = new Set<Node>([page]);
  const besideOf = (): string | undefined => {
    for (const statement of sourceFile.statements) {
      const found = besideIn(statement, own, sourceFile);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  const direct = rootOfBody(page.body, params, names);
  if (direct !== undefined) {
    return hasModifier(page, SyntaxKind.AsyncKeyword)
      ? { ...direct, beside: besideOf(), blocking: true }
      : undefined;
  }
  const inner = suspended(page.body, params, names);
  const innerParams = inner === undefined ? undefined : propertyBinding(inner.fn, inner.property);
  if (innerParams === undefined || inner?.fn.body === undefined) {
    return undefined;
  }
  const nested = rootOfBody(inner.fn.body, innerParams, names);
  if (nested === undefined || !hasModifier(inner.fn, SyntaxKind.AsyncKeyword)) {
    return undefined;
  }
  own.add(inner.fn);
  return { ...nested, beside: besideOf(), blocking: false };
}

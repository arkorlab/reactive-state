import {
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isAwaitExpression,
  isConditionalExpression,
  isIdentifier,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxSelfClosingElement,
  isJsxSpreadAttribute,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableStatement,
  type JsxAttributeLike,
  type JsxElement,
  type JsxSelfClosingElement,
  type Node,
  type ObjectBindingPattern,
  type SourceFile,
  type Statement,
} from 'typescript/ast';

import { unshadowedReads } from './code-globals.ts';
import {
  isBlank,
  isPageFunction,
  isSuspense,
  namesOf,
  type PageNames,
  tagOf,
  unwrapped,
} from './page-shape.ts';
import {
  elementProps,
  type ElementProps,
  type Held,
  moduleNamesOf,
  propsOfAll,
  type Scope,
  SEARCH,
  type Source,
  valueOf,
} from './page-values.ts';
import { bindingIdentifiers, declaredWithin } from './scope.ts';
import { isConstant } from './statements.ts';

/**
 * A page that renders one reactive root of more than its route's params — its search params, the
 * values it computes of them alone, constants — read as it is written: the root, and each of its
 * props the page gives a param of the route as it is, in every element of the root it renders. Such
 * a route is the request's, never shared, and is registered all the same, so that its root's entry
 * names it: the route's guards are run wherever the root renders, of the params those props give.
 * The page may hand its props to a function of its own file (`<Inner {...props} />`, within a
 * `<Suspense>`) and render the root there, in more than one element of it
 * (`cond ? <Root a={a} b={b} /> : <Root a={a} />`, or a conditional spread of props) — on every path
 * it renders. A prop of anything else — a value computed of a param, what a module answers — is no
 * page of a root the compile can map to its route, and is left as it is: unregistered; and so is a
 * page that renders the root on some paths alone, whose request may render none — a root under
 * `&&`, `||` or `??`, in a branch of a `?:` the other of which renders none, in a callback, in what
 * an element is handed as a prop, or past an early `return`, the statements before a function's
 * `return` being its constants alone.
 */

/** A page of one reactive root, as this reading finds it. */
export interface PageRender {
  /** The specifier the page imports the root by. */
  readonly specifier: string;
  /** Each element of the root the page renders. */
  readonly elements: readonly (JsxElement | JsxSelfClosingElement)[];
  /** Each prop the root is given a param of the route as it is, in every element: by the param. */
  readonly props: Readonly<Record<string, string>>;
  /** The root's other props: of the search params, or constants. */
  readonly given: readonly string[];
  /** The params the page destructures. */
  readonly destructured: readonly string[];
  /** Whether it awaits its params, or its search params, outside any `<Suspense>`. */
  readonly blocking: boolean;
  /** Whether it reads its search params. */
  readonly searched: boolean;
}

/**
 * The prop of the page's that `props.params`, `props.searchParams` reads of props whole: the one
 * handed under that name (`Held.handed`) — the page's own of the page's — none of another name.
 */
function propertySource(target: Expression, scope: Scope): Source | undefined {
  if (!isPropertyAccessExpression(target) || !isIdentifier(target.expression)) {
    return undefined;
  }
  const whole = scope.locals.get(target.expression.text);
  const property = target.name.text;
  const read = property === 'params' || property === 'searchParams';
  return read && whole?.kind === 'source' && whole.source === 'props'
    ? whole.handed?.get(property)
    : undefined;
}

/** The prop of the page's an expression awaits: `await params`, `await props.searchParams`. */
function awaitedSource(expression: Expression, scope: Scope): Source | undefined {
  const value = unwrapped(expression);
  if (!isAwaitExpression(value)) {
    return undefined;
  }
  const target = unwrapped(value.expression);
  if (!isIdentifier(target)) {
    return propertySource(target, scope);
  }
  const held = scope.locals.get(target.text);
  return held?.kind === 'source' && held.source !== 'props' ? held.source : undefined;
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

/** What a function of the page reads its props in, and what it awaits of them. */
interface Reading {
  readonly scope: Scope;
  awaits: boolean;
  searched: boolean;
  readonly destructured: string[];
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
  const { locals } = reading.scope;
  const source = awaitedSource(initializer, reading.scope);
  reading.awaits ||= source !== undefined;
  if (source === 'params') {
    const params = isObjectBindingPattern(name) ? paramsOf(name) : undefined;
    if (params === undefined) {
      return false;
    }
    for (const [local, param] of params) {
      locals.set(local, { kind: 'param', param });
      reading.destructured.push(param);
    }
    return true;
  }
  if (source === 'searchParams') {
    reading.searched = true;
    const names =
      isIdentifier(name) || isObjectBindingPattern(name) ? bindingIdentifiers(name) : [];
    for (const identifier of names) {
      locals.set(identifier.text, SEARCH);
    }
    return names.length > 0;
  }
  if (!isIdentifier(name)) {
    return false;
  }
  locals.set(name.text, valueOf(initializer, reading.scope));
  return true;
}

/** Holds what a statement before a function's `return` declares; whether it is a `const` read. */
function bindStatement(statement: Statement, reading: Reading, sourceFile: SourceFile): boolean {
  return (
    isVariableStatement(statement) &&
    isConstant(statement, sourceFile) &&
    statement.declarationList.declarations.every((declaration) =>
      bindDeclaration(declaration, reading),
    )
  );
}

/** An element of the root, or of a function of the page's, as the page renders it. */
interface Site {
  readonly element: JsxElement | JsxSelfClosingElement;
  /** Whether a `<Suspense>` stands around it. */
  readonly suspended: boolean;
}

interface Sites {
  readonly roots: Site[];
  readonly inners: (Site & { readonly fn: FunctionDeclaration })[];
  /** Whether an element of either holds more than white space between its tags. */
  refused: boolean;
}

/** What tells a root's element, and an element of a function of the page's, from the rest. */
interface Tags {
  readonly names: PageNames;
  /** The reads in the file's code that no scope around them declares again (`unshadowedReads`). */
  readonly free: ReadonlySet<Identifier>;
  /** Whether a specifier names a reactive root the compile compiled. */
  readonly isRoot: (specifier: string) => boolean;
  readonly page: FunctionDeclaration;
}

/** Whether an element holds nothing but white space, and comments, between its tags. */
function isEmpty(element: JsxElement | JsxSelfClosingElement): boolean {
  return !isJsxElement(element) || element.children.every((child) => isBlank(child));
}

/** Whether `element` is `react`'s `Suspense`, with no scope around it declaring the name again. */
function isSuspenseElement(element: JsxElement | JsxSelfClosingElement, tags: Tags): boolean {
  const tag = tagOf(element);
  const root = isPropertyAccessExpression(tag) ? tag.expression : tag;
  return isIdentifier(root) && tags.free.has(root) && isSuspense(tag, tags.names);
}

/** Whether `element` is the root's: of a default import of a reactive root the compile compiled. */
function isRootElement(element: JsxElement | JsxSelfClosingElement, tags: Tags): boolean {
  const tag = tagOf(element);
  const specifier =
    isIdentifier(tag) && tags.free.has(tag) ? tags.names.defaults.get(tag.text) : undefined;
  return specifier !== undefined && tags.isRoot(specifier);
}

/** The function of the page's, but the page itself, `element` is of, where it is none of the root's. */
function innerOf(
  element: JsxElement | JsxSelfClosingElement,
  tags: Tags,
): FunctionDeclaration | undefined {
  const tag = tagOf(element);
  const fn =
    isIdentifier(tag) && tags.free.has(tag) && !isRootElement(element, tags)
      ? tags.names.functions.get(tag.text)
      : undefined;
  return fn === tags.page ? undefined : fn;
}

/** Whether `node` is an element of the root's, or of a function's of the page's. */
function isSite(node: Node, tags: Tags): boolean {
  return (
    (isJsxElement(node) || isJsxSelfClosingElement(node)) &&
    (isRootElement(node, tags) || innerOf(node, tags) !== undefined)
  );
}

/** Records `site`, where it is an element of the root's or of a function's of the page's; whether it is. */
function recordSite(site: Site, sites: Sites, tags: Tags): boolean {
  const fn = innerOf(site.element, tags);
  if (isRootElement(site.element, tags)) {
    sites.roots.push(site);
  } else if (fn === undefined) {
    return false;
  } else {
    sites.inners.push({ ...site, fn });
  }
  sites.refused ||= !isEmpty(site.element);
  return true;
}

/** Each element of the root, and of a function of the page's, `node` renders. */
function sitesIn(node: Node, tags: Tags): Sites {
  const sites: Sites = { inners: [], refused: false, roots: [] };
  const pending: [Node, boolean][] = [[node, false]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [each, suspended] = next;
    const element = isJsxElement(each) || isJsxSelfClosingElement(each) ? each : undefined;
    if (element === undefined || !recordSite({ element, suspended }, sites, tags)) {
      const within = suspended || (element !== undefined && isSuspenseElement(element, tags));
      each.forEachChild((child) => {
        pending.push([child, within]);
      });
    }
  }
  return sites;
}

/** What `node`, JSX a function of the page's renders, renders of its own: its children, or `{…}`'s. */
function childrenRendered(node: Node): readonly Node[] {
  if (isJsxElement(node) || isJsxFragment(node)) {
    return node.children;
  }
  return isJsxExpression(node) && node.expression !== undefined ? [unwrapped(node.expression)] : [];
}

/**
 * Whether `node`, where a function of the page's renders it, renders the root whatever path it
 * takes: the root's element; a function's of the page's whose `return` does, one deep — none
 * `nested` in one; an element, a fragment or `{…}` one of whose children does; or a `?:` both of
 * whose branches do.
 */
function rendersRoot(node: Node, tags: Tags, nested: boolean): boolean {
  const element = isJsxElement(node) || isJsxSelfClosingElement(node) ? node : undefined;
  if (element !== undefined && isRootElement(element, tags)) {
    return true;
  }
  const fn = element === undefined ? undefined : innerOf(element, tags);
  if (fn !== undefined) {
    return !nested && returnsRoot(fn, tags);
  }
  if (isConditionalExpression(node)) {
    return (
      rendersRoot(unwrapped(node.whenTrue), tags, nested) &&
      rendersRoot(unwrapped(node.whenFalse), tags, nested)
    );
  }
  return childrenRendered(node).some((child) => rendersRoot(child, tags, nested));
}

/** Whether `fn`, a function of the page's, returns what renders the root whatever path it takes. */
function returnsRoot(fn: FunctionDeclaration, tags: Tags): boolean {
  const returned = fn.body?.statements.at(-1);
  return (
    returned !== undefined &&
    isReturnStatement(returned) &&
    returned.expression !== undefined &&
    rendersRoot(unwrapped(returned.expression), tags, true)
  );
}

/**
 * What `node` renders whenever it is rendered: its children (`childrenRendered`), or both branches
 * of a `?:` both of which render the root (`rendersRoot`); none of another `?:`.
 */
function renderedWhenever(node: Node, tags: Tags): readonly Node[] {
  if (!isConditionalExpression(node)) {
    return childrenRendered(node);
  }
  return rendersRoot(node, tags, false)
    ? [unwrapped(node.whenTrue), unwrapped(node.whenFalse)]
    : [];
}

/**
 * Collects into `placed` each element of the root's, or of a function's of the page's, that `node`
 * renders whatever path it takes: one an element, a fragment or `{…}` holds, or a branch of a `?:`
 * both of whose branches render the root (`renderedWhenever`) — none under `&&`, `||` or `??`, in a
 * branch of another `?:`, in a callback, or in what an element is handed as a prop.
 */
function placedIn(node: Node, tags: Tags, placed: Set<Node>): void {
  if (isSite(node, tags)) {
    placed.add(node);
    return;
  }
  for (const child of renderedWhenever(node, tags)) {
    placedIn(child, tags, placed);
  }
}

/**
 * Whether each element of the root's, and of a function's of the page's, that `returned` renders
 * (`sites`) stands where it renders whatever path the function takes (`placedIn`): a root the page
 * renders on some paths alone — `{ready && <Root … />}`, `ready ? <Root … /> : null` — is none every
 * request of its route renders.
 */
function isPlaced(returned: Expression, sites: Sites, tags: Tags): boolean {
  const placed = new Set<Node>();
  placedIn(unwrapped(returned), tags, placed);
  return placed.size === sites.roots.length + sites.inners.length;
}

/** What a function of the page renders: the elements, and what its names hold as it renders them. */
interface Rendered {
  readonly sites: Sites;
  readonly reading: Reading;
}

interface RenderContext {
  readonly tags: Tags;
  readonly sourceFile: SourceFile;
  readonly module: Scope['module'];
}

/** Whether one of `sources` is the page's search params, destructured. */
function holdsSearchParams(sources: ReadonlyMap<string, Held>): boolean {
  for (const held of sources.values()) {
    if (held.kind === 'source' && held.source === 'searchParams') {
      return true;
    }
  }
  return false;
}

/** What `fn`, a function of the page given `sources`, renders; none where it is written otherwise. */
function renderedBy(
  fn: FunctionDeclaration,
  sources: ReadonlyMap<string, Held>,
  context: RenderContext,
): Rendered | undefined {
  const statements = fn.body?.statements ?? [];
  const returned = statements.at(-1);
  if (returned === undefined || !isReturnStatement(returned) || returned.expression === undefined) {
    return undefined;
  }
  const locals = new Map(sources);
  const reading: Reading = {
    awaits: false,
    destructured: [],
    scope: { declared: declaredWithin(fn), locals, module: context.module },
    searched: holdsSearchParams(sources),
  };
  const before = statements.slice(0, -1);
  for (const statement of before) {
    const rendering = sitesIn(statement, context.tags);
    const renders = rendering.roots.length > 0 || rendering.inners.length > 0;
    if (renders || !bindStatement(statement, reading, context.sourceFile)) {
      return undefined;
    }
  }
  const sites = sitesIn(returned.expression, context.tags);
  return sites.refused || !isPlaced(returned.expression, sites, context.tags)
    ? undefined
    : { reading, sites };
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
function givenTo(
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
 * What the names a function's one parameter holds of the props it is `given`: each destructured,
 * the prop of the page's it was given under its name; or the props whole, with what each of them
 * is (`Held.handed`).
 */
function parameterSources(
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
  if (isIdentifier(parameter.name)) {
    return new Map([[parameter.name.text, { handed: given, kind: 'source', source: 'props' }]]);
  }
  if (!isObjectBindingPattern(parameter.name)) {
    return undefined;
  }
  const sources = new Map<string, Held>();
  for (const element of parameter.name.elements) {
    const key = element.propertyName ?? element.name;
    const source = key !== undefined && isIdentifier(key) ? given.get(key.text) : undefined;
    const { name } = element;
    if (
      source === undefined ||
      name === undefined ||
      element.initializer !== undefined ||
      !isIdentifier(name)
    ) {
      return undefined;
    }
    sources.set(name.text, { kind: 'source', source });
  }
  return sources;
}

/** The page's own props: `params` and `searchParams`, as Next.js gives a page them. */
const PAGE_PROPS: ReadonlyMap<string, Source> = new Map([
  ['params', 'params'],
  ['searchParams', 'searchParams'],
]);

interface Render {
  readonly rendered: Rendered;
  readonly suspended: boolean;
}

/** The specifier each element of the roots is imported by. */
function specifiersOf(
  roots: readonly { readonly site: Site }[],
  names: PageNames,
): ReadonlySet<string | undefined> {
  return new Set(
    roots.map(({ site }) => {
      const tag = tagOf(site.element);
      return isIdentifier(tag) ? names.defaults.get(tag.text) : undefined;
    }),
  );
}

/** The page's root and its props, of what the page and the functions it renders render. */
function renderOf(renders: readonly Render[], names: PageNames): PageRender | undefined {
  const roots = renders.flatMap(({ rendered }) =>
    rendered.sites.roots.map((site) => ({ scope: rendered.reading.scope, site })),
  );
  const [specifier, ...others] = specifiersOf(roots, names);
  const each: ElementProps[] = [];
  for (const { scope, site } of roots) {
    const props = elementProps(site.element, scope);
    if (props === undefined) {
      return undefined;
    }
    each.push(props);
  }
  if (specifier === undefined || others.length > 0) {
    return undefined;
  }
  const { given, props } = propsOfAll(each);
  return {
    blocking: renders.some(({ rendered, suspended }) => rendered.reading.awaits && !suspended),
    destructured: renders.flatMap(({ rendered }) => rendered.reading.destructured),
    elements: roots.map(({ site }) => site.element),
    given,
    props,
    searched: renders.some(({ rendered }) => rendered.reading.searched),
    specifier,
  };
}

/**
 * The root `sourceFile`, a page, renders, and its props, where it renders one reactive root of its
 * params, its search params and constants; none where it is written otherwise.
 */
export function pageRenderOf(
  sourceFile: SourceFile,
  isRoot: (specifier: string) => boolean,
): PageRender | undefined {
  const page = sourceFile.statements.find((statement) => isPageFunction(statement));
  const sources = page === undefined ? undefined : parameterSources(page, PAGE_PROPS);
  if (page === undefined || sources === undefined) {
    return undefined;
  }
  const names = namesOf(sourceFile);
  const context: RenderContext = {
    module: moduleNamesOf(sourceFile),
    sourceFile,
    tags: { free: unshadowedReads(sourceFile), isRoot, names, page },
  };
  const rendered = renderedBy(page, sources, context);
  if (rendered === undefined) {
    return undefined;
  }
  const renders: Render[] = [{ rendered, suspended: false }];
  for (const inner of rendered.sites.inners) {
    const given = givenTo(inner.element, rendered.reading.scope);
    const sourcesOf = given === undefined ? undefined : parameterSources(inner.fn, given);
    const within = sourcesOf === undefined ? undefined : renderedBy(inner.fn, sourcesOf, context);
    // One function of the page's deep: the one it renders renders the root, and no function of its own.
    if (within === undefined || within.sites.inners.length > 0) {
      return undefined;
    }
    renders.push({ rendered: within, suspended: inner.suspended });
  }
  return renderOf(renders, names);
}

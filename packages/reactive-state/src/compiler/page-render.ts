import {
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  type ImportSpecifier,
  isConditionalExpression,
  isIdentifier,
  isImportDeclaration,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxNamespacedName,
  isJsxSelfClosingElement,
  isNamedImports,
  isPropertyAccessExpression,
  isReturnStatement,
  isStringLiteral,
  type JsxElement,
  type JsxSelfClosingElement,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { unshadowedReads } from './code-globals.ts';
import {
  bindStatement,
  givenTo,
  holdsSearchParams,
  parameterSources,
  type Reading,
  scanAwaits,
} from './page-bindings.ts';
import { checkExpressionUses, type JsxSites } from './page-params.ts';
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
  applyParamTaints,
  elementProps,
  type ElementProps,
  type Held,
  moduleNamesOf,
  propsOfAll,
  rootSpreadObjectsOf,
  type Scope,
  type Source,
} from './page-values.ts';
import { declaredWithin } from './scope.ts';

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
 * `&&`, `||` or `??`, in a branch of a `?:` the other of which renders none, inside an unanalyzed
 * wrapper component, in a callback, in what an element is handed as a prop, or past an early
 * `return`, the statements before a function's `return` being its constants alone.
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
  /** Whether it awaits — its params, its search params, or anything else — outside any `<Suspense>`. */
  readonly blocking: boolean;
  /** Whether it reads its search params. */
  readonly searched: boolean;
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
  /** Local names that value-import `Fragment` by name from `'react'`. */
  readonly fragments: ReadonlySet<string>;
  /** The reads in the file's code that no scope around them declares again (`unshadowedReads`). */
  readonly free: ReadonlySet<Identifier>;
  /** Whether a specifier names a reactive root the compile compiled. */
  readonly isRoot: (specifier: string) => boolean;
  readonly page: FunctionDeclaration;
}

/** Named import specifiers of a value `import { … } from 'react'` statement. */
function reactNamedImports(statement: Statement): readonly ImportSpecifier[] {
  if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier)) {
    return [];
  }
  const clause = statement.importClause;
  const named = clause?.namedBindings;
  const fromReact =
    statement.moduleSpecifier.text === 'react' &&
    clause !== undefined &&
    clause.phaseModifier !== SyntaxKind.TypeKeyword;
  return fromReact && named !== undefined && isNamedImports(named) ? named.elements : [];
}

/** Local names that import `Fragment` as a value from `'react'`. */
function fragmentNamesOf(sourceFile: SourceFile): ReadonlySet<string> {
  const fragments = new Set<string>();
  for (const statement of sourceFile.statements) {
    for (const element of reactNamedImports(statement)) {
      if (!element.isTypeOnly && (element.propertyName ?? element.name).text === 'Fragment') {
        fragments.add(element.name.text);
      }
    }
  }
  return fragments;
}

/** Whether an element holds nothing but white space, and comments, between its tags. */
function isEmpty(element: JsxElement | JsxSelfClosingElement): boolean {
  return !isJsxElement(element) || element.children.every((child) => isBlank(child));
}

/** Whether `element` is an intrinsic browser element (`<main>`, `<svg:g>`), not a component value. */
function isIntrinsicElement(element: JsxElement | JsxSelfClosingElement): boolean {
  const tag = tagOf(element);
  return isJsxNamespacedName(tag) || (isIdentifier(tag) && /^[a-z]/u.test(tag.text));
}

/** Whether `element` is `react`'s `Suspense`, with no scope around it declaring the name again. */
function isSuspenseElement(element: JsxElement | JsxSelfClosingElement, tags: Tags): boolean {
  const tag = tagOf(element);
  const root = isPropertyAccessExpression(tag) ? tag.expression : tag;
  return isIdentifier(root) && tags.free.has(root) && isSuspense(tag, tags.names);
}

/** Whether `element` is `react`'s `Fragment`, with no scope around it declaring the name again. */
function isFragmentElement(element: JsxElement, tags: Tags): boolean {
  const tag = tagOf(element);
  const root = isPropertyAccessExpression(tag) ? tag.expression : tag;
  if (!isIdentifier(root) || !tags.free.has(root)) {
    return false;
  }
  if (isIdentifier(tag)) {
    return tags.fragments.has(tag.text);
  }
  return (
    isPropertyAccessExpression(tag) &&
    tags.names.reactNamespaces.has(root.text) &&
    tag.name.text === 'Fragment'
  );
}

/** Whether `element` always renders its JSX children: an intrinsic tag, `Fragment` or `Suspense`. */
function isTransparentElement(element: JsxElement, tags: Tags): boolean {
  return (
    isIntrinsicElement(element) ||
    isFragmentElement(element, tags) ||
    isSuspenseElement(element, tags)
  );
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
function childrenRendered(node: Node, tags: Tags): readonly Node[] {
  if (isJsxFragment(node)) {
    return node.children;
  }
  if (isJsxElement(node)) {
    return isTransparentElement(node, tags) ? node.children : [];
  }
  return isJsxExpression(node) && node.expression !== undefined ? [unwrapped(node.expression)] : [];
}

/**
 * Whether `node`, where a function of the page's renders it, renders the root whatever path it
 * takes: the root's element; a function's of the page's whose `return` does, one deep — none
 * `nested` in one; an intrinsic element, `Fragment`, `Suspense` or `{…}` one of whose children
 * does; or a `?:` both of whose branches do.
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
  return childrenRendered(node, tags).some((child) => rendersRoot(child, tags, nested));
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
    return childrenRendered(node, tags);
  }
  return rendersRoot(node, tags, false)
    ? [unwrapped(node.whenTrue), unwrapped(node.whenFalse)]
    : [];
}

/**
 * Collects into `placed` each element of the root's, or of a function's of the page's, that `node`
 * renders whatever path it takes: one an intrinsic element, `Fragment`, `Suspense` or `{…}` holds,
 * or a branch of a `?:` both of whose branches render the root (`renderedWhenever`) — none under
 * `&&`, `||` or `??`, in a branch of another `?:`, inside a custom wrapper, in a callback, or in
 * what an element is handed as a prop.
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

/** Builds the JSX classification sets for a function's `return` expression (`sites`). */
function jsxSitesOf(sites: Sites, tags: Tags): JsxSites {
  const rootElements = sites.roots.map((site) => site.element);
  return {
    free: tags.free,
    innerSites: new Set(sites.inners.map((site) => site.element)),
    isSafeAttrElement: (element) => isIntrinsicElement(element) || isSuspenseElement(element, tags),
    isTransparent: (element) => isTransparentElement(element, tags),
    rootSites: new Set(rootElements),
    rootSpreadObjects: rootSpreadObjectsOf(rootElements),
  };
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
  const sites = sitesIn(returned.expression, context.tags);
  const jsx = jsxSitesOf(sites, context.tags);
  const locals = new Map(sources);
  const reading: Reading = {
    awaits: false,
    destructured: [],
    paramHolders: new Map(),
    scope: { declared: declaredWithin(fn), locals, module: context.module },
    searched: holdsSearchParams(sources),
    taintedAll: false,
    taintedParams: new Set(),
    unawaitedProps: new Set(),
  };
  const before = statements.slice(0, -1);
  for (const statement of before) {
    const rendering = sitesIn(statement, context.tags);
    const renders = rendering.roots.length > 0 || rendering.inners.length > 0;
    if (renders || !bindStatement(statement, reading, context.sourceFile, jsx)) {
      return undefined;
    }
  }
  scanAwaits(returned.expression, reading);
  if (
    !checkExpressionUses(returned.expression, reading, jsx) ||
    sites.refused ||
    !isPlaced(returned.expression, sites, context.tags)
  ) {
    return undefined;
  }
  return { reading, sites };
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
  const taintedAll = renders.some(({ rendered }) => rendered.reading.taintedAll);
  const taintedParams = new Set(
    renders.flatMap(({ rendered }) => [...rendered.reading.taintedParams]),
  );
  for (const { rendered } of renders) {
    applyParamTaints(rendered.reading.scope.locals, taintedParams, taintedAll);
  }
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
    tags: {
      fragments: fragmentNamesOf(sourceFile),
      free: unshadowedReads(sourceFile),
      isRoot,
      names,
      page,
    },
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

import {
  isBindingElement,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isIdentifier,
  isInterfaceDeclaration,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  isSourceFile,
  isTypeAliasDeclaration,
  isTypeNode,
  isTypeParameterDeclaration,
  type Node,
  type SourceFile,
} from 'typescript/ast';

import type { CompiledComponent } from './emit-app.ts';
import type { ImportBinding } from './imports.ts';
import type { MiddlewareSplit } from './middleware.ts';
import type { Modules } from './modules.ts';
import { type Facts, mergedFacts, type Reach, untrackedIn } from './reach.ts';
import type { WrapperFile } from './route-scan.ts';

/**
 * Whether a route's document may be one artifact every visitor is answered with — judged of its
 * code, conservatively, before anything runs: its root and every component the root renders, the
 * guards of the route middleware around it, the page and what renders around it in its document,
 * and every reactive component those render, judged as the root's are. It may not where any of
 * them reads the session's identity, an input nothing tracks
 * (the clock, randomness, the network), a library, or the request, or keeps what a function of its
 * writes between calls, or where a component holds a state the page writes, or renders of a page's
 * state. Where it may not, why, in a few words: the route is rendered for each request, as before.
 * The authority checks a shared render of the root as it runs it besides, and drops to the
 * request's where the code reaches what this did not see; what renders around the root it does not
 * run, and this judgement is all that stands for it.
 */

/** A route middleware, as what it reaches is judged. */
export interface JudgedMiddleware {
  readonly split: MiddlewareSplit;
  /** What its guard reaches. */
  readonly facts: Facts;
}

export interface RouteAround {
  /** The root's id. */
  readonly root: string;
  /** The route middleware around the page, outermost first. */
  readonly chain: readonly JudgedMiddleware[];
  /** The layouts, templates and loading states around the page, outermost first. */
  readonly wrappers: readonly WrapperFile[];
  /** The page's file, and what it runs beside rendering the root. */
  readonly page: { readonly file: string; readonly beside: string | undefined };
}

export interface Judging {
  readonly components: ReadonlyMap<string, CompiledComponent>;
  readonly modules: Modules;
  readonly reach: Reach;
  /** What each component reaches, as judged once. */
  readonly judged: Map<string, Facts>;
}

/** What a route is judged: shared, or why not. */
export type Judgement =
  | { readonly shared: true }
  | { readonly shared: false; readonly reason: string };

/** The roots and every component they render, each once, in the order they are reached. */
function treeOf(
  roots: Iterable<string>,
  components: ReadonlyMap<string, CompiledComponent>,
): readonly CompiledComponent[] {
  const found: CompiledComponent[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const compiled = components.get(id);
    if (compiled === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    found.push(compiled);
    queue.push(...new Set(compiled.sides.refs.components.values()));
  }
  return found;
}

/**
 * What a component reaches: the imports its program reads at run time, and the application's
 * modules they reach; the inputs nothing tracks its server part reads, and what a function of it
 * keeps between calls; and the same of its browser part outside the functions it holds — what runs
 * as a page renders it, not its handlers — and of the modules the browser part imports, as the
 * server renders them too, outside the code of the browser alone (`browserFacts`).
 */
function componentFacts(compiled: CompiledComponent, judging: Judging): Facts {
  const known = judging.judged.get(compiled.component.id);
  if (known !== undefined) {
    return known;
  }
  const { component, sides } = compiled;
  const bindings = component.modules.flatMap((module) => module.bindings);
  const authority = (binding: ImportBinding): boolean =>
    sides.authority.values.has(binding.name.text);
  const server = [...component.server, ...component.states.map((state) => state.statement)];
  const browser = [
    ...component.constants,
    ...(component.returned === undefined ? [] : [component.returned]),
  ];
  const untracked = untrackedIn(server) ?? untrackedIn(browser, true);
  const kept = judging.reach.keptIn(server) ?? judging.reach.keptIn(browser, true);
  const reached = mergedFacts(
    judging.reach.bindingFacts(bindings.filter((binding) => authority(binding))),
    judging.reach.browserFacts(bindings.filter((binding) => !authority(binding))),
  );
  const facts = mergedFacts(reached, {
    ...(untracked !== undefined && { untracked }),
    ...(kept !== undefined && { kept }),
  });
  judging.judged.set(component.id, facts);
  return facts;
}

/** Whether `node` names a type, which reads nothing. */
function isTypePosition(node: Node): boolean {
  return (
    (isTypeNode(node) && !isExpressionWithTypeArguments(node)) ||
    isTypeAliasDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isTypeParameterDeclaration(node)
  );
}

/** The runtime key a property access or destructuring binding selects. */
function selectedKey(node: Node): Node | undefined {
  if (isElementAccessExpression(node)) return node.argumentExpression;
  if (isBindingElement(node)) return node.propertyName;
  return undefined;
}

/** A search-param identifier, or literal text inside a property selector or binding key. */
function isSearchParamsName(node: Node): boolean {
  if (isIdentifier(node)) return node.text === 'searchParams';
  if (
    !(isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) ||
    node.text !== 'searchParams'
  )
    return false;
  let within: Node = node;
  for (let at = node.parent; !isSourceFile(at); within = at, at = at.parent) {
    if (selectedKey(at) === within) return true;
  }
  return false;
}

/**
 * Whether a page or a layout names a page's search params, anywhere outside a type: as a name —
 * `searchParams`, `{ searchParams: query }` — or as text, `props['searchParams']`. A page that
 * reaches them otherwise — its props handed on, spread, taken by a rest — is no page of the shape a
 * root is shared of (`pageShapeOf`), and what reads them through a module, `useSearchParams`, the
 * modules' reach says (`Facts.query`).
 */
function readsSearchParams(sourceFile: SourceFile): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found || isTypePosition(node)) {
      return;
    }
    found = isSearchParamsName(node);
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

/** What one of the facts says of whose code it is found in. */
type Saying = (facts: Facts) => string | undefined;

const SAYINGS: readonly Saying[] = [
  (facts) => {
    return facts.database === undefined
      ? undefined
      : `uses the database (\`${facts.database}\`), which the authority alone holds — render a reactive component that reads it`;
  },
  (facts) => {
    return facts.identity === undefined
      ? undefined
      : `reads the session's identity (\`${facts.identity}\`)`;
  },
  (facts) => {
    return facts.untracked === undefined
      ? undefined
      : `reads \`${facts.untracked}\`, an input nothing tracks`;
  },
  (facts) => {
    return facts.kept === undefined
      ? undefined
      : `keeps what a function of its writes between calls, \`${facts.kept}\``;
  },
  (facts) => (facts.library === undefined ? undefined : `reads the library \`${facts.library}\``),
  (facts) => (facts.request === undefined ? undefined : `reads the request (\`${facts.request}\`)`),
  (facts) => {
    return facts.query === undefined
      ? undefined
      : `reads the request's query (\`${facts.query}\`), which the server renders it with too`;
  },
];

/** What the first of `facts` says, in the order of `SAYINGS`. */
function sayingOf(facts: Facts): string | undefined {
  for (const saying of SAYINGS) {
    const said = saying(facts);
    if (said !== undefined) {
      return said;
    }
  }
  return undefined;
}

/** What a component holds that the page writes, or renders of the page's state. */
function clientReason(compiled: CompiledComponent): string | undefined {
  const [written] = compiled.writable;
  if (written !== undefined) {
    return `holds a state the page writes (\`${written}\`)`;
  }
  return compiled.sides.sites.length > 0
    ? 'renders a dynamic site of a state of the page'
    : undefined;
}

/**
 * What renders around the page, or the page itself, that reads what one document for every visitor
 * cannot hold — the session's identity, an input nothing tracks, what a function keeps between
 * calls, a library, the request: its name, and what it reads. The authority runs none of them, so
 * nothing at run time stands behind this.
 */
function aroundReason(around: RouteAround, judging: Judging): string | undefined {
  for (const file of aroundFiles(around)) {
    const name = `\`${judging.modules.nameOf(file)}\``;
    const said = sayingOf(judging.reach.renderedFacts(file));
    if (said !== undefined) {
      return `${name} ${said}`;
    }
    if (readsSearchParams(judging.modules.parse(file, false).sourceFile)) {
      return `${name} reads \`searchParams\``;
    }
  }
  return around.page.beside === undefined
    ? undefined
    : `the page runs \`${around.page.beside}\` beside its root`;
}

/** The layouts, templates and loading states around the page, outermost first, and the page. */
function aroundFiles(around: RouteAround): readonly string[] {
  return [...around.wrappers.map((wrapper) => wrapper.file), around.page.file];
}

/**
 * The reactive components what renders around the page, or the page itself, renders beside the
 * route's root (`renderedComponents`), each with the first of those files that renders it.
 */
function besideRoot(around: RouteAround, judging: Judging): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const file of aroundFiles(around)) {
    for (const id of judging.reach.renderedComponents([file])) {
      if (id !== around.root && !found.has(id)) {
        found.set(id, file);
      }
    }
  }
  return found;
}

/**
 * Why a component rendered beside the route's root keeps the route from being shared, whatever it
 * reads: the authority renders it as any root of no route of its own, for the request's session
 * alone, and so leaves it empty in the render a document every visitor is answered with is made of,
 * which no session asks for.
 */
function besideReason(beside: ReadonlyMap<string, string>, judging: Judging): string | undefined {
  const [first] = beside;
  if (first === undefined) {
    return undefined;
  }
  const [id, file] = first;
  return `\`${judging.modules.nameOf(file)}\` renders \`${id}\` beside the route's root: a component the authority renders for a session alone`;
}

/**
 * Whether the route around `around` may be shared, and why not where it may not: of its root, and
 * of each reactive component what renders around it renders beside the root (`besideRoot`), judged
 * as the root's tree is, each once, the root's first — and, whatever such a component reads, not
 * shared where there is one (`besideReason`).
 */
export function judgeRoute(around: RouteAround, judging: Judging): Judgement {
  const beside = besideRoot(around, judging);
  const tree = treeOf([around.root, ...beside.keys()], judging.components);
  const parties = [
    ...tree.map((compiled) => {
      return {
        facts: componentFacts(compiled, judging),
        name: `\`${compiled.component.id}\``,
      };
    }),
    ...around.chain.map((each) => {
      return {
        facts: each.facts,
        name: `the guard of \`${each.split.fileName}\``,
      };
    }),
  ];
  for (const saying of SAYINGS) {
    for (const party of parties) {
      const said = saying(party.facts);
      if (said !== undefined) {
        return { reason: `${party.name} ${said}`, shared: false };
      }
    }
  }
  for (const compiled of tree) {
    const said = clientReason(compiled);
    if (said !== undefined) {
      return { reason: `\`${compiled.component.id}\` ${said}`, shared: false };
    }
  }
  const reason = aroundReason(around, judging) ?? besideReason(beside, judging);
  return reason === undefined ? { shared: true } : { reason, shared: false };
}

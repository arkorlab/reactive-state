import type { Node } from 'typescript/ast';

import { failIn } from './errors.ts';
import { exportOf } from './module-exports.ts';
import type { Modules } from './modules.ts';
import { paramsNotGiven, rootsImported, type ShapedPage } from './route-pages.ts';
import {
  type AppLayout,
  chainOf,
  type PageEntry,
  type RouteName,
  wrappersOf,
} from './route-scan.ts';
import type { CompiledMiddleware } from './routes.ts';

/**
 * What the compile refuses of the application's routes as a whole: a route two pages are; a root
 * rendered under two chains of route middleware — its entry names the one route whose guards are
 * run wherever it renders; a root its route's guards cannot be run for — given too few of the
 * route's params to run a guard that reads them, or rendered under a guard by a page the compile
 * registers no route of. A guard is never left out: where the compile cannot carry it to every
 * place the root renders, it refuses.
 */

/** A registered page, and the chain of route middleware around it. */
export interface Registered {
  readonly shaped: ShapedPage;
  readonly chain: readonly string[];
}

export interface Checking {
  readonly modules: Modules;
  readonly layout: AppLayout;
  /** Each route middleware the compile read, by id. */
  readonly middleware: ReadonlyMap<string, CompiledMiddleware>;
}

/** How a chain of route middleware reads in what is refused. */
function chainName(chain: readonly string[]): string {
  return chain.length === 0
    ? 'none'
    : chain.map((id) => `\`${id === '' ? '(app)' : id}\``).join(', ');
}

/** Refuses `file`, a module of the application's, at `node`, for `reason`. */
function refuseIn(file: string, node: Node, reason: string, modules: Modules): never {
  const { sourceFile } = modules.parse(file, false);
  return failIn(sourceFile, modules.nameOf(file))(reason, node);
}

/** Refuses `page` at `node`, for `reason`. */
function refuse(page: PageEntry, node: Node, reason: string, modules: Modules): never {
  return refuseIn(page.file, node, reason, modules);
}

/** The first middleware of `chain` with a guard, as `has` reads one. */
function guardIn(
  chain: readonly string[],
  middleware: ReadonlyMap<string, CompiledMiddleware>,
  has: (compiled: CompiledMiddleware) => boolean,
): CompiledMiddleware | undefined {
  for (const id of chain) {
    const compiled = middleware.get(id);
    if (compiled !== undefined && has(compiled)) {
      return compiled;
    }
  }
  return undefined;
}

/** Refuses a route two pages are. */
function checkRoutesOnce(registered: readonly Registered[], modules: Modules): void {
  const byRoute = new Map<string, Registered>();
  for (const each of registered) {
    const { element, name, page } = each.shaped;
    const other = byRoute.get(name.route);
    if (other !== undefined) {
      refuse(
        page,
        element,
        `\`${name.route}\` is the route of two pages, \`${other.shaped.page.page}\` and \`${page.page}\`: a route is one page.`,
        modules,
      );
    }
    byRoute.set(name.route, each);
  }
}

/**
 * Refuses a route whose root is given too few of its params for a guard of its middleware that
 * reads them: the authority runs a route's guards with the params its root is given, as they are.
 */
function checkGuardParams(registered: readonly Registered[], checking: Checking): void {
  for (const { chain, shaped } of registered) {
    const reader = guardIn(
      chain,
      checking.middleware,
      (compiled) => (compiled.split.guard?.context.length ?? 0) > 0,
    );
    const [missing] = paramsNotGiven(shaped);
    if (reader !== undefined && missing !== undefined) {
      refuse(
        shaped.page,
        shaped.element,
        `\`${shaped.name.route}\` renders \`${shaped.root}\` without its param \`${missing}\`, of which the guard of \`${reader.split.fileName}\` reads its params: the authority runs a route's guards with the params its root is given, as they are. Give the root each param of its route — \`${missing}={${missing}}\`.`,
        checking.modules,
      );
    }
  }
}

/** A rendered file retains the enclosing page's middleware chain and each root's registered owner. */
function checkRenderedRoots(
  page: Pick<PageEntry, 'file' | 'page'> & { readonly wrapper?: true },
  context: {
    readonly chain: readonly string[];
    readonly first: ReadonlyMap<string, Registered>;
    readonly chains: ReadonlyMap<string, ReadonlySet<string>>;
    readonly pages: ReadonlySet<string>;
  },
  checking: Checking,
): void {
  const { chain, first, chains, pages } = context;
  const { middleware, modules } = checking;
  const guard = guardIn(chain, middleware, (compiled) => compiled.registration.guard);
  for (const { at, root } of rootsImported(page, modules)) {
    const owner = first.get(root);
    if (owner !== undefined && chainName(owner.chain) !== chainName(chain)) {
      refuseIn(
        page.file,
        at,
        `\`${root}\` is rendered under two chains of route middleware: by \`${owner.shaped.name.route}\` (\`${owner.shaped.page.page}\`) under ${chainName(owner.chain)}, and by \`${page.page}\` under ${chainName(chain)}. A root's entry names the one route it renders for, whose guards are run wherever it renders: render another root here, or the root under one chain.`,
        modules,
      );
    }
    const named = chains.get(root)?.has(chainName(chain)) === true;
    if (guard !== undefined && !named) {
      const reason =
        page.wrapper === true || pages.has(page.file)
          ? `\`${root}\` is rendered by \`${page.page}\` under the guard of \`${guard.split.fileName}\`, but no registered route associates this root with that middleware chain, so the guard would be left out where the root renders. Give this root its own registered page under the same middleware chain.`
          : `\`${root}\` is rendered by \`${page.page}\` under the guard of \`${guard.split.fileName}\`, but the page is written in no shape the compile registers a route of — one reactive root, rendered whatever path the page takes, given its route's params as they are, its search params' values and constants — so the root's entry would name no route, and the guard would be left out where the root renders. Give the root its props so, and render it on every path — under no \`&&\`, in both branches of a \`?:\`, past no early \`return\` — in the page or in a function of the page's file it renders.`;
      refuseIn(page.file, at, reason, modules);
    }
  }
}

/**
 * Refuses a root rendered under two chains of route middleware — by two routes, or by a route and
 * another page — and a root a page the compile registers no route of renders under a guard.
 */
function checkChains(registered: readonly Registered[], checking: Checking): void {
  const { layout, modules } = checking;
  const first = new Map<string, Registered>();
  const chains = new Map<string, Set<string>>();
  for (const each of registered) {
    const { root } = each.shaped;
    if (!first.has(root)) {
      first.set(root, each);
    }
    chains.set(root, (chains.get(root) ?? new Set()).add(chainName(each.chain)));
  }
  const pages = new Set(registered.map((each) => each.shaped.page.file));
  // A page in a private folder (`_folder`) is no route Next.js serves.
  const served = layout.pages.filter((page) =>
    page.directory.split('/').every((segment) => !segment.startsWith('_')),
  );
  for (const page of served) {
    const chain = chainOf(page.directory, layout);
    const rendered = [
      page,
      ...wrappersOf(page.directory, layout).map(({ file }) => {
        const wrapperPage = modules.nameOf(file);
        return { file, page: wrapperPage, wrapper: true as const };
      }),
    ];
    for (const entry of rendered) {
      checkRenderedRoots(entry, { chain, chains, first, pages }, checking);
    }
  }
}

/**
 * Refuses a root two registered routes render: its entry names the one route it renders for — its
 * params, its guards and its shared view, wherever it renders — so the second route's page would
 * render the first route's, and its gate would wait on a view no page renders.
 */
function checkRootsOnce(registered: readonly Registered[], modules: Modules): void {
  const owners = new Map<string, Registered>();
  for (const each of registered) {
    const { element, name, page, root } = each.shaped;
    const owner = owners.get(root);
    if (owner === undefined) {
      owners.set(root, each);
      continue;
    }
    refuse(
      page,
      element,
      `\`${root}\` is the root of two routes, \`${owner.shaped.name.route}\` (\`${owner.shaped.page.page}\`) and \`${name.route}\` (\`${page.page}\`): a root's entry names the one route it renders for — its params, its guards and its shared view — so a root is one route's. Render another root in one of them.`,
      modules,
    );
  }
}

/**
 * The export Next.js asks each segment's layout, and the page, for the members of the route to
 * prerender by: every one along the route it is exported by, the members it answers each made up
 * of the params of those above it.
 */
const PRERENDERED_MEMBERS = 'generateStaticParams';

/**
 * The files Next.js asks for the members of a page's route (`PRERENDERED_MEMBERS`): each layout
 * along it, outermost first, then the page. A route handler is asked alone.
 */
export function memberFiles(
  page: Pick<PageEntry, 'directory' | 'file'>,
  layout: AppLayout,
): readonly string[] {
  const layouts = wrappersOf(page.directory, layout).filter((wrapper) => wrapper.kind === 'layout');
  return [...layouts.map((wrapper) => wrapper.file), page.file];
}

/**
 * Refuses a route of a dynamic segment under route middleware whose members are prerendered
 * (`generateStaticParams`), by one of `files` — those Next.js asks for them (`memberFiles`): its
 * rewrite to the delivery route runs after the files (`afterFiles`), and a platform that serves a
 * prerendered member as one of the build's files — upwind does — would answer it with no envelope
 * around it, which every request of the route is to have. Refused at the export. A route of no
 * dynamic segment is rewritten before the files, and has no members.
 */
export function checkMembers(name: RouteName, files: readonly string[], modules: Modules): void {
  if (name.params.length === 0) {
    return;
  }
  for (const file of files) {
    const exported = exportOf(file, PRERENDERED_MEMBERS, modules);
    if (exported !== undefined) {
      refuseIn(
        file,
        exported,
        `\`${modules.nameOf(file)}\` prerenders members of \`${name.route}\` (\`${PRERENDERED_MEMBERS}\`), which route middleware is around: a prerendered member is served as a file of the build, with no envelope around it, where every request of the route is to go through the middleware. Leave the members to be rendered for their requests — take \`${PRERENDERED_MEMBERS}\` out — or the route out from under the middleware.`,
        modules,
      );
    }
  }
}

/** Refuses each registered route under route middleware whose members are prerendered. */
function checkDeliveredMembers(registered: readonly Registered[], checking: Checking): void {
  for (const { chain, shaped } of registered) {
    if (chain.length > 0) {
      checkMembers(shaped.name, memberFiles(shaped.page, checking.layout), checking.modules);
    }
  }
}

/**
 * Refuses what the registered routes cannot be, together. The roots each served page, layout and
 * boundary renders are read for the chains of route middleware around them alone: an application
 * of no route middleware has none around any page, where neither refusal of `checkChains` — a root
 * under two chains, a root under a guard no route associates it with — can be, and where reading
 * every page's imports whole would cost a large application minutes for nothing.
 */
export function checkRoutes(registered: readonly Registered[], checking: Checking): void {
  checkRoutesOnce(registered, checking.modules);
  checkRootsOnce(registered, checking.modules);
  checkDeliveredMembers(registered, checking);
  checkGuardParams(registered, checking);
  if (checking.layout.middleware.size > 0) {
    checkChains(registered, checking);
  }
}

import type { Json, View as PageView, RenderStatus } from '../program.ts';
import { ownValueOf, type RouteParams, type RouteRegistration } from '../routing.ts';
import { HTTP_UNAUTHORIZED } from '../status.ts';
import { type Assembly, assemble } from './assemble.ts';
import { type BindingClaims, signBinding } from './bindings.ts';
import { digest } from './canonical.ts';
import { Dependencies } from './dependencies.ts';
import { AuthorityError, refusal } from './errors.ts';
import { Call, type Scope } from './evaluation.ts';
import { admittedGuard, type InitialGuardAdmission } from './guard-admissions.ts';
import { guardsOf, runGuards } from './guards.ts';
import type { Core, Session } from './model.ts';
import { type Renderer, renderRoot } from './render.ts';
import { fillSites } from './sites.ts';

/**
 * A session's render of a page's root, in one call of the application's code: the root's status
 * for the session, the tree and its fields' values where it rendered — each dynamic site rendered
 * for the page's view — a digest of what it shows, the view it shows, and everything it read. A
 * page's frame is made of it, and so is each check of an event stream.
 */

/** How long a binding lasts: as long as a session does, a day. */
const BINDING_TTL_MS = 86_400_000;

/** A page's root: the component, and the props the page renders it with. */
export interface Root {
  readonly component: string;
  readonly props: Readonly<Record<string, Json>>;
}

export interface View {
  readonly status: RenderStatus;
  readonly assembly: Assembly;
  /** A digest of what the page shows: the status, the tree as rendered, and the fields' values. */
  readonly digest: string;
  readonly revision: number;
  /** What the render read — empty for a session the root did not render for at all. */
  readonly dependencies: Dependencies | undefined;
  /** The view it shows: the inputs of each site it rendered. */
  readonly shown: PageView;
  /**
   * What a subscription names of it: the parts that show otherwise than at first. A render for the
   * subscription finds the others again as they show at first, so that a page of many parts, most
   * showing what they showed at first, is followed by a short subscription.
   */
  readonly named: PageView;
}

/** A route a root is rendered for, and its params: whose middleware's guards run first. */
interface RouteContext {
  readonly route: RouteRegistration;
  /** The params the root's props give the route, where they give them (`routeOfRoot`). */
  readonly params: RouteParams | undefined;
}

/**
 * A call's scope: its records, and the session's user while the session lasts; for a request of no
 * session, the authority's refusal (401) of `requireUser`, and `null` of `currentUser`.
 */
export function scopeOf(core: Core, call: Call, session: Session | undefined): Scope {
  const onRead = (): void => {
    core.metrics.appReads += 1;
  };
  if (session === undefined) {
    return {
      call,
      onRead,
      optionalUser: () => null,
      tables: core.tables,
      user: () => {
        throw refusal(HTTP_UNAUTHORIZED, 'UNAUTHENTICATED', 'Sign in first.');
      },
    };
  }
  return {
    call,
    onRead,
    tables: core.tables,
    user: () => ({ id: core.current(session).userId }),
  };
}

/** A renderer for one call of the session's, or of a request of none. */
export function rendererOf(core: Core, call: Call, session: Session | undefined): Renderer {
  return {
    buildId: core.registry.buildId,
    counts: core.metrics,
    definition: core.definition,
    evaluatedBy: core.evaluatedBy,
    instances: 0,
    memo: core.memo,
    programs: core.registry.programs,
    scope: scopeOf(core, call, session),
    userId: session?.userId ?? '',
  };
}

/**
 * The route `root` is the root of, with the params its props give it: the route a page renders it
 * by, whose middleware's guards hold of every render and every write of it, whoever asks — the
 * request never says which. Its props give no params where a prop the route reads one of is no
 * text — a list, a number, or no prop at all — or two props of one param differ, of which a guard
 * would be asked of one while the root reads the other. No route for a root no route registered; a
 * root is one route's, as the registry refuses one two routes render (`routeRegistryOf`).
 */
function routeOfRoot(core: Core, root: Root): RouteContext | undefined {
  for (const route of core.routes.routes.values()) {
    if (route.root !== root.component) {
      continue;
    }
    // Each the map's own, whatever its name, as the gate's are (`paramsOfPath`).
    const params = new Map<string, string>();
    for (const [prop, param] of Object.entries(route.props)) {
      const value = ownValueOf(root.props, prop);
      if (typeof value !== 'string' || (params.get(param) ?? value) !== value) {
        return { params: undefined, route };
      }
      params.set(param, value);
    }
    return { params: Object.fromEntries(params), route };
  }
  return undefined;
}

/**
 * What the guards of the route `root` is of say of the session: whether it may go on to the root. A
 * root of props that give its route no params, which no guard can be asked of, is refused where
 * its route's middleware has a guard — never rendered past it — and goes on where it has none.
 */
export async function guardedBy(
  core: Core,
  renderer: Renderer,
  root: Root,
  admission?: InitialGuardAdmission,
): Promise<{ readonly refused: boolean; readonly dependencies: Dependencies }> {
  const dependencies = new Dependencies();
  const routed = routeOfRoot(core, root);
  if (routed === undefined) {
    return { dependencies, refused: false };
  }
  const guards = guardsOf(core, routed.route.middleware);
  if (routed.params === undefined) {
    return { dependencies, refused: guards.length > 0 };
  }
  if (admission !== undefined && admittedGuard(core, admission, routed.route, routed.params)) {
    return { dependencies, refused: false };
  }
  const guarded = await runGuards(core, renderer, guards, {
    dependencies,
    params: routed.params,
  });
  return { dependencies, refused: guarded.kind !== 'pass' };
}

const EMPTY: Assembly = { fields: {}, tree: null };

/** A view of a root the session may not see: its status alone. */
export function statusView(core: Core, status: RenderStatus, dependencies?: Dependencies): View {
  return {
    assembly: EMPTY,
    dependencies,
    digest: digest({ fields: {}, status, tree: null }),
    named: {},
    revision: core.db.revision(),
    shown: {},
    status,
  };
}

/**
 * Renders the session's view of `root` — its sites for the view `requested`, or at first where it
 * names none — with bindings signed for its persistent states where `bindings` says so: a page's
 * render does; an event stream's, which only compares, does not.
 */
export async function viewOf(
  core: Core,
  session: Session | undefined,
  root: Root,
  options: {
    readonly admission?: string | undefined;
    readonly bindings: boolean;
    readonly view?: PageView | undefined;
  },
): Promise<View> {
  const { bindings, view: requested } = options;
  core.metrics.renders += 1;
  const call = new Call(`The render of ${root.component}`, core.timeoutMs);
  let rendered: Awaited<ReturnType<typeof renderRoot>>;
  let shown: PageView = {};
  let named: PageView = {};
  try {
    const renderer = rendererOf(core, call, session);
    const guarded = await guardedBy(
      core,
      renderer,
      root,
      options.admission === undefined ? undefined : { session, token: options.admission },
    );
    if (guarded.refused) {
      return statusView(core, 'forbidden', guarded.dependencies);
    }
    rendered = await renderRoot(renderer, root);
    rendered.dependencies.merge(guarded.dependencies);
    if (rendered.root.output.kind !== 'refused') {
      const filled = await fillSites(renderer, rendered.root, requested, rendered.dependencies);
      rendered = { ...rendered, root: filled.root };
      ({ named, view: shown } = filled);
    }
    if (call.fault !== undefined) {
      throw call.fault.error;
    }
  } catch (error) {
    // A fault is the render's outcome, whatever came after it.
    const thrown = call.fault === undefined ? error : call.fault.error;
    if (thrown instanceof AuthorityError && thrown.status === HTTP_UNAUTHORIZED) {
      return statusView(core, 'unauthenticated');
    }
    throw thrown;
  } finally {
    call.close();
  }
  const { dependencies, root: node } = rendered;
  if (node.output.kind === 'refused') {
    return statusView(core, 'forbidden', dependencies);
  }
  const now = core.clock();
  const bound = session;
  const bind = (
    claims: Omit<BindingClaims, 'build' | 'exp' | 'root' | 'session' | 'user'>,
  ): string => {
    return signBinding(core.secret, {
      ...claims,
      build: core.registry.buildId,
      exp: now + BINDING_TTL_MS,
      root,
      session: bound?.id ?? '',
      user: bound?.userId ?? '',
    });
  };
  const assembly = assemble(
    {
      bind:
        bindings && bound !== undefined
          ? (path, key, field) =>
              bind({ field: field.field, key, path, record: field.id, table: field.table })
          : undefined,
      programs: core.registry.programs,
      tables: core.tables,
    },
    node,
  );
  return {
    assembly,
    dependencies,
    digest: digest({ fields: assembly.fields, status: 'rendered', tree: node }),
    named,
    revision: core.db.revision(),
    shown,
    status: 'rendered',
  };
}

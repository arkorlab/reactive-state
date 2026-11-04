import type { Frame, Rendered } from '../program.ts';
import type { ResponseDescriptor, RouteParams, RouteRegistration } from '../routing.ts';
import { HTTP_UNAUTHORIZED } from '../status.ts';
import { assemble } from './assemble.ts';
import { digest } from './canonical.ts';
import { Dependencies } from './dependencies.ts';
import { AuthorityError, refusal } from './errors.ts';
import { Call, type Scope } from './evaluation.ts';
import { guardsOf, runGuards } from './guards.ts';
import type { Core } from './model.ts';
import { type Renderer, renderRoot } from './render.ts';
import { rootPropsOf } from './route-registry.ts';
import { fillSites } from './sites.ts';
import type { Root, View } from './views.ts';

/**
 * A route's view, rendered for every visitor at once: its middleware's guards, then its root, in one
 * call with no session, every read noted. The render takes no answer from the request: a read of the
 * session's identity — `requireUser()`, `currentUser()` — or of anything nothing tracks makes it the
 * request's (`private`), whatever the code did with what it was answered, and so does a root that
 * would hand its page a binding of a session's or a site of the page's own. A guard or the root that
 * refuses (`forbidden()`) denies the route; a guard that answers a response itself answers it.
 */

/** The user a shared render's memo entries are kept under: no session's id is ever this. */
const SHARED_USER = '\0shared';
/** What a shared frame's root key names in place of a session. */
const SHARED_TAG = 'shared';

export type SharedOutcome =
  | { readonly kind: 'private'; readonly reason: string }
  | {
      readonly kind: 'denied';
      readonly dependencies: Dependencies;
      readonly revision: number;
      /** The middleware whose guard refused the view, by id; none where its root did. */
      readonly by?: string;
    }
  | {
      readonly kind: 'responded';
      readonly response: ResponseDescriptor;
      readonly dependencies: Dependencies;
      readonly revision: number;
      /** The middleware whose guard answered it, by id. */
      readonly by: string;
    }
  | {
      readonly kind: 'rendered';
      readonly root: Root;
      readonly view: View;
      readonly frame: Frame;
      readonly dependencies: Dependencies;
    };

/** The scope of a shared render: no session, and every read of one noted as the request's. */
function sharedScope(core: Core, call: Call): Scope {
  const bound = (what: string): never => {
    call.boundToRequest(what);
    throw refusal(HTTP_UNAUTHORIZED, 'REQUEST_DEPENDENT', 'This render is every visitor’s.');
  };
  return {
    call,
    onRead: () => {
      core.metrics.appReads += 1;
    },
    optionalUser: () => bound('currentUser()'),
    shared: true,
    tables: core.tables,
    user: () => bound('requireUser()'),
  };
}

function rendererOf(core: Core, call: Call): Renderer {
  return {
    buildId: core.registry.buildId,
    counts: core.metrics,
    definition: core.definition,
    evaluatedBy: core.evaluatedBy,
    instances: 0,
    memo: core.memo,
    programs: core.registry.programs,
    scope: sharedScope(core, call),
    userId: SHARED_USER,
  };
}

function isList(tree: Rendered): tree is readonly Rendered[] {
  return Array.isArray(tree);
}

/** Whether the tree shows a site of the page's own anywhere: what no one artifact can hold. */
function showsSites(tree: Rendered): boolean {
  if (typeof tree !== 'object' || tree === null) {
    return false;
  }
  if (isList(tree)) {
    return tree.some((child) => showsSites(child));
  }
  if (tree.kind === 'client') {
    const { sites, slots } = tree.part;
    return (
      (sites !== undefined && Object.keys(sites).length > 0) ||
      Object.values(slots).some((slot) => showsSites(slot))
    );
  }
  return tree.children.some((child) => showsSites(child));
}

/** The frame a shared view is shown at: no session, no subscription, no operation. */
export function sharedFrame(core: Core, root: Root, view: View): Frame {
  const { buildId } = core.registry;
  return {
    buildId,
    digest: view.digest,
    fields: view.assembly.fields,
    operations: [],
    revision: view.revision,
    rootKey: digest([root.component, root.props, SHARED_TAG, buildId]),
    subscription: '',
    view: view.shown,
  };
}

/** What the render answered once it finished: nothing more than its reads say. */
async function rendered(
  core: Core,
  renderer: Renderer,
  root: Root,
  dependencies: Dependencies,
): Promise<SharedOutcome> {
  let render = await renderRoot(renderer, root);
  if (render.root.output.kind !== 'refused') {
    const filled = await fillSites(renderer, render.root, undefined, render.dependencies);
    render = { ...render, root: filled.root };
  }
  const { call } = renderer.scope;
  if (call.fault !== undefined) {
    throw call.fault.error;
  }
  dependencies.merge(render.dependencies);
  if (call.requestBound !== undefined) {
    return { kind: 'private', reason: call.requestBound };
  }
  const revision = core.db.revision();
  if (render.root.output.kind === 'refused') {
    return { dependencies, kind: 'denied', revision };
  }
  const asked = { binding: false };
  const assembly = assemble(
    {
      bind: () => {
        asked.binding = true;
        return '';
      },
      programs: core.registry.programs,
      tables: core.tables,
    },
    render.root,
  );
  if (asked.binding) {
    return { kind: 'private', reason: 'a state the page writes, which binds a session' };
  }
  if (showsSites(assembly.tree)) {
    return { kind: 'private', reason: 'a site of the page’s own' };
  }
  const view: View = {
    assembly,
    dependencies,
    digest: digest({ fields: assembly.fields, status: 'rendered', tree: render.root }),
    named: {},
    revision,
    shown: {},
    status: 'rendered',
  };
  return { dependencies, frame: sharedFrame(core, root, view), kind: 'rendered', root, view };
}

/** The guards of `route` and its root, rendered for every visitor, at the revision the queue holds. */
export async function sharedOutcome(
  core: Core,
  route: RouteRegistration,
  params: RouteParams,
): Promise<SharedOutcome> {
  core.metrics.sharedEvaluations += 1;
  const call = new Call(`The shared render of ${route.route}`, core.timeoutMs);
  const renderer = rendererOf(core, call);
  const dependencies = new Dependencies();
  try {
    const guarded = await runGuards(core, renderer, guardsOf(core, route.middleware), {
      dependencies,
      params,
    });
    if (call.requestBound !== undefined) {
      return { kind: 'private', reason: call.requestBound };
    }
    if (guarded.kind === 'refused') {
      return { by: guarded.id, dependencies, kind: 'denied', revision: core.db.revision() };
    }
    if (guarded.kind === 'respond') {
      return {
        by: guarded.id,
        dependencies,
        kind: 'responded',
        response: guarded.response,
        revision: core.db.revision(),
      };
    }
    const root: Root = { component: route.root, props: rootPropsOf(route, params) };
    return await rendered(core, renderer, root, dependencies);
  } catch (error) {
    if (call.requestBound !== undefined) {
      return { kind: 'private', reason: call.requestBound };
    }
    const thrown = call.fault === undefined ? error : call.fault.error;
    if (thrown instanceof AuthorityError && thrown.status === HTTP_UNAUTHORIZED) {
      return { kind: 'private', reason: 'a refusal of the session' };
    }
    throw thrown;
  } finally {
    call.close();
  }
}

import { isFieldRef, type SiteInputs } from '../program.ts';
import type { BindingClaims } from './bindings.ts';
import { keyTag, shortDigest } from './canonical.ts';
import { denied } from './errors.ts';
import { itemsWithin } from './items.ts';
import {
  evaluated,
  functionsOf,
  isForbidden,
  keptOf,
  memoKey,
  type Renderer,
  type SiteFunctions,
  siteFunctions,
  siteShows,
} from './render.ts';
import { checkedInputs, declaredOf } from './sites.ts';
import {
  type ComponentStep,
  isSiteStep,
  lastComponentStep,
  type Output,
  type Skeleton,
  type SkeletonInstance,
  type SiteStep,
  type Step,
} from './skeleton.ts';
import { type Child, type InstanceNode, isDescriptor, isNode, rendered } from './tree.ts';

/**
 * A write's binding, held to what the page's root renders now: the root is rendered again with the
 * props the binding names, and then each component along its path — the memo's rendering of each
 * where it holds one, and only that component evaluated where it does not — each found again where
 * it stands in what its parent renders now (its region, and its ordinal among those of its id and
 * key there), whatever its props are now; each dynamic site on the way rendered again with the
 * inputs it was rendered with when the binding was issued. The component whose state it is must
 * still be rendered with the props it was then, bind the state to the same field, and have a setter
 * for it. So a write is made under the application's own control flow as it is now: a component or
 * a parent of it that refuses the session refuses the write (403); one no longer rendered where it
 * was, one rendered with other props, or one whose state binds another field now — a record moved
 * elsewhere, a permission that renders another component in its place — leaves the write nothing to
 * write to (`changed`).
 */

/**
 * A component as the walk finds it: as the memo holds its rendering, or as its program answered;
 * or what a dynamic site rendered, which the next component is found in.
 */
type Found =
  | { readonly from: 'content'; readonly content: Child }
  | { readonly from: 'evaluation'; readonly answered: unknown; readonly digest: string }
  | { readonly from: 'memo'; readonly output: Output; readonly digest: string };

/** A component of the path: as the memo holds it, or evaluated alone. A refusal is the session's. */
async function componentAt(
  renderer: Renderer,
  component: string,
  instance: Pick<InstanceNode, 'children' | 'nodes' | 'props'>,
): Promise<Found | undefined> {
  const program = renderer.programs.get(component);
  if (program === undefined) {
    return undefined;
  }
  const digest = shortDigest(instance.props);
  // Bound to the request where what the rendering read was, as evaluating it would be.
  const kept = keptOf(renderer, memoKey(renderer, component, instance));
  if (kept !== undefined) {
    return { digest, from: 'memo', output: kept.output };
  }
  try {
    const answered = await evaluated(renderer, program, instance, undefined);
    return { answered, digest, from: 'evaluation' };
  } catch (error) {
    if (isForbidden(error)) {
      return { digest, from: 'memo', output: { kind: 'refused' } };
    }
    throw error;
  }
}

/**
 * The component `step` names in a region of what a component rendered, as the memo keeps it — the
 * region's components hold their place — and not inside another component it renders.
 */
function inSkeleton(tree: Skeleton, step: ComponentStep): SkeletonInstance | undefined {
  const pending: unknown[] = [tree];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (Array.isArray(item)) {
      pending.push(...(item as readonly unknown[]));
    } else if (typeof item === 'object' && item !== null) {
      /** A skeleton's node, as its kind says what it is. */
      type SkeletonNode = Exclude<Skeleton, readonly Skeleton[] | boolean | number | string | null>;

      const node = item as SkeletonNode;
      switch (node.kind) {
        case 'instance': {
          if (
            node.component === step.c &&
            keyTag(node.key) === step.k &&
            node.region === step.r &&
            node.ordinal === step.n
          ) {
            return node;
          }
          break;
        }
        case 'fragment': {
          pending.push(...node.children);
          break;
        }
        case 'element':
        case 'module': {
          pending.push(...node.children, ...Object.values(node.props));
          break;
        }
        // JSON a prop holds, and an action: no component is in either.
        default: {
          break;
        }
      }
    }
  }
  return undefined;
}

/**
 * The components of a region of what a program answered, in the order a render numbers them in: a
 * list's items, an element's children and then its props — never inside a component, nor in what
 * a component is handed as its children.
 */
function* instanceNodes(child: unknown): Generator<InstanceNode> {
  if (Array.isArray(child)) {
    for (const item of child as readonly unknown[]) {
      yield* instanceNodes(item);
    }
    return;
  }
  if (!isNode(child)) {
    return;
  }
  switch (child.kind) {
    case 'instance': {
      yield child;
      break;
    }
    case 'fragment': {
      yield* instanceNodes(child.children);
      break;
    }
    case 'element':
    case 'module': {
      yield* instanceNodes(child.children);
      for (const value of Object.values(child.props)) {
        yield* instanceNodes(value);
      }
      break;
    }
  }
}

/** The component `step` names among a region of what a program answered: its node. */
function inChildren(region: Child, step: ComponentStep): InstanceNode | undefined {
  let ordinal = 0;
  for (const node of instanceNodes(region)) {
    if (node.component === step.c && keyTag(node.key) === step.k) {
      if (ordinal === step.n) {
        return node;
      }
      ordinal += 1;
    }
  }
  return undefined;
}

/** The region `name` of a component's rendering, as the memo keeps it: its tree, or a slot. */
function regionOfOutput(output: Output, name: string): Skeleton | undefined {
  if (output.kind === 'tree') {
    return name === '' ? output.tree : undefined;
  }
  if (output.kind === 'client' && Object.hasOwn(output.slots, name)) {
    return output.slots[name];
  }
  return undefined;
}

/** The region `name` of what a program answered: its tree, or a slot of its client part. */
function regionOfAnswer(answered: unknown, name: string): Child | undefined {
  if (!isDescriptor(answered)) {
    return name === '' ? rendered(answered) : undefined;
  }
  return Object.hasOwn(answered.slots, name) ? rendered(answered.slots[name]) : undefined;
}

/**
 * What the site `step` names renders, with the inputs it was rendered with — of a list, the item of
 * its key: nothing where it is no site, where its conditions no longer hold of them — a parent's own
 * condition changed since the binding was issued inside it — or where the list holds no item of the
 * key now.
 */
function siteContent(found: Found, step: SiteStep): Found | undefined {
  let functions: SiteFunctions | undefined;
  let inputs: SiteInputs;
  if (found.from === 'memo') {
    const { output } = found;
    if (output.kind !== 'client' || !Object.hasOwn(output.sites, step.s)) {
      return undefined;
    }
    const declared = output.sites[step.s];
    functions = siteFunctions(output, step.s);
    inputs = checkedInputs(step.s, declared ?? { inputs: [], kinds: {} }, step.i);
  } else if (found.from === 'evaluation' && isDescriptor(found.answered)) {
    const { sites, states } = found.answered;
    const site = Object.hasOwn(sites, step.s) ? sites[step.s] : undefined;
    if (site === undefined) {
      return undefined;
    }
    functions = functionsOf(site);
    inputs = checkedInputs(step.s, declaredOf(site, states), step.i);
  } else {
    return undefined;
  }
  if (functions === undefined || !siteShows(functions, inputs)) {
    return undefined;
  }
  if (functions.each === undefined) {
    return step.k === undefined
      ? { content: rendered(functions.render(inputs)), from: 'content' }
      : undefined;
  }
  // A list whose items break its rules since holds the binding's item no more: the write is
  // refused as changed, not failed.
  const item = itemsWithin(step.s, functions.each, inputs)?.find(
    (each) => keyTag(each.key) === step.k,
  );
  return item === undefined ? undefined : { content: rendered(item.render()), from: 'content' };
}

/** The region `name` of what `found` renders: a program's answer, or a site's rendering. */
function regionOf(
  found: Exclude<Found, { readonly from: 'memo' }>,
  name: string,
): Child | undefined {
  if (found.from === 'content') {
    return name === '' ? found.content : undefined;
  }
  return regionOfAnswer(found.answered, name);
}

/** The component `step` names, where `found` renders it; nothing where it renders it no more. */
async function located(
  renderer: Renderer,
  found: Found,
  step: ComponentStep,
): Promise<Found | undefined> {
  if (found.from === 'memo') {
    const region = regionOfOutput(found.output, step.r);
    const kept = region === undefined ? undefined : inSkeleton(region, step);
    return kept === undefined
      ? undefined
      : { digest: kept.digest, from: 'memo', output: kept.output };
  }
  const region = regionOf(found, step.r);
  const node = region === undefined ? undefined : inChildren(region, step);
  return node === undefined ? undefined : componentAt(renderer, step.c, node);
}

/** The next component of the path, where `found` renders it; nothing where it renders it no more. */
async function next(renderer: Renderer, found: Found, step: Step): Promise<Found | undefined> {
  if (isSiteStep(step)) {
    return siteContent(found, step);
  }
  const at = await located(renderer, found, step);
  // The component whose state the binding writes is pinned by its props: rendered with others
  // now, it is another component's state, whatever stands where it stood.
  if (at === undefined || at.from === 'content') {
    return undefined;
  }
  return step.p === undefined || step.p === at.digest ? at : undefined;
}

/** Whether the component `found` still binds the state `key` to the field the binding names. */
function binds(found: Found, claims: BindingClaims): boolean {
  if (found.from === 'content') {
    return false;
  }
  if (found.from === 'memo') {
    const { output } = found;
    const origin =
      output.kind === 'client' && Object.hasOwn(output.states, claims.key)
        ? output.states[claims.key]
        : undefined;
    return (
      origin !== undefined &&
      'field' in origin &&
      origin.field.table === claims.table &&
      origin.field.id === claims.record &&
      origin.field.field === claims.field
    );
  }
  const { answered } = found;
  const state =
    isDescriptor(answered) && Object.hasOwn(answered.states, claims.key)
      ? answered.states[claims.key]
      : undefined;
  return (
    isFieldRef(state) &&
    state.table === claims.table &&
    state.id === claims.record &&
    state.field === claims.field
  );
}

/** Whether `found` is a component that refused the session. */
function refused(found: Found | undefined): boolean {
  return found?.from === 'memo' && found.output.kind === 'refused';
}

/**
 * Walks the binding's path from its root: `found` where the component whose state it is still
 * binds it, and has a setter for it; `changed` where what the binding names is there no more. A
 * component along the path that refuses the session refuses the write (403); one that faults is the
 * write's fault.
 */
export async function replayPath(
  renderer: Renderer,
  claims: BindingClaims,
): Promise<'changed' | 'found'> {
  let found = await componentAt(renderer, claims.root.component, {
    children: undefined,
    nodes: {},
    props: claims.root.props,
  });
  for (const step of claims.path) {
    if (refused(found)) {
      throw denied();
    }
    found = found === undefined ? undefined : await next(renderer, found, step);
  }
  if (found === undefined) {
    return 'changed';
  }
  if (refused(found)) {
    throw denied();
  }
  const issuer = renderer.programs.get(lastComponentStep(claims.path)?.c ?? claims.root.component);
  return issuer?.writable.includes(claims.key) === true && binds(found, claims)
    ? 'found'
    : 'changed';
}

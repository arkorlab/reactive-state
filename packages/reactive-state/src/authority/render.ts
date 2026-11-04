import {
  type ComponentProgram,
  isFieldRef,
  type Json,
  type SiteDescriptor,
  type SiteInputs,
  type SiteItem,
  type SiteRendering,
} from '../program.ts';
import { type DatabaseDefinition, isRecordId } from '../server/schema.ts';
import { HTTP_FORBIDDEN } from '../status.ts';
import { digest, frozenJson, isJson, shortDigest } from './canonical.ts';
import { Dependencies } from './dependencies.ts';
import { AuthorityError } from './errors.ts';
import { renderEvaluation, type Scope } from './evaluation.ts';
import { type CheckedItem, itemsWithin } from './items.ts';
import type { Memo, MemoEntry } from './memo.ts';
import type {
  ClientOutput,
  JsonKind,
  Output,
  SiteOutput,
  Skeleton,
  SkeletonInstance,
  SkeletonProp,
  StateOrigin,
} from './skeleton.ts';
import { withinSteps } from './steps.ts';
import {
  asGiven,
  type Child,
  type InstanceNode,
  isDescriptor,
  isNode,
  rendered,
  SCOPE,
} from './tree.ts';

/**
 * A page's components, rendered: the root a page names, and, in turn, every reactive component its
 * tree renders — each an instance of its program, evaluated with the props it was rendered with,
 * in the one evaluation the render is, so every one reads the same records. A component that
 * refuses the session (`forbidden()`, 403) renders as nothing in its place; a refusal of the
 * session itself (401) is the whole render's; anything else a component throws is a fault.
 *
 * A component the memo holds the rendering of — for its props and children, the user and the
 * build, with nothing it read changed since — is not evaluated again, nor is any it renders: what
 * it read is what the render depends on all the same, and what it read that only the request
 * answers binds the render to the request as evaluating it would (`keptOf`). A dynamic site's
 * rendering is no part of it: a client part keeps what each site reads (`SiteOutput`), and its
 * functions beside it (`siteFunctions`), for each render to render the sites its view shows, its
 * guard holding.
 */

/** The most components one render renders: a page of more is a fault, not a slow answer. */
const MAX_INSTANCES = 2000;
/** How deeply components may render components: deeper is a fault, as recursion without end is. */
const MAX_DEPTH = 64;

/** What one render runs with, and counts. */
export interface Renderer {
  readonly programs: ReadonlyMap<string, ComponentProgram>;
  readonly definition: DatabaseDefinition;
  readonly buildId: string;
  readonly memo: Memo;
  readonly scope: Scope;
  /** The session's user, whose renderings the memo keeps apart from any other's. */
  readonly userId: string;
  readonly counts: {
    evaluations: number;
    memoHits: number;
    renderQueries: number;
    siteRenders: number;
  };
  /** The components evaluated, by id: what a check of the memo counts. */
  readonly evaluatedBy: Map<string, number>;
  /** The components rendered so far, toward the limit. */
  instances: number;
}

/**
 * The memo's key for a component's rendering: the component, its props, its children and the other
 * nodes it is handed, the user and the build. Nodes are plain data: a JSON prop is never shaped as
 * one. Children not given are no `null` child: a component may tell the one from the other.
 */
export function memoKey(
  renderer: Renderer,
  component: string,
  instance: Pick<InstanceNode, 'children' | 'nodes' | 'props'>,
): string {
  const { children, nodes, props } = instance;
  const given = children === undefined ? [] : [children];
  return digest([component, props, given, nodes, renderer.userId, renderer.buildId]);
}

/**
 * The memo's rendering of `key` (`memoKey`), where it holds one: the render's call bound to the
 * request where what the rendering read was (`MemoEntry.requestBound`), as evaluating it again would
 * bind the call — no render takes a rendering of the request's from the memo as every visitor's.
 */
export function keptOf(renderer: Renderer, key: string): MemoEntry | undefined {
  const kept = renderer.memo.get(key);
  if (kept?.requestBound !== undefined) {
    renderer.scope.call.boundToRequest(kept.requestBound);
  }
  return kept;
}

/**
 * A site's functions: its guard, where it stands under conditions, and its render — or, for a list,
 * its items.
 */
export type SiteFunctions = Pick<SiteDescriptor, 'guard'> & SiteRendering<SiteInputs>;

/** The functions of each client part's sites, beside the part the memo keeps as plain data. */
const SITE_FUNCTIONS = new WeakMap<ClientOutput, Readonly<Record<string, SiteFunctions>>>();

/** The functions of the site `site` of `output`, of its inputs; none for a site it has not. */
export function siteFunctions(output: ClientOutput, site: string): SiteFunctions | undefined {
  const functions = SITE_FUNCTIONS.get(output);
  return functions !== undefined && Object.hasOwn(functions, site) ? functions[site] : undefined;
}

/**
 * The items each list of a client part shows at first, as its states' first values make them and
 * `sitesOf` checked them, beside the part the memo keeps: what a render renders of a list its view
 * does not name, its function run no more.
 */
const FIRST_ITEMS = new WeakMap<ClientOutput, ReadonlyMap<string, readonly CheckedItem[]>>();

/** Invalid first lists, whose requested overrides are chosen before an ancestor can refuse them. */
const INVALID_FIRST_ITEMS = new WeakMap<ClientOutput, ReadonlyMap<string, string>>();

/** A first list's original refusal, where no explicit child view replaced its initial choice. */
export function firstListFailure(output: ClientOutput): string | undefined {
  return INVALID_FIRST_ITEMS.get(output)?.values().next().value;
}

type InvalidList = (name: string, message: string) => void;

/** Silently invalid initial lists encountered so far, keeping their containing outputs out of the memo. */
const OMITTED_LISTS = new WeakMap<Renderer, number>();

/** The items of each list of `output` that shows at first, by its site. */
export function firstItems(output: ClientOutput): ReadonlyMap<string, readonly CheckedItem[]> {
  return FIRST_ITEMS.get(output) ?? new Map();
}

/**
 * Whether a site shows for `inputs`: its guard holds of them — the conditions it stands under, of
 * the local states they read, which the page sends with the site's own, and of the props and what
 * the server part computed now — or it stands under none. A page's view, or a binding, names a site
 * the conditions of which no longer hold where a parent's own condition changed: it shows nothing.
 */
export function siteShows(site: Pick<SiteDescriptor, 'guard'>, inputs: SiteInputs): boolean {
  return site.guard === undefined || Boolean(site.guard(inputs));
}

/** The program of `component`; a fault for one the authority does not run. */
function programOf(renderer: Renderer, component: string): ComponentProgram {
  const program = renderer.programs.get(component);
  if (program === undefined) {
    throw new Error(
      `A component renders ${component}, which the authority does not run: compile the application again.`,
    );
  }
  return program;
}

/**
 * Evaluates a component's program alone, with `props` and `children`, its reads noted in `track`
 * where given: what it answered, the components it renders not rendered. Its props are a copy of
 * the JSON it was rendered with; its children and its other nodes, the nodes themselves, which it
 * renders as they are.
 */
export async function evaluated(
  renderer: Renderer,
  program: ComponentProgram,
  instance: Pick<InstanceNode, 'children' | 'nodes' | 'props'>,
  track: Dependencies | undefined,
): Promise<unknown> {
  renderer.counts.evaluations += 1;
  const { component } = program;
  renderer.evaluatedBy.set(component, (renderer.evaluatedBy.get(component) ?? 0) + 1);
  const { call } = renderer.scope;
  const nodes = Object.fromEntries(
    Object.entries(instance.nodes).map(([name, node]) => [name, asGiven(node)]),
  );
  const props = Object.freeze({
    ...frozenJson(instance.props),
    ...nodes,
    ...(instance.children !== undefined && { children: asGiven(instance.children) }),
  });
  let answered: unknown;
  try {
    // What the program answers, though it be no promise: one it throws becomes the run's.
    const queried = (): void => {
      renderer.counts.renderQueries += 1;
    };
    answered = await call.run(renderEvaluation(renderer.scope, track, queried), () =>
      Promise.resolve(program.evaluate(props, SCOPE)),
    );
  } catch (error) {
    throw call.outcome(error);
  }
  // A component that caught a fault of its reads answered from what it was not answered: its
  // answer is the fault, and nothing keeps it.
  if (call.fault !== undefined) {
    throw call.fault.error;
  }
  return answered;
}

/** Whether `error` is a component's refusal of the session's access: it renders as nothing. */
export function isForbidden(error: unknown): boolean {
  return error instanceof AuthorityError && error.status === HTTP_FORBIDDEN;
}

/** Counts `instances` more components toward the render's limit. */
function counted(renderer: Renderer, instances: number): void {
  renderer.instances += instances;
  if (renderer.instances > MAX_INSTANCES) {
    throw new Error(`The page renders more than ${String(MAX_INSTANCES)} components.`);
  }
}

/** Where a component stands in what its parent rendered: its region, and its ordinal there. */
export interface Place {
  readonly region: string;
  readonly ordinal: number;
}

/**
 * Renders `node`, one reactive component of a tree, at `depth`, where it stands; what it read joins
 * `parent`.
 */
async function instanceOf(
  renderer: Renderer,
  node: InstanceNode,
  place: Place & { readonly depth: number },
  parent: Pick<Within, 'asView' | 'dependencies'>,
): Promise<SkeletonInstance> {
  const { depth, ordinal, region } = place;
  if (depth > MAX_DEPTH) {
    throw new Error(`Components render components more than ${String(MAX_DEPTH)} deep.`);
  }
  const { component, key, props } = node;
  const program = programOf(renderer, component);
  const at = {
    component,
    digest: shortDigest(props),
    key,
    kind: 'instance',
    ordinal,
    region,
  } as const;
  const memoized = memoKey(renderer, component, node);
  const kept = keptOf(renderer, memoized);
  if (kept !== undefined) {
    counted(renderer, kept.instances);
    renderer.counts.memoHits += 1;
    parent.dependencies.merge(kept.dependencies);
    return { ...at, output: kept.output };
  }
  counted(renderer, 1);
  const before = renderer.instances;
  // What it, and each component it renders, reads of the request from here on is kept with it.
  const { call } = renderer.scope;
  const mark = call.boundMark;
  const omitted = OMITTED_LISTS.get(renderer) ?? 0;
  const dependencies = new Dependencies();
  let output: Output;
  try {
    const answered = await evaluated(renderer, program, node, dependencies);
    output = await outputOf(renderer, program, answered, {
      asView: parent.asView,
      dependencies,
      depth,
    });
  } catch (error) {
    if (!isForbidden(error)) {
      // What it read before it threw is what a site's refusal of it follows, where a site a view
      // names holds it (`sites.ts`), the render going on around the site.
      parent.dependencies.merge(dependencies);
      throw error;
    }
    output = { kind: 'refused' };
  }
  // A list omitted only at first must be checked as a refusal beneath a requested parent later.
  if ((OMITTED_LISTS.get(renderer) ?? 0) === omitted) {
    renderer.memo.set(memoized, {
      dependencies,
      instances: renderer.instances - before + 1,
      output,
      requestBound: call.boundSince(mark),
    });
  }
  parent.dependencies.merge(dependencies);
  return { ...at, output };
}

/**
 * What runs a site's functions of a part's first values: beneath a site a view names, which renders
 * the part of the inputs the view sends, that site's — what they make of them its refusal.
 */
export type SiteRun = <T>(made: () => T) => T;

/**
 * Where a component's tree is rendered: what it read joins `dependencies`, at `depth` — beneath a
 * site a view names, the site functions of each part in it run as that site's (`asView`).
 */
export interface Within {
  readonly dependencies: Dependencies;
  readonly depth: number;
  readonly asView?: SiteRun | undefined;
}

/**
 * A region of what a component rendered, as it is rendered in order: its name, and how many
 * components of each id and key it holds so far — the ordinal of the next.
 */
export class Region {
  readonly #counts = new Map<string, number>();
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  /** The place of the next component of `component` and `key` in the region. */
  next(component: string, key: string | null): Place {
    const name = JSON.stringify([component, key]);
    const ordinal = this.#counts.get(name) ?? 0;
    this.#counts.set(name, ordinal + 1);
    return { ordinal, region: this.name };
  }
}

/** What a component answered, rendered: its client part, or its tree. */
async function outputOf(
  renderer: Renderer,
  program: ComponentProgram,
  answered: unknown,
  within: Within,
): Promise<Output> {
  if (!isDescriptor(answered)) {
    return {
      kind: 'tree',
      tree: await treeOf(renderer, rendered(answered), within, new Region('')),
    };
  }
  const slots: Record<string, Skeleton> = {};
  for (const [name, slot] of Object.entries(answered.slots)) {
    Object.defineProperty(slots, name, {
      enumerable: true,
      value: await treeOf(renderer, rendered(slot), within, new Region(name)),
    });
  }
  const states = statesOf(renderer, program, answered.states, within.dependencies);
  const functions: Readonly<Record<string, SiteFunctions>> = Object.fromEntries(
    Object.entries(answered.sites).map(([name, site]) => [name, functionsOf(site)]),
  );
  const first = new Map<string, readonly CheckedItem[]>();
  const invalid = new Map<string, string>();
  const client: ClientOutput = {
    kind: 'client',
    props: frozenJson(answered.props),
    sites: sitesOf(
      program,
      {
        asView: within.asView,
        first,
        functions,
        invalid: (name, message) => {
          invalid.set(name, message);
          OMITTED_LISTS.set(renderer, (OMITTED_LISTS.get(renderer) ?? 0) + 1);
        },
        sites: answered.sites,
      },
      states,
    ),
    slots,
    states,
  };
  SITE_FUNCTIONS.set(client, functions);
  FIRST_ITEMS.set(client, first);
  INVALID_FIRST_ITEMS.set(client, invalid);
  return client;
}

/**
 * A site's functions, as its part keeps them beside it: its guard, where it has one, and its render
 * or its items — each call of one held to what it may spend of its inputs (`withinSteps`).
 */
export function functionsOf(site: SiteDescriptor): SiteFunctions {
  const { guard } = site;
  const rendering: SiteRendering<SiteInputs> =
    site.each === undefined
      ? { render: (inputs) => withinSteps(() => site.render(inputs)) }
      : { each: (inputs) => withinSteps(() => site.each(inputs)) };
  return guard === undefined
    ? rendering
    : { ...rendering, guard: (inputs) => withinSteps(() => guard(inputs)) };
}

/** The kind of a JSON value, as `JsonKind` names it. */
export function kindOf(value: Json): JsonKind {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value as JsonKind;
}

/**
 * The items the list `name` shows of its first values `inputs`: those it holds, as a view's are held
 * to (`itemsOf`), none where it holds no item. One the authority starts beyond that — more items
 * than a site renders, a key twice — shows nothing at first, rather than fail the render of all
 * around it, and the view the page sends of it is refused (400) where the list stands.
 */
function firstListed(
  name: string,
  each: (inputs: SiteInputs) => readonly SiteItem[],
  inputs: SiteInputs,
  invalid: InvalidList,
): readonly CheckedItem[] | undefined {
  const items = itemsWithin(name, each, inputs, (message) => {
    invalid(name, message);
  });
  return items === undefined || items.length === 0 ? undefined : items;
}

/**
 * Whether the site `name` shows while every state holds its first value: its conditions (`guard`)
 * hold of the states' first values `values`, and a list holds an item of its own, `inputs`
 * (`firstListed`) — those items kept in `first`, which the render renders: its function runs once.
 * Beneath a site a view names, its functions run as that site's (`asView`).
 */
function showsAtFirst(
  name: string,
  own: SiteFunctions,
  {
    asView,
    first,
    invalid,
    inputs,
    values,
  }: {
    readonly asView: SiteRun | undefined;
    readonly first: Map<string, readonly CheckedItem[]>;
    readonly invalid: InvalidList;
    readonly inputs: SiteInputs;
    readonly values: SiteInputs;
  },
): boolean {
  const run: SiteRun = asView ?? ((made) => made());
  if (!run(() => siteShows(own, values))) {
    return false;
  }
  const { each } = own;
  if (each === undefined) {
    return true;
  }
  const items = run(() => firstListed(name, each, inputs, invalid));
  if (items !== undefined) {
    first.set(name, items);
  }
  return items !== undefined;
}

/**
 * What each dynamic site of a client part reads, and what it shows while every state holds its
 * first value: its inputs, of the local states the authority started — a field is no site's input
 * — and whether its conditions hold of the states' first values, and a list holds an item of them
 * (`showsAtFirst`): an empty one shows nothing. The items of a list that shows are kept in `first`.
 */
function sitesOf(
  program: ComponentProgram,
  {
    asView,
    first,
    functions,
    invalid,
    sites,
  }: {
    readonly asView: SiteRun | undefined;
    readonly first: Map<string, readonly CheckedItem[]>;
    readonly functions: Readonly<Record<string, SiteFunctions>>;
    readonly invalid: InvalidList;
    readonly sites: Readonly<Record<string, SiteDescriptor>>;
  },
  states: Readonly<Record<string, StateOrigin>>,
): Readonly<Record<string, SiteOutput>> {
  const values: Record<string, Json> = {};
  for (const [key, origin] of Object.entries(states)) {
    if ('value' in origin) {
      Object.defineProperty(values, key, { enumerable: true, value: origin.value });
    }
  }
  const outputs: Record<string, SiteOutput> = {};
  for (const [name, site] of Object.entries(sites)) {
    const kinds: Record<string, JsonKind> = {};
    const initial: Record<string, Json> = {};
    for (const input of site.inputs) {
      if (!Object.hasOwn(values, input)) {
        throw new Error(
          `The site ${name} of ${program.component} reads \`${input}\`, which is no local state the authority started: compile the application again.`,
        );
      }
      const value = values[input] as Json;
      Object.defineProperty(kinds, input, { enumerable: true, value: kindOf(value) });
      Object.defineProperty(initial, input, { enumerable: true, value });
    }
    const own = functions[name] ?? functionsOf(site);
    const inputs = Object.freeze(initial);
    const output: SiteOutput = {
      initial: showsAtFirst(name, own, { asView, first, inputs, invalid, values }) ? inputs : null,
      inputs: Object.freeze([...site.inputs]),
      kinds: Object.freeze(kinds),
    };
    Object.defineProperty(outputs, name, { enumerable: true, value: Object.freeze(output) });
  }
  return Object.freeze(outputs);
}

/**
 * Where each state of a component's client part comes from: a field reference binds the field —
 * one the database declares, of a record that may be — and anything else is the value a local
 * state starts from, which crosses to the browser as JSON. The record a field is of is read.
 */
function statesOf(
  renderer: Renderer,
  program: ComponentProgram,
  states: Readonly<Record<string, unknown>>,
  dependencies: Dependencies,
): Readonly<Record<string, StateOrigin>> {
  const origins: Record<string, StateOrigin> = {};
  for (const [key, state] of Object.entries(states)) {
    let origin: StateOrigin;
    if (isFieldRef(state)) {
      const table = renderer.definition.tables.get(state.table);
      if (
        table === undefined ||
        !Object.hasOwn(table.fields, state.field) ||
        !isRecordId(state.id)
      ) {
        throw new Error(
          `${program.component} binds \`${key}\` to ${state.table}/${state.id}.${state.field}, which the database does not declare.`,
        );
      }
      dependencies.record(state.table, state.id);
      origin = { field: { field: state.field, id: state.id, table: state.table } };
    } else if (isJson(state) && !isNode(state)) {
      origin = { value: frozenJson(state) };
    } else {
      throw new TypeError(
        `The state \`${key}\` of ${program.component} starts from a value that is not JSON, which no page could be sent.`,
      );
    }
    Object.defineProperty(origins, key, { enumerable: true, value: origin });
  }
  return origins;
}

/**
 * A tree a component rendered, each component in it rendered in turn, in order — the order a region
 * numbers them in: a list's items, an element's children and then its props, never the inside of a
 * component it renders, nor what that component is handed as its children.
 */
export async function treeOf(
  renderer: Renderer,
  child: Child,
  within: Within,
  region: Region,
): Promise<Skeleton> {
  if (Array.isArray(child)) {
    const items: Skeleton[] = [];
    for (const item of child as readonly Child[]) {
      items.push(await treeOf(renderer, item, within, region));
    }
    return items;
  }
  if (!isNode(child)) {
    return child as Skeleton;
  }
  switch (child.kind) {
    case 'instance': {
      const place = { ...region.next(child.component, child.key), depth: within.depth + 1 };
      return instanceOf(renderer, child, place, within);
    }
    case 'fragment': {
      const children = await treeOf(renderer, child.children, within, region);
      return { children: children as readonly Skeleton[], key: child.key, kind: 'fragment' };
    }
    case 'element':
    case 'module': {
      const children = (await treeOf(
        renderer,
        child.children,
        within,
        region,
      )) as readonly Skeleton[];
      const props: Record<string, SkeletonProp> = {};
      for (const [name, value] of Object.entries(child.props)) {
        const prop =
          isNode(value) || Array.isArray(value)
            ? await treeOf(renderer, value as Child, within, region)
            : value;
        Object.defineProperty(props, name, { enumerable: true, value: prop });
      }
      return { ...child, children, props };
    }
  }
}

/**
 * Renders a page's root — the component, with the props the page renders it with — and every
 * component its tree renders: the rendering, and every record and query it read.
 */
export async function renderRoot(
  renderer: Renderer,
  root: { readonly component: string; readonly props: Readonly<Record<string, Json>> },
): Promise<{ readonly root: SkeletonInstance; readonly dependencies: Dependencies }> {
  const dependencies = new Dependencies();
  const node: InstanceNode = {
    children: undefined,
    component: root.component,
    key: null,
    kind: 'instance',
    nodes: {},
    props: root.props,
  };
  const place = { depth: 0, ordinal: 0, region: '' };
  return { dependencies, root: await instanceOf(renderer, node, place, { dependencies }) };
}

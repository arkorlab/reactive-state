import {
  type ActionRef,
  type ClientDescriptor,
  type ComponentRef,
  FRAGMENT,
  type Json,
  type ModuleRef,
  REFERENCE,
  type RenderedAction,
  type RenderedNode,
  type RenderScope,
  type StateInputs,
} from '../program.ts';
import { carried, isCarriedJson, isJson } from './canonical.ts';
import { counted, member, method } from './steps.ts';

/**
 * What a component's program renders with (`$`), and what it makes: the elements of its JSX, as
 * plain data the authority reads, each reactive component it renders as an instance the authority
 * renders in turn. Nothing here runs the application's code, and nothing of a node is a function:
 * a prop that is one — a handler, which a component the server renders cannot hand on — is a
 * fault, as React's own would be.
 */

/** A prop's value: JSON, an action, or what renders — an element, a list of children. */
type PropValue = Child | Json | RenderedAction;

interface ElementNode {
  readonly kind: 'element';
  readonly type: string;
  readonly key: string | null;
  readonly props: Readonly<Record<string, PropValue>>;
  readonly children: readonly Child[];
}

interface ModuleNode {
  readonly kind: 'module';
  readonly module: string;
  readonly name: string;
  readonly key: string | null;
  readonly props: Readonly<Record<string, PropValue>>;
  readonly children: readonly Child[];
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly key: string | null;
  readonly children: readonly Child[];
}

/**
 * A reactive component, rendered with `props`: the authority renders it in turn. What the element
 * holds between its tags is its `children`, as React's `createElement` hands them on — none, the one
 * child, or the list of them — which the component renders where it puts `{children}`.
 */
export interface InstanceNode {
  readonly kind: 'instance';
  readonly component: string;
  readonly key: string | null;
  readonly props: Readonly<Record<string, Json>>;
  /** What it is handed between its tags, as React hands it: none, where it was handed none. */
  readonly children: GivenChild | undefined;
  /**
   * The props other than `children` it is handed nodes by (`<Card header={<Heading />} />`), as
   * they are: rendered where it puts them, as its children are.
   */
  readonly nodes: Readonly<Record<string, GivenChild>>;
}

export type Node = ElementNode | FragmentNode | InstanceNode | ModuleNode;

/** What renders: a node, text, a number, nothing (`null`, a boolean), or a list of them. */
export type Child = Node | boolean | number | string | null | readonly Child[];

/**
 * An `undefined` a reactive component is handed as a child — `<Wrapper>{maybe}</Wrapper>` — which
 * React hands it as it is, where a rendered tree shows nothing for it, as for `null`: kept apart
 * from `null` for the component, and for the memo's key, until the component is evaluated.
 */
const UNDEFINED_CHILD: Readonly<{ undefined: true }> = Object.freeze({ undefined: true });

/** What a reactive component is handed: what renders, an `undefined` among it too. */
type GivenChild = Child | typeof UNDEFINED_CHILD | readonly GivenChild[];

/** What a component is handed, as its program reads it: `UNDEFINED_CHILD` an `undefined` again. */
export function asGiven(child: GivenChild): unknown {
  if (child === UNDEFINED_CHILD) {
    return undefined;
  }
  return Array.isArray(child)
    ? Object.freeze((child as readonly GivenChild[]).map((item) => asGiven(item)))
    : child;
}

/** How deeply a prop's value is looked into for a node: as deeply as JSON may nest. */
const MAX_DEPTH = 64;

/** The nodes `$.h` made, and the client parts `$.client` did: nothing else is taken for one. */
const NODES = new WeakSet();
const DESCRIPTORS = new WeakSet();

/**
 * What no JSON a prop holds may be shaped as: what the host reads a prop's object as — an element,
 * an action — would be read in its place.
 */
const RENDERED_KINDS: ReadonlySet<string> = new Set([
  'action',
  'client',
  'client-part',
  'element',
  'fragment',
  'instance',
  'module',
]);

export function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && NODES.has(value);
}

export function isDescriptor(value: unknown): value is ClientDescriptor {
  return typeof value === 'object' && value !== null && DESCRIPTORS.has(value);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is a reference a compile made (`REFERENCE`), and not JSON shaped as one. */
function isReference(value: unknown): value is Readonly<Record<string, unknown>> {
  return isObject(value) && (value as { readonly [REFERENCE]?: unknown })[REFERENCE] === true;
}

function isComponentRef(value: unknown): value is ComponentRef {
  return (
    isReference(value) && value['kind'] === 'component' && typeof value['component'] === 'string'
  );
}

function isModuleRef(value: unknown): value is ModuleRef {
  return (
    isReference(value) &&
    value['kind'] === 'module' &&
    typeof value['module'] === 'string' &&
    typeof value['name'] === 'string'
  );
}

function isActionRef(value: unknown): value is ActionRef {
  return (
    isReference(value) &&
    value['kind'] === 'action' &&
    typeof value['module'] === 'string' &&
    typeof value['name'] === 'string' &&
    Array.isArray(value['bound'])
  );
}

/**
 * Whether `value` holds a node anywhere in it: a node is a plain object of JSON itself, which only
 * this tells from JSON a prop holds. An object is looked in again only where it is reached shallower
 * than it was looked in at (`looked`): from there it is looked in as deep as may be, where reached
 * deeper first it was looked in less deep. Looked in each way it is reached, one that holds itself
 * twice would be looked in twice as often at each depth, before what follows could refuse it as no
 * JSON; so, each object is looked in at most once at each depth, and what holds itself once.
 */
function holdsNode(value: unknown, depth = 0, looked?: Map<WeakKey, number>): boolean {
  if (isNode(value)) {
    return true;
  }
  if (typeof value !== 'object' || value === null || depth >= MAX_DEPTH) {
    return false;
  }
  const shallowest = looked?.get(value);
  if (shallowest !== undefined && shallowest <= depth) {
    return false;
  }
  // Made as the first object is looked in: none for the text and numbers most props are.
  const depths = looked ?? new Map<WeakKey, number>();
  depths.set(value, depth);
  return Object.values(value).some((item) => holdsNode(item, depth + 1, depths));
}

/**
 * Whether `value` holds a reference anywhere in it — a field's, a module's export, a component —
 * which JSON would carry as the data it is shaped as, and no longer as the reference; each object
 * looked in once, what holds itself too.
 */
function holdsReference(value: unknown, depth = 0, seen = new Set<WeakKey>()): boolean {
  if (isReference(value)) {
    return true;
  }
  if (typeof value !== 'object' || value === null || depth >= MAX_DEPTH || seen.has(value)) {
    return false;
  }
  seen.add(value);
  return Object.values(value).some((item) => holdsReference(item, depth + 1, seen));
}

/** Refuses JSON shaped as something rendered, at any depth. */
function unambiguous(name: string, value: Json): Json {
  if (Array.isArray(value)) {
    for (const item of value as readonly Json[]) {
      unambiguous(name, item);
    }
  } else if (isObject(value)) {
    const { kind } = value;
    if (typeof kind === 'string' && RENDERED_KINDS.has(kind)) {
      throw new TypeError(
        `The prop \`${name}\` holds an object whose \`kind\` is \`${kind}\`, which reads as something rendered.`,
      );
    }
    for (const item of Object.values(value)) {
      unambiguous(name, item);
    }
  }
  return value;
}

/** Whether `value` renders as it is: text, a number, a boolean, nothing, or a node. */
function isLeaf(value: unknown): value is Child {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    isNode(value)
  );
}

/**
 * What `each` makes of each element of `list`, by its positions — as React reads a list of children
 * — in a frozen array of the language's own: never through a `map` the list holds, nor one of the
 * kind its constructor makes (`Symbol.species`), either of which is the application's code. As many
 * positions are read as it held as it was first read, as `map` reads them: what reading one adds to
 * it is not read, and a list that adds one at each read ends. A hole is kept a hole, as `map` keeps
 * one, its prototype not consulted for it.
 */
function positionally<T>(list: readonly unknown[], each: (item: unknown) => T): readonly T[] {
  const { length } = list;
  const items: T[] = [];
  items.length = length;
  for (let index = 0; index < length; index += 1) {
    if (Object.hasOwn(list, index)) {
      items[index] = each(list[index]);
    }
  }
  return Object.freeze(items);
}

/** What a reactive component is handed, as the tree keeps it: an `undefined` kept apart. */
function givenChildOf(value: unknown): GivenChild {
  let given: GivenChild;
  if (value === undefined) {
    given = UNDEFINED_CHILD;
  } else if (Array.isArray(value)) {
    given = positionally(value as readonly unknown[], (item) => givenChildOf(item));
  } else {
    given = childOf(value);
  }
  return given;
}

/** A child as the tree keeps it: what renders, or a fault for anything else. */
function childOf(value: unknown): Child {
  let child: Child;
  if (value === undefined) {
    child = null;
  } else if (isLeaf(value)) {
    child = value;
  } else if (Array.isArray(value)) {
    child = positionally(value as readonly unknown[], (item) => childOf(item));
  } else {
    throw new TypeError(
      'A component rendered what no child is: text, a number, an element, or a list of them.',
    );
  }
  return child;
}

function propOf(name: string, value: unknown): PropValue {
  if (typeof value === 'function') {
    throw new TypeError(
      `The prop \`${name}\` is a function, which a component the server renders cannot hand on: render it in a component with states, or make it a server operation.`,
    );
  }
  let prop: PropValue;
  if (isActionRef(value)) {
    if (!isCarriedJson(value.bound)) {
      throw new TypeError(`The action of \`${name}\` is bound to arguments that are not JSON.`);
    }
    const action: RenderedAction = {
      bound: carried(value.bound) as readonly Json[],
      kind: 'action',
      module: value.module,
      name: value.name,
    };
    prop = Object.freeze(action);
  } else if (isNode(value) || (Array.isArray(value) && holdsNode(value))) {
    prop = childOf(value);
  } else if (isCarriedJson(value) && !holdsNode(value)) {
    // As JSON carries it — an `undefined` property left out, a hole `null`, `-0` `0` — whichever
    // host answers: an HTTP answer is JSON, and a Durable Object's RPC would keep each as it is.
    prop = unambiguous(name, carried(value));
  } else {
    throw new TypeError(`The prop \`${name}\` is neither JSON, an element, nor an action.`);
  }
  return prop;
}

function keyOf(key: unknown): string | null {
  if (key === undefined || key === null) {
    return null;
  }
  if (typeof key === 'string' || (typeof key === 'number' && Number.isFinite(key))) {
    return String(key);
  }
  throw new TypeError('A key is text or a number.');
}

/** An element's props as the tree keeps them: `key` and `children` are not props of it. */
function propsOf(given: Readonly<Record<string, unknown>>): Readonly<Record<string, PropValue>> {
  const props: Record<string, PropValue> = {};
  for (const [name, value] of Object.entries(given)) {
    if (name !== 'key' && name !== 'children' && value !== undefined) {
      Object.defineProperty(props, name, { enumerable: true, value: propOf(name, value) });
    }
  }
  return Object.freeze(props);
}

/**
 * A reactive component's props: JSON, which it is rendered and keyed by, and apart from it the
 * props it is handed nodes by, but `children` — a node, or a list of what a child is — which it
 * renders where it puts them, and is keyed by too.
 */
function instancePropsOf(
  component: string,
  given: Readonly<Record<string, unknown>>,
): Pick<InstanceNode, 'nodes' | 'props'> {
  const props: Record<string, Json> = {};
  const nodes: Record<string, GivenChild> = {};
  for (const [name, value] of Object.entries(given)) {
    if (name === 'key' || name === 'children' || value === undefined) {
      continue;
    }
    if (holdsNode(value)) {
      Object.defineProperty(nodes, name, { enumerable: true, value: givenChildOf(value) });
      continue;
    }
    // Its props are keyed as JSON, which would key a reference and JSON shaped as one alike: a
    // reference is told as what it is, before what else no JSON holds.
    if (holdsReference(value)) {
      throw new TypeError(
        `The prop \`${name}\` of ${component} holds a reference, which is no JSON: hand it the record's id, and let it take a field's reference from \`db\` itself.`,
      );
    }
    if (!isJson(value)) {
      throw new TypeError(
        `The prop \`${name}\` of ${component} is not JSON: a reactive component is rendered with JSON props, and with nodes, alone.`,
      );
    }
    Object.defineProperty(props, name, { enumerable: true, value });
  }
  return { nodes: Object.freeze(nodes), props: Object.freeze(props) };
}

function made(node: Node): RenderedNode {
  Object.freeze(node);
  NODES.add(node);
  return node as RenderedNode;
}

function h(
  type: ComponentRef | ModuleRef | string,
  props: Readonly<Record<string, unknown>> | null,
  ...children: readonly unknown[]
): RenderedNode {
  const given = props ?? {};
  const key = keyOf(given['key']);
  // As React's `createElement` takes them: the children written in the element, or else those its
  // props hold, as a spread of an object gives them — an `undefined` they hold too, which React
  // hands on as it is.
  const supplied =
    children.length > 0 || !Object.hasOwn(given, 'children') ? children : [given['children']];
  if (isComponentRef(type)) {
    let held: GivenChild | undefined;
    if (supplied.length === 1) {
      held = givenChildOf(supplied[0]);
    } else if (supplied.length > 1) {
      held = Object.freeze(supplied.map((child) => givenChildOf(child)));
    }
    return made({
      children: held,
      component: type.component,
      key,
      kind: 'instance',
      ...instancePropsOf(type.component, given),
    });
  }
  const inside = Object.freeze(supplied.map((child) => childOf(child)));
  if (type === FRAGMENT) {
    return made({ children: inside, key, kind: 'fragment' });
  }
  if (typeof type === 'string') {
    return made({ children: inside, key, kind: 'element', props: propsOf(given), type });
  }
  if (isModuleRef(type)) {
    return made({
      children: inside,
      key,
      kind: 'module',
      module: type.module,
      name: type.name,
      props: propsOf(given),
    });
  }
  throw new TypeError('An element is of a tag, a module’s export, or a reactive component.');
}

/**
 * Whether `value` is a dynamic site as a compile writes one: its inputs' names, and its functions —
 * its render, or a list's items (`each`), never both.
 */
function isSite(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  const { each, guard, inputs, render } = value;
  return (
    Array.isArray(inputs) &&
    (inputs as readonly unknown[]).every((input) => typeof input === 'string') &&
    (guard === undefined || typeof guard === 'function') &&
    (typeof render === 'function') !== (typeof each === 'function') &&
    (render === undefined || each === undefined)
  );
}

function client<S extends StateInputs>(part: {
  readonly props: Readonly<Record<string, Json>>;
  readonly states: S;
  readonly slots: Readonly<Record<string, unknown>>;
  readonly sites?: ClientDescriptor<S>['sites'];
}): ClientDescriptor<S> {
  const { props, slots, states } = part;
  const sites = part.sites ?? {};
  if (
    !isObject(props) ||
    !isJson(props) ||
    holdsNode(props) ||
    !isObject(states) ||
    !isObject(slots) ||
    !isObject(sites) ||
    Object.values(sites).some((site) => !isSite(site))
  ) {
    throw new TypeError(
      'A client part is `{ props, states, slots, sites? }`: JSON props, objects of states and of slots, and sites of `{ inputs, guard?, render }` or `{ inputs, guard?, each }`.',
    );
  }
  const descriptor: ClientDescriptor<S> = Object.freeze({
    kind: 'client-part',
    props,
    sites,
    slots,
    states,
  });
  DESCRIPTORS.add(descriptor);
  return descriptor;
}

/** What every program renders with: one scope, which holds nothing of any one component. */
export const SCOPE: RenderScope = Object.freeze({
  client,
  counted,
  fragment: FRAGMENT,
  h,
  member,
  method,
});

/** A child of what a component rendered, as its slot or its output names it: checked as a child. */
export function rendered(value: unknown): Child {
  return childOf(value);
}

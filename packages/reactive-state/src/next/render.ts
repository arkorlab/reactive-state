import { type ComponentType, type ElementType, Fragment, type ReactNode } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';

import type {
  ClientPart,
  Rendered,
  RenderedAction,
  RenderedClient,
  RenderedElement,
  RenderedFragment,
  RenderedItem,
  RenderedModule,
  RenderedProp,
  RenderedSite,
} from '../program.ts';
import type { ClientPartProps } from '../react/state.ts';
import type { SessionSource } from './authority.ts';

/**
 * Turns the tree the authority rendered (`Rendered`) into React elements, with the import map a
 * compile writes (`<out>/elements.ts`): a module's export by `"<specifier>#<export>"`, a compiled
 * Client Component by its component's id, and a `'use server'` module's Server Function by
 * `"<module id>#<name>"`. Generic: nothing here knows one application's components from another's.
 * Keys are kept where the authority kept them, so React keeps what each element holds — a list's
 * rows by their ids — when the tree is rendered again, by the route or for another view.
 */

/** What a compile's `<out>/elements.ts` exports: what the authority's tree names, by name. */
export interface Elements {
  /** The compile's build, which the authority renders the tree for. */
  readonly build: string;
  readonly modules: Readonly<Record<string, ElementType>>;
  readonly clients: Readonly<Record<string, ComponentType<ClientPartProps>>>;
  readonly actions: Readonly<Record<string, (...args: never[]) => unknown>>;
  /**
   * How the application reads its own signed-in session, where it signs its users in itself
   * (`SessionSource`): the compile's re-export of the application's (`<out>/request-session.ts`).
   * Without it, a session is the demo's the cookie names.
   */
  readonly session?: SessionSource;
}

type Node = RenderedClient | RenderedElement | RenderedFragment | RenderedModule;

/** What a node of the tree is, as `kind` says. */
const NODE_KINDS: ReadonlySet<unknown> = new Set(['client', 'element', 'fragment', 'module']);

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    NODE_KINDS.has((value as { readonly kind?: unknown }).kind)
  );
}

function isAction(value: unknown): value is RenderedAction {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { bound, kind, module, name } = value as Partial<Record<string, unknown>>;
  return (
    kind === 'action' &&
    typeof module === 'string' &&
    typeof name === 'string' &&
    Array.isArray(bound)
  );
}

/** The entry `name` of an import map, which a compile wrote for every name its tree may hold. */
function lookup<T>(table: Readonly<Record<string, T>>, name: string, what: string): T {
  if (!Object.hasOwn(table, name)) {
    throw new Error(
      `The compile's elements have no ${what} ${name}, which the authority rendered: compile the application again.`,
    );
  }
  return table[name] as T;
}

/** An action's Server Function, bound to the arguments the component bound it to. */
function actionOf(action: RenderedAction, elements: Elements): unknown {
  /** A Server Function, as `Function.prototype.bind` binds it — React's own `bind`, on its stub. */
  type Bindable = (...args: unknown[]) => unknown;

  const stub = lookup(elements.actions, `${action.module}#${action.name}`, 'action') as Bindable;
  return action.bound.length === 0 ? stub : stub.bind(null, ...action.bound);
}

/**
 * A prop's value: JSON as it is, a rendered element as one, an action as its Server Function. Of a
 * prop the authority named (`nested`: an action stands in an object or an array of it) the walk goes
 * into both, copying each only where something in it changed; any other prop is handed on as it is.
 *
 * @returns What the prop is rendered with.
 */
function propValue(value: RenderedProp, elements: Elements, nested = false): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return nested
      ? changing(value, elements)
      : value.map((item: RenderedProp) => propValue(item, elements));
  }
  if (isAction(value)) {
    return actionOf(value, elements);
  }
  if (isNode(value)) {
    return toNode(value, elements);
  }
  return nested ? fieldsValue(value as Readonly<Record<string, unknown>>, elements) : value;
}

/** A list's items, each as `propValue` has it of a nested prop: the list itself where none changes. */
function changing(value: readonly RenderedProp[], elements: Elements): unknown {
  let copy: unknown[] | undefined;
  for (const [index, item] of value.entries()) {
    const handed = propValue(item, elements, true);
    if (copy === undefined && handed !== item) {
      copy = value.slice(0, index);
    }
    copy?.push(handed);
  }
  return copy ?? value;
}

/** An object's fields, each as `propValue` has it of a nested prop: the object itself where none changes. */
function fieldsValue(value: Readonly<Record<string, unknown>>, elements: Elements): unknown {
  let copy: Record<string, unknown> | undefined;
  for (const [name, field] of Object.entries(value)) {
    const handed = propValue(field as RenderedProp, elements, true);
    if (copy === undefined && handed !== field) {
      copy = {};
      for (const [before, kept] of Object.entries(value)) {
        if (before === name) {
          break;
        }
        own(copy, before, kept);
      }
    }
    if (copy !== undefined) {
      own(copy, name, handed);
    }
  }
  return copy ?? value;
}

/** Makes `name` a property of `target`'s own, though it be `__proto__`, which an assignment sets. */
function own(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** An element's props; `children` and the key are its own, never a prop's. */
function propsOf(
  rendered: RenderedElement | RenderedModule,
  elements: Elements,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rendered.props)) {
    if (name !== 'children' && name !== 'key') {
      own(props, name, propValue(value, elements, rendered.nested?.includes(name) === true));
    }
  }
  return props;
}

/**
 * An element of `type`, as JSX makes one: `props` are its props as they are, its children among
 * them, where `createElement` would copy them by assignment — and make a `__proto__` among them the
 * copy's prototype.
 */
function elementOf(
  type: ElementType,
  props: Record<string, unknown>,
  key: string | null,
  children: readonly ReactNode[] = [],
): ReactNode {
  if (children.length > 0) {
    own(props, 'children', children.length === 1 ? children[0] : children);
  }
  // More than one child is the element's own list, written in it, as `createElement`'s arguments
  // are: what a list a child is holds is keyed, and these need no key.
  const make = children.length > 1 ? jsxs : jsx;
  return key === null ? make(type, props) : make(type, props, key);
}

function childrenOf(
  rendered: Node & { readonly children: readonly Rendered[] },
  elements: Elements,
): ReactNode[] {
  return rendered.children.map((child) => renderTree(child, elements));
}

/** An item of a list site, its content rendered, beside its key and the item. */
function itemOf({ content, item, key }: RenderedItem, elements: Elements): RenderedItem<ReactNode> {
  return { content: renderTree(content, elements), item, key };
}

/** A site's content rendered — a list's, each item's — or its refusal, beside its inputs. */
function siteOf(site: RenderedSite, elements: Elements): RenderedSite<ReactNode> {
  const { inputs } = site;
  if (site.refused !== undefined) {
    return { inputs, refused: site.refused };
  }
  if (site.items === undefined) {
    return { content: renderTree(site.content, elements), inputs };
  }
  return { inputs, items: site.items.map((each) => itemOf(each, elements)) };
}

/**
 * A part's dynamic sites: each one's content rendered — a list's, each item's, beside its key and
 * the item — beside the inputs it was rendered for.
 */
function sitesOf(
  sites: Readonly<Record<string, RenderedSite>>,
  elements: Elements,
): Record<string, RenderedSite<ReactNode>> {
  const rendered: Record<string, unknown> = {};
  for (const [id, site] of Object.entries(sites)) {
    own(rendered, id, siteOf(site, elements));
  }
  return rendered as Record<string, RenderedSite<ReactNode>>;
}

/**
 * A compiled Client Component, given its part: its slots rendered, and — for a part with dynamic
 * sites — its instance, which the page's view names it by, and each site's content rendered beside
 * the inputs it was rendered for.
 */
function clientOf(rendered: RenderedClient, elements: Elements): ReactNode {
  const Client = lookup(elements.clients, rendered.component, 'client component');
  const { instance, props, reads, sites, slots, states } = rendered.part;
  const part: ClientPart<ReactNode> = {
    ...(instance !== undefined && { instance }),
    props,
    ...(reads !== undefined && { reads }),
    ...(sites !== undefined && { sites: sitesOf(sites, elements) }),
    slots: Object.fromEntries(
      Object.entries(slots).map(([name, slot]) => [name, renderTree(slot, elements)]),
    ),
    states,
  };
  return elementOf(Client, { part }, rendered.key);
}

/**
 * One node of the tree, as React renders it.
 *
 * @returns The node's element: `clientOf` renders a client part as one too.
 */
function toNode(rendered: Node, elements: Elements): ReactNode {
  switch (rendered.kind) {
    case 'client': {
      return clientOf(rendered, elements);
    }
    case 'element': {
      // A tag is any name React renders — a custom element's too, which `ElementType` does not list.
      const tag = rendered.type as ElementType;
      return elementOf(
        tag,
        propsOf(rendered, elements),
        rendered.key,
        childrenOf(rendered, elements),
      );
    }
    case 'fragment': {
      return elementOf(Fragment, {}, rendered.key, childrenOf(rendered, elements));
    }
    case 'module': {
      const type = lookup(elements.modules, `${rendered.module}#${rendered.name}`, 'module');
      return elementOf(
        type,
        propsOf(rendered, elements),
        rendered.key,
        childrenOf(rendered, elements),
      );
    }
    default: {
      throw new TypeError(
        `The authority rendered a node of kind ${String((rendered as { readonly kind?: unknown }).kind)}, which no host renders.`,
      );
    }
  }
}

/**
 * The React elements of a tree the authority rendered. Text and numbers render as they are; `null`,
 * `true` and `false` render nothing; a list stays a list, whose elements keep their keys.
 *
 * @returns The tree, as React renders it.
 */
export function renderTree(tree: Rendered, elements: Elements): ReactNode {
  if (tree === null || typeof tree === 'boolean') {
    return null;
  }
  if (typeof tree === 'string' || typeof tree === 'number') {
    return tree;
  }
  if (Array.isArray(tree)) {
    return tree.map((child: Rendered) => renderTree(child, elements));
  }
  return toNode(tree as Node, elements);
}

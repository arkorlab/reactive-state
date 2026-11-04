import {
  type ClientPart,
  type ComponentProgram,
  fieldKey,
  type Rendered,
  type RenderedItem,
  type RenderedProp,
  type RenderedSite,
  type StateSource,
  type Value,
} from '../program.ts';
import { keyTag } from './canonical.ts';
import {
  type BoundField,
  type ClientOutput,
  isSiteStep,
  type ShownSite,
  type SiteStep,
  type Skeleton,
  type SkeletonInstance,
  type Step,
  stepOf,
} from './skeleton.ts';
import type { Tables } from './tables.ts';

/**
 * A session's render of a page, made of what its components rendered (`Skeleton`): the tree the
 * host renders, with each persistent state's field named by its key and, where the component has a
 * setter for it, the binding the setter writes with — signed for the session, the page's root and
 * the path from it to the component: each component where it stands, each dynamic site on the way
 * with the inputs it was rendered with — and the key of the item of a list — and the component's
 * own props' digest — and the value of every field the tree binds, read now. A part with sites is
 * named by its instance id, and holds what each site its view shows rendered.
 */

export interface Assembly {
  readonly tree: Rendered;
  /** Every bound field's value, by `fieldKey`. */
  readonly fields: Readonly<Record<string, Value>>;
}

export interface Assembler {
  readonly programs: ReadonlyMap<string, ComponentProgram>;
  readonly tables: Tables;
  /**
   * Signs the binding of the state `key` of the component at `path` (from the root, the root's
   * own steps left out; the last component step holding the component's props' digest), bound to
   * `field`; none where a render issues no binding — one a page's event stream reads only to
   * compare.
   */
  readonly bind: ((path: readonly Step[], key: string, field: BoundField) => string) | undefined;
}

/** The registered `set` of a state: the one its setter writes a value it is handed with. */
function setOf(program: ComponentProgram, key: string): string | undefined {
  return Object.entries(program.updaters).find(
    ([, updater]) => updater.kind === 'set' && updater.keys.includes(key),
  )?.[0];
}

/** What a prop's value is, or a child's, where it is something rendered: an element, a component. */
const RENDERED_KINDS: ReadonlySet<unknown> = new Set(['element', 'fragment', 'instance', 'module']);

/** Whether a prop's value is something rendered — an element, a list — rather than JSON or an action. */
function isRendered(value: unknown): boolean {
  if (Array.isArray(value)) {
    return true;
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    RENDERED_KINDS.has((value as { readonly kind?: unknown }).kind)
  );
}

/** A skeleton's node, as its kind says what it is. */
type SkeletonNode = Exclude<Skeleton, readonly Skeleton[] | boolean | number | string | null>;

/**
 * `path` as a binding names it: each key by a digest of it (`keyTag`), and the component at its end
 * pinned by its props' digest — whatever the components before it are rendered with now, the one
 * whose state a binding writes is the one it was issued for.
 */
function pinned(path: readonly Step[], digest: string): readonly Step[] {
  const tagged = path.map((step): Step => {
    if (isSiteStep(step)) {
      return step.k === undefined ? step : { ...step, k: keyTag(step.k) };
    }
    return { ...step, k: keyTag(step.k) };
  });
  const last = tagged.at(-1);
  return last === undefined || isSiteStep(last)
    ? tagged
    : [...tagged.slice(0, -1), { ...last, p: digest }];
}

/** What a field holds now: what its record keeps, or the field's default where there is none. */
function valueOf(tables: Tables, { field, id, table }: BoundField): Value {
  const held = tables.get(table, id)?.[field];
  return held ?? tables.table(table).fields[field]?.default ?? false;
}

class Assembling {
  readonly #assembler: Assembler;
  readonly fields: Record<string, Value> = {};

  constructor(assembler: Assembler) {
    this.#assembler = assembler;
  }

  /**
   * A persistent state: its field's key — the field's value read into the render — and, where the
   * component has a setter for the state, the binding it writes with and its registered `set`.
   */
  #state(
    program: ComponentProgram | undefined,
    at: { readonly path: readonly Step[]; readonly digest: string },
    key: string,
    field: BoundField,
  ): StateSource {
    const name = fieldKey(field);
    this.fields[name] = valueOf(this.#assembler.tables, field);
    if (program?.writable.includes(key) !== true) {
      return { field: name };
    }
    const set = setOf(program, key);
    const binding = this.#assembler.bind?.(pinned(at.path, at.digest), key, field);
    return {
      field: name,
      ...(binding !== undefined && { binding }),
      ...(set !== undefined && { set }),
    };
  }

  #element(node: SkeletonNode, path: readonly Step[]): Rendered {
    let rendered: Rendered;
    switch (node.kind) {
      case 'instance': {
        rendered = this.instance(node, [...path, stepOf(node)]);
        break;
      }
      case 'fragment': {
        rendered = { ...node, children: node.children.map((child) => this.node(child, path)) };
        break;
      }
      case 'element':
      case 'module': {
        const props: Record<string, RenderedProp> = {};
        for (const [name, value] of Object.entries(node.props)) {
          const prop = isRendered(value)
            ? this.node(value as Skeleton, path)
            : (value as RenderedProp);
          Object.defineProperty(props, name, { enumerable: true, value: prop });
        }
        const children = node.children.map((child) => this.node(child, path));
        rendered = { ...node, children, props };
        break;
      }
    }
    return rendered;
  }

  /** The site `name` a part at `path` shows: its rendering, or each item's, under a step of its own. */
  #site(name: string, site: ShownSite, path: readonly Step[]): RenderedSite {
    const { inputs } = site;
    if (site.refused !== undefined) {
      return { inputs, refused: site.refused };
    }
    const step: SiteStep = { i: inputs, s: name };
    if (site.items === undefined) {
      return { content: this.node(site.content, [...path, step]), inputs };
    }
    const items: RenderedItem[] = [];
    for (const { content, item, key } of site.items) {
      items.push({ content: this.node(content, [...path, { ...step, k: key }]), item, key });
    }
    return { inputs, items };
  }

  node(skeleton: Skeleton, path: readonly Step[]): Rendered {
    let rendered: Rendered;
    if (Array.isArray(skeleton)) {
      rendered = (skeleton as readonly Skeleton[]).map((item) => this.node(item, path));
    } else if (isRendered(skeleton)) {
      rendered = this.#element(skeleton as SkeletonNode, path);
    } else {
      // Text, a number, nothing — and JSON a list a prop holds has among what it renders.
      rendered = skeleton as Rendered;
    }
    return rendered;
  }

  /** A component, at `path`: what it rendered, under the key it was rendered with. */
  instance(instance: SkeletonInstance, path: readonly Step[]): Rendered {
    const { component, digest, key, output } = instance;
    switch (output.kind) {
      case 'refused': {
        return null;
      }
      case 'tree': {
        return { children: [this.node(output.tree, path)], key, kind: 'fragment' };
      }
      case 'client': {
        const program = this.#assembler.programs.get(component);
        const states: Record<string, StateSource> = {};
        for (const [name, origin] of Object.entries(output.states)) {
          const state =
            'value' in origin
              ? { value: origin.value }
              : this.#state(program, { digest, path }, name, origin.field);
          Object.defineProperty(states, name, { enumerable: true, value: state });
        }
        const slots: Record<string, Rendered> = {};
        for (const [name, slot] of Object.entries(output.slots)) {
          Object.defineProperty(slots, name, { enumerable: true, value: this.node(slot, path) });
        }
        const part: ClientPart = { props: output.props, slots, states };
        if (output.instance === undefined) {
          return { component, key, kind: 'client', part };
        }
        const sites: Record<string, RenderedSite> = {};
        const shown = output.shown ?? {};
        for (const [name, site] of Object.entries(shown)) {
          Object.defineProperty(sites, name, {
            enumerable: true,
            value: this.#site(name, site, path),
          });
        }
        const reads = readsOf(output);
        return {
          component,
          key,
          kind: 'client',
          part: {
            ...part,
            instance: output.instance,
            ...(reads.length > 0 && { reads }),
            sites,
          },
        };
      }
    }
  }
}

/**
 * The states the sites of a part and their conditions read, by key, in order: of those the page
 * set, a view that names the part sends the values (`SET_STATES`).
 */
function readsOf(output: ClientOutput): readonly string[] {
  const reads = new Set<string>();
  for (const site of Object.values(output.sites)) {
    for (const name of site.inputs) {
      reads.add(name);
    }
  }
  return [...reads].toSorted((one, other) => one.localeCompare(other));
}

/** The session's render of the root's rendering, and the value of every field it binds. */
export function assemble(assembler: Assembler, root: SkeletonInstance): Assembly {
  const assembling = new Assembling(assembler);
  // The root's own steps are the binding's `root`, and no step of its path.
  const tree = assembling.instance(root, []);
  return { fields: assembling.fields, tree };
}

import type { Json, RenderedAction, SiteInputs, SiteRefusal } from '../program.ts';

/**
 * A page's components as the authority rendered them, before a session's render is made of them:
 * the tree each rendered, every component in it kept as itself — its id, its key, where it stands
 * in what its parent rendered, and its props' digest, which a binding's path names — and each
 * persistent state as the field it binds, with neither the field's value nor a binding. What one
 * user's render of a component made is the same for each of the user's sessions, and the memo keeps
 * it so; it is plain JSON, which a render's digest is made of. A component's dynamic sites are kept
 * as what they read (`SiteOutput`): what each shows depends on the page's view, and is rendered for
 * each render (`shown`), never kept with the component.
 */

/** The field a persistent state binds: its table, its record and its name. */
export interface BoundField {
  readonly table: string;
  readonly id: string;
  readonly field: string;
}

/** Where a state comes from: the field it binds, or the value a local state starts from. */
export type StateOrigin = { readonly field: BoundField } | { readonly value: Json };

/** The JSON kind of a value: what an input a page sends for a site must be, as its first value is. */
export type JsonKind = 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string';

/** A dynamic site of a component's client part, as its program answered it. */
export interface SiteOutput {
  /** The local states its element reads: what a view sends for it. */
  readonly inputs: readonly string[];
  /** The kind of each input's first value, which a view's value must have. */
  readonly kinds: Readonly<Record<string, JsonKind>>;
  /** What it is shown with while every state holds its first value; nothing where it is not shown. */
  readonly initial: SiteInputs | null;
}

/** What one item of a list site shows in one render: its key, the item, and the rendering. */
export interface ShownItem {
  readonly key: string;
  readonly item: Json;
  readonly content: Skeleton;
}

/**
 * What a dynamic site shows in one render: the inputs it was rendered with, and the rendering — of
 * its element, or of each item of a list — or its refusal of the inputs a view sent.
 */
export type ShownSite =
  | {
      readonly inputs: SiteInputs;
      readonly content: Skeleton;
      readonly items?: never;
      readonly refused?: never;
    }
  | {
      readonly inputs: SiteInputs;
      readonly items: readonly ShownItem[];
      readonly content?: never;
      readonly refused?: never;
    }
  | {
      readonly inputs: SiteInputs;
      readonly refused: SiteRefusal;
      readonly content?: never;
      readonly items?: never;
    };

/**
 * A component with states, as rendered: what its Client Component reads. Its dynamic sites are
 * rendered for a render's view (`instance`, `shown`), which only that render's copy holds.
 */
export interface ClientOutput {
  readonly kind: 'client';
  readonly props: Readonly<Record<string, Json>>;
  readonly states: Readonly<Record<string, StateOrigin>>;
  readonly slots: Readonly<Record<string, Skeleton>>;
  readonly sites: Readonly<Record<string, SiteOutput>>;
  /** The instance's id, which a view names it by: where it has sites. */
  readonly instance?: string;
  /** The sites the render's view shows, by id. */
  readonly shown?: Readonly<Record<string, ShownSite>>;
}

/**
 * What a component rendered: nothing, where it refused the session (`forbidden()`); the tree a
 * component the server renders returned; or its client part.
 */
export type Output =
  | ClientOutput
  | { readonly kind: 'refused' }
  | { readonly kind: 'tree'; readonly tree: Skeleton };

/** One component a tree renders, as it rendered. */
export interface SkeletonInstance {
  readonly kind: 'instance';
  readonly component: string;
  readonly key: string | null;
  /**
   * Where it stands in what its parent rendered: the region — `''` for the parent's tree or a
   * site's rendering, a slot's name for a slot — and how many components of its id and key stand
   * before it there.
   */
  readonly region: string;
  readonly ordinal: number;
  /** A digest of the JSON props it was rendered with, its children aside. */
  readonly digest: string;
  readonly output: Output;
}

export type SkeletonProp = Json | RenderedAction | Skeleton;

interface SkeletonElement {
  readonly kind: 'element';
  readonly type: string;
  readonly key: string | null;
  readonly props: Readonly<Record<string, SkeletonProp>>;
  readonly children: readonly Skeleton[];
}

interface SkeletonModule {
  readonly kind: 'module';
  readonly module: string;
  readonly name: string;
  readonly key: string | null;
  readonly props: Readonly<Record<string, SkeletonProp>>;
  readonly children: readonly Skeleton[];
}

interface SkeletonFragment {
  readonly kind: 'fragment';
  readonly key: string | null;
  readonly children: readonly Skeleton[];
}

export type Skeleton =
  | SkeletonElement
  | SkeletonFragment
  | SkeletonInstance
  | SkeletonModule
  | boolean
  | number
  | string
  | null
  | readonly Skeleton[];

/**
 * One step of a binding's path to a component a tree renders: the component found where it stands —
 * its id (`c`), its key (`k`), its region (`r`) and its ordinal there (`n`), as `SkeletonInstance`
 * holds them — whatever its props are now, which change with what it reads; the props' digest
 * (`p`) only on the last step, the component whose state the binding writes. Short names: every
 * write carries them.
 */
export interface ComponentStep {
  readonly c: string;
  readonly k: string | null;
  readonly r: string;
  readonly n: number;
  readonly p?: string;
}

/**
 * One step of a binding's path into a dynamic site: its id (`s`) and the inputs it rendered with
 * (`i`) — and, into an item of a list, the item's key (`k`).
 */
export interface SiteStep {
  readonly s: string;
  readonly i: SiteInputs;
  readonly k?: string;
}

export type Step = ComponentStep | SiteStep;

/** The step that names `instance` where it stands, its props' digest left out. */
export function stepOf(
  instance: Pick<SkeletonInstance, 'component' | 'key' | 'ordinal' | 'region'>,
): ComponentStep {
  return { c: instance.component, k: instance.key, n: instance.ordinal, r: instance.region };
}

export function isSiteStep(step: Step): step is SiteStep {
  return 's' in step;
}

/** The last component of a path, whose state a binding writes; none for the root's own state. */
export function lastComponentStep(path: readonly Step[]): ComponentStep | undefined {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const step = path[index];
    if (step !== undefined && !isSiteStep(step)) {
      return step;
    }
  }
  return undefined;
}

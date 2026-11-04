/**
 * What compiled reactive components, the authority that owns their state and the code around them
 * share: the programs a compile writes for the authority, the tree the authority renders a page's
 * components into, the frame it is rendered at, the operations a page sends, and the names of the
 * cookie and the header the two sides meet on. Runtime-neutral — the browser's bundle and a
 * deployment's Function read it as well as Node and the Durable Object do.
 */

/** The cookie an authority session travels in: opaque, `HttpOnly`, `SameSite=Strict`. */
export const SESSION_COOKIE = 'reactive_session';

/**
 * The header a server-side caller proves itself to the authority with: the internal token, which
 * never reaches a browser. A request that carries it is the application's own server speaking.
 */
export const INTERNAL_HEADER = 'x-reactive-internal';

/** The version of what a compile writes and of what the authority answers. */
export const PROTOCOL_VERSION = 6;

/** The user a session belongs to. */
export interface User {
  readonly id: string;
}

/** What one field of a record holds: text, an integer, or a boolean. */
export type Value = boolean | number | string;

/**
 * A JSON value: what a component's props, a state's server-made initial value, the values an update
 * captures, an operation's arguments and its result are made of.
 */
export type Json =
  | boolean
  | number
  | string
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

/** The type of a field's value, which a field reference carries in its type alone. */
declare const VALUE: unique symbol;

/**
 * What marks a reference — to a field, as `db` makes one; to a module's export, a reactive
 * component, a server operation, as a compile does — which no JSON holds, as JSON holds no symbol:
 * a value a component computed, shaped as one, is never taken for one. Registered, so that every
 * copy of this package a bundle holds reads it alike.
 */
export const REFERENCE: unique symbol = Symbol.for('arkorlab.reactive-state.reference');

/**
 * One field of one record of the application's database, as `db.<table>.ref(id)` gives it: what a
 * component binds a state to. It names the field and nothing else — the authority reads what the
 * field is from the database it was given, never from the reference — and its value's type is the
 * reference's type alone. It is marked as a compile's references are (`REFERENCE`): JSON shaped as
 * one — a prop's, a value the application read — starts a state as that value, and binds nothing.
 */
export interface FieldRef<T extends Value = Value> {
  readonly [REFERENCE]: true;
  readonly kind: 'field';
  readonly table: string;
  readonly id: string;
  readonly field: string;
  /** Never there at run time. */
  readonly [VALUE]?: T;
}

/** The type of the value a field reference names. */
export type FieldValue<R> = R extends FieldRef<infer T> ? T : never;

/**
 * Whether `value` is a field reference, as `db.<table>.ref(id).<field>` makes one, and not JSON
 * shaped as one.
 */
export function isFieldRef(value: unknown): value is FieldRef {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { field, id, kind, table } = value as Partial<Record<string, unknown>>;
  return (
    (value as { readonly [REFERENCE]?: unknown })[REFERENCE] === true &&
    kind === 'field' &&
    typeof table === 'string' &&
    typeof id === 'string' &&
    typeof field === 'string'
  );
}

/** The key a field's value is kept under, on a page and in a frame: `table:id:field`. */
export function fieldKey(ref: Pick<FieldRef, 'field' | 'id' | 'table'>): string {
  return `${ref.table}:${ref.id}:${ref.field}`;
}

// ---------------------------------------------------------------------------------------------
// The tree the authority renders

/**
 * An element type the authority does not render itself: an export of a module the host imports —
 * `next/link`, React's `Suspense`, a `'use client'` component — rendered by name.
 */
export interface ModuleRef {
  readonly [REFERENCE]: true;
  readonly kind: 'module';
  /** The specifier, as the component imports it. */
  readonly module: string;
  /** The export: `default`, or a name. */
  readonly name: string;
}

/** A reactive component a component renders, by its id: the authority renders it in turn. */
export interface ComponentRef {
  readonly [REFERENCE]: true;
  readonly kind: 'component';
  readonly component: string;
}

/**
 * A server operation — an export of a `'use server'` module a component imports — and the
 * arguments bound to it, as `<form action={deleteTodo.bind(null, projectId, id)}>` renders it.
 * The host binds the operation's own Server Function to the same arguments.
 */
export interface ActionRef {
  readonly [REFERENCE]: true;
  readonly kind: 'action';
  /** The module's id: its path in the application, without its extension. */
  readonly module: string;
  readonly name: string;
  readonly bound: readonly Json[];
  /** `Function.prototype.bind`'s shape: `this` is never read, the rest are bound after `bound`. */
  bind: (thisArg: unknown, ...args: readonly Json[]) => ActionRef;
}

export function moduleRef(module: string, name: string): ModuleRef {
  const reference: ModuleRef = { [REFERENCE]: true, kind: 'module', module, name };
  return Object.freeze(reference);
}

export function componentRef(component: string): ComponentRef {
  const reference: ComponentRef = { [REFERENCE]: true, component, kind: 'component' };
  return Object.freeze(reference);
}

export function actionRef(module: string, name: string, bound: readonly Json[] = []): ActionRef {
  const reference: ActionRef = {
    [REFERENCE]: true,
    bind: (_thisArg: unknown, ...args: readonly Json[]): ActionRef =>
      actionRef(module, name, [...bound, ...args]),
    bound: Object.freeze([...bound]),
    kind: 'action',
    module,
    name,
  };
  return Object.freeze(reference);
}

/** An action as the rendered tree carries it: data alone. */
export interface RenderedAction {
  readonly kind: 'action';
  readonly module: string;
  readonly name: string;
  readonly bound: readonly Json[];
}

/** A prop's value in the rendered tree: JSON, a rendered element (`fallback={…}`), or an action. */
export type RenderedProp = Json | Rendered | RenderedAction;

export type RenderedProps = Readonly<Record<string, RenderedProp>>;

/** An element of the browser's own, `<main>`, with its props and children. */
export interface RenderedElement {
  readonly kind: 'element';
  readonly type: string;
  readonly key: string | null;
  readonly props: RenderedProps;
  readonly children: readonly Rendered[];
}

/** An element whose type is a module's export (`ModuleRef`). */
export interface RenderedModule {
  readonly kind: 'module';
  readonly module: string;
  readonly name: string;
  readonly key: string | null;
  readonly props: RenderedProps;
  readonly children: readonly Rendered[];
}

/**
 * A fragment: what a component rendered, under the key the element that rendered the component
 * gave it, so that the browser keeps what it holds where the tree is rendered again.
 */
export interface RenderedFragment {
  readonly kind: 'fragment';
  readonly key: string | null;
  readonly children: readonly Rendered[];
}

/**
 * Where a component's state comes from in the browser: the field a persistent state binds — its key,
 * and the binding its setter writes with, where the component has a setter for it — or the value a
 * local state starts from, where the authority computed it.
 */
export type StateSource =
  | {
      readonly field: string;
      readonly binding?: string;
      /** The registered `set` the setter writes with when it is handed a value. */
      readonly set?: string;
    }
  | { readonly value: Json };

/** The values a dynamic site is rendered with: of the local states its element reads, by key. */
export type SiteInputs = Readonly<Record<string, Json>>;

/** What the authority rendered of one item of a list site: its key, the item, and the rendering. */
export interface RenderedItem<S = Rendered> {
  /** The item's key, as React keeps one: text. */
  readonly key: string;
  /** The item the list's element was rendered of, which the browser holds it by beside its key. */
  readonly item: Json;
  readonly content: S;
}

/**
 * Why the authority rendered a site nothing of the inputs a view sends: what the site's own
 * functions made of them — a list beyond what a list is held to, a fault (`INVALID_VIEW`). The page
 * shows it where the site stands, for the error boundary around it, and asks no more for it; the
 * rest of the root is rendered as ever.
 */
export interface SiteRefusal {
  readonly code: string;
  readonly message: string;
}

/**
 * What the authority rendered at one of a client part's dynamic sites, and with which inputs: the
 * rendering of a site of one element, or of a list — the element a keyed `.map()` renders for each
 * item of an array of the inputs — the rendering of each item, in the order the array holds them;
 * or, for the inputs a view sends, its refusal.
 */
export type RenderedSite<S = Rendered> =
  | {
      readonly inputs: SiteInputs;
      readonly content: S;
      readonly items?: never;
      readonly refused?: never;
    }
  | {
      readonly inputs: SiteInputs;
      readonly items: readonly RenderedItem<S>[];
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
 * The part of a component the browser renders: its props, where each of its states comes from, and
 * what the authority rendered into it — the reactive components its JSX renders with no value of the
 * browser's (`slots`), and those it renders with values of its local states (`sites`), each with
 * the inputs it was rendered with.
 */
export interface ClientPart<S = Rendered> {
  readonly props: Readonly<Record<string, Json>>;
  /** By the state's key, for each state the authority computes. */
  readonly states: Readonly<Record<string, StateSource>>;
  readonly slots: Readonly<Record<string, S>>;
  /** The instance's id, which a view names it by: a part with sites has one. */
  readonly instance?: string;
  /** The sites rendered, by id: those the view names, or those shown with the states' first values. */
  readonly sites?: Readonly<Record<string, RenderedSite<S>>>;
  /**
   * The states its sites and their conditions read, by key: of those the page set, a view that names
   * the part sends the values (`SET_STATES`), for the authority to check a site's conditions of.
   */
  readonly reads?: readonly string[];
}

/** A component the browser renders (`*.client.tsx`), and what the authority made of its part. */
export interface RenderedClient {
  readonly kind: 'client';
  readonly component: string;
  readonly key: string | null;
  readonly part: ClientPart;
}

/**
 * What the authority renders a page's reactive components into: plain data, which the host turns
 * into React elements (`next`). Text and numbers render as they are; `null`, `true` and `false`
 * render nothing.
 */
export type Rendered =
  | RenderedClient
  | RenderedElement
  | RenderedFragment
  | RenderedModule
  | boolean
  | number
  | string
  | null
  | readonly Rendered[];

// ---------------------------------------------------------------------------------------------
// The programs a compile writes for the authority

/** The type `$.fragment` stands for in a compiled program: `<>…</>`. */
export const FRAGMENT = 'arkorlab.reactive-state.fragment';

/** What `$.h` makes, which only the authority reads: kept apart from a client part in a program's type. */
declare const RENDERED: unique symbol;

export interface RenderedNode {
  readonly [RENDERED]?: true;
}

/**
 * What a component's persistent and server-computed states are, as its program computes them: by
 * the state's key, a field reference or the value a local state starts from.
 */
export type StateInputs = Readonly<Record<string, unknown>>;

/** The values of a component's local states, by key, as a dynamic site reads them. */
export type LocalValues<S extends StateInputs> = {
  readonly [K in keyof S]: S[K] extends FieldRef ? never : S[K];
};

/**
 * One item of a list site, as its `each` answers it: the key the browser's element of it has, the
 * item — the array's element the list's callback is handed, JSON — and the element, of the item.
 */
export interface SiteItem {
  readonly key: number | string;
  readonly item: unknown;
  readonly render: () => unknown;
}

/** What a site renders: the element of one (`render`), or of each item of a list (`each`). */
export type SiteRendering<V> =
  | { readonly render: (inputs: V) => unknown; readonly each?: never }
  | { readonly each: (inputs: V) => readonly SiteItem[]; readonly render?: never };

/**
 * A reactive component the browser part's JSX renders with values of the component's local states
 * (a dynamic site), as the compile wrote it: the states its element reads (`inputs`); whether the
 * page shows it while every state holds its first value (`guard`, of the states, where conditions
 * stand over it); and the element, of the inputs — or, for one the browser renders in a keyed
 * `.map()` of an array of the inputs, each item of the array, with its key and its element. The
 * functions run inside `evaluate`, after the code before the states, so they read what that code
 * computed.
 */
export type SiteDescriptor<V extends Readonly<Record<string, unknown>> = SiteInputs> = {
  readonly inputs: readonly (keyof V & string)[];
  readonly guard?: (values: V) => unknown;
} & SiteRendering<V>;

/** What a component with states answers: its client part, its states not yet resolved. */
export interface ClientDescriptor<S extends StateInputs = StateInputs> {
  readonly kind: 'client-part';
  readonly props: Readonly<Record<string, Json>>;
  readonly states: S;
  readonly slots: Readonly<Record<string, unknown>>;
  readonly sites: Readonly<Record<string, SiteDescriptor<LocalValues<S>>>>;
}

/**
 * The values of a component's states, as its Client Component reads them, from the descriptor its
 * program answers: a field reference's value, or the local value itself.
 */
export type StateValues<D> = D extends {
  readonly kind: 'client-part';
  readonly states: infer S;
}
  ? { readonly [K in keyof S]: S[K] extends FieldRef<infer T> ? T : S[K] }
  : never;

/**
 * The states of the client part a program's `evaluate` answers, by key. The part is told by its
 * kind: its sites take its own states' values, so no part of other states is assignable to another.
 */
export type StatesOf<E extends (...args: never[]) => unknown> = StateValues<
  Extract<Awaited<ReturnType<E>>, { readonly kind: 'client-part' }>
>;

/** The lib's inherited methods of all JavaScript values, rather than a boxed primitive. */
// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
type MethodObject = Object;
/** A receiver's own signature, with inherited Object methods only where its type has no key. */
type MethodValue<T, K extends PropertyKey> = K extends keyof NonNullable<T>
  ? NonNullable<T>[K]
  : MethodObject[K & keyof MethodObject];

/**
 * What a compiled program renders with: the JSX factory, and the client part of a component with
 * states. The authority makes one for each component it renders.
 */
export interface RenderScope {
  /** `<type {...props}>{children}</type>`, as the JSX the compile rewrote wrote it. */
  readonly h: (
    type: ComponentRef | ModuleRef | string,
    props: Readonly<Record<string, unknown>> | null,
    ...children: readonly unknown[]
  ) => RenderedNode;
  /** `<>…</>`. */
  readonly fragment: typeof FRAGMENT;
  /**
   * `value`, what the code a dynamic site is computed of makes — what a call answers, what a `+`, a
   * template, an array or an object makes, what a function a method is given answers; the compile
   * writes each through it — counted, with its size, against what a call of the site's function
   * may spend (`VIEW_LIMITS.steps`).
   */
  readonly counted: <T>(value: T) => T;
  /**
   * `key`, by which the code a dynamic site is computed of reads a member it computes the name of —
   * the compile writes each such key through it, `item[$.member(key)]` — refused where it reaches
   * what made a value, or what it is made of (`constructor`, `__proto__`).
   */
  readonly member: <K>(key: K) => K;
  /** A method captured before its arguments, preserving its receiver and checking native aliases. */
  readonly method: <T, K extends keyof (MethodObject & NonNullable<T>)>(
    receiver: T,
    key: K,
  ) => OmitThisParameter<MethodValue<T, K>>;
  /** The client part of a component with states. */
  readonly client: <S extends StateInputs>(part: {
    readonly props: Readonly<Record<string, Json>>;
    readonly states: S;
    readonly slots: Readonly<Record<string, unknown>>;
    readonly sites?: Readonly<Record<string, SiteDescriptor<LocalValues<S>>>>;
  }) => ClientDescriptor<S>;
}

/**
 * An update the authority runs for a persistent state: of the current value, and of the values the
 * call captured when it was made (`current => addEstimate(current, step)` captures `step`). One
 * update of a custom hook serves each state the component binds through each call of the hook:
 * `keys` names them all.
 */
export interface ApplyUpdater {
  readonly keys: readonly string[];
  readonly kind: 'apply';
  apply(current: Value, captures: Readonly<Record<string, Json>>): Value;
}

/** The update that writes the value the browser sends, which the authority checks against the field. */
export interface SetUpdater {
  readonly keys: readonly string[];
  readonly kind: 'set';
}

export type ProgramUpdater = ApplyUpdater | SetUpdater;

/** What a compile writes for the authority (`<name>.authority.mts`), for each component. */
export interface ComponentProgram {
  readonly protocolVersion: number;
  /** The compile's build: one for every component of it. */
  readonly buildId: string;
  /** The component's id: its path in the application, without `.reactive.tsx`. */
  readonly component: string;
  /**
   * The component, as the authority renders it: its code before its states, as it wrote it, and
   * what it returns — the JSX of a component the server renders, rewritten as `$.h(…)`, or the
   * client part of one with states. Declared as a method, so that a program whose `evaluate` takes
   * its own props' type is one of these: JSON, and `children` — what the element that renders the
   * component holds between its tags, as the authority's nodes.
   */
  evaluate(props: Readonly<Record<string, unknown>>, $: RenderScope): unknown;
  /** The keys of the states the component has a setter for: those a binding is issued for. */
  readonly writable: readonly string[];
  /** Its updaters, by id. */
  readonly updaters: Readonly<Record<string, ProgramUpdater>>;
}

/** A `'use server'` module a component imports, as the authority runs it: its exports, by name. */
export type OperationModule = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------------------------
// What a page and the authority exchange

/**
 * What marks the binding of a persistent state the browser holds, which no other object holds: a
 * local state's value, whatever it is, never has it. Registered, so that every copy of this
 * package a bundle holds reads it alike.
 */
export const REACTIVE_BINDING: unique symbol = Symbol.for('arkorlab.reactive-state.binding');

/**
 * What a compiled Client Component hands `useReactiveState` for a persistent state: the field's key,
 * the binding its setter writes with (none for a state without a setter) — which names the build it
 * was signed for — and the registered `set`.
 */
export interface StateBinding {
  readonly [REACTIVE_BINDING]: true;
  readonly field: string;
  readonly binding?: string;
  readonly set?: string;
}

/** The component a page renders the authority's way, and the props it renders it with. */
export interface RootRequest {
  readonly component: string;
  readonly props: Readonly<Record<string, Json>>;
  readonly build: string;
}

/**
 * The inputs of each dynamic site a page shows, by the client part's instance and the site's id: a
 * part the view names shows those sites alone; one it does not name shows the sites its states'
 * first values show. A page's view leaves out of a site's inputs the states it still follows,
 * which the authority renders of their first values then; a frame's view holds every input. Of a
 * part it names, a page's view holds too the values of the states the page set, under `SET_STATES`:
 * the part shows, beside the sites the view names, each other its conditions show of those values
 * and of the authority's own. A part named without them shows the sites the view names alone.
 */
export type View = Readonly<Record<string, Readonly<Record<string, SiteInputs>>>>;

/** The key of a part's entry in a page's view that holds the values of the states the page set. */
export const SET_STATES = '$set';

/**
 * A root rendered again for what a page shows of it: the frame's signed subscription names the root,
 * its props, the session, the build and the view the frame was rendered for; the request's view, the
 * inputs of the sites of each part the page shows otherwise than that frame — the rest as the
 * subscription names them.
 */
export interface ViewRequest {
  readonly subscription: string;
  readonly view: View;
}

/**
 * The most a view request names: parts, sites of each, and bytes of the view's JSON in UTF-8 in
 * all — far more than a page changes at once, and few enough that every subscription and binding
 * issued for a view, which carries it in base64, stays within the 4096 characters a token is — and
 * characters of its subscription, more than any the authority signs. The host refuses a request
 * beyond them before it asks the authority, which refuses it alike. The authority renders at most
 * `items` items of a list site, each a rendering of its own, and a call of a site's function spends
 * at most `steps` steps of its inputs: the calls of the functions its methods are given, and the size
 * of what they answer (`authority/steps.ts`).
 */
export const VIEW_LIMITS = Object.freeze({
  bytes: 2048,
  items: 16,
  parts: 64,
  sites: 16,
  steps: 262_144,
  subscription: 4096,
});

/**
 * One confirmed view of what a root renders, read in one exclusive evaluation: the values of every
 * field it binds, the revision they were read at, and the operations of this session it already
 * reflects. A page adopts a frame whole, with the tree it came with.
 */
export interface Frame {
  /** The root, the props it was rendered with, the session and the build, as one digest. */
  readonly rootKey: string;
  readonly revision: number;
  readonly buildId: string;
  /** Every bound field's value, by `fieldKey`. */
  readonly fields: Readonly<Record<string, Value>>;
  /** The newest operations of this session committed at or before `revision`. */
  readonly operations: readonly string[];
  /** A digest of the tree and the values: what the page shows. */
  readonly digest: string;
  /** The view the tree was rendered for: the inputs of each site it shows. */
  readonly view: View;
  /**
   * The signed subscription the page's event stream follows the root with; empty for a root rendered
   * for no session (`unauthenticated`), which there is nothing to follow of.
   */
  readonly subscription: string;
}

/** Whether the root rendered, or the session may not see it. */
export type RenderStatus = 'forbidden' | 'rendered' | 'unauthenticated';

/** A root, rendered. */
export interface RenderResult {
  readonly status: RenderStatus;
  readonly tree: Rendered;
  readonly frame: Frame;
}

/**
 * One write to a field, as a page sends it: an operation of its own naming, a registered updater,
 * and — for a `set`, and only for one — the value it writes; for an `apply`, the values its call
 * captured.
 */
export interface FieldOperation {
  readonly binding: string;
  readonly operationId: string;
  readonly updaterId: string;
  readonly value?: Value;
  readonly captures?: Readonly<Record<string, Json>>;
}

/** What a write answers: the revision it committed at, and whether it had been made already. */
export interface FieldReceipt {
  readonly operationId: string;
  readonly committedRevision: number;
  readonly deduplicated: boolean;
}

/**
 * An argument to a server operation as it crosses to the authority: JSON, or a form's entries — its
 * strings alone, which is all a form of this kind sends.
 */
export type OperationArgument =
  | { readonly form: readonly (readonly [string, string])[] }
  | { readonly json: Json };

/** A server operation, as the application's server asks the authority to run it. */
export interface OperationCall {
  readonly module: string;
  readonly name: string;
  readonly args: readonly OperationArgument[];
  readonly operationId: string;
  readonly build: string;
}

/** What an operation answers: what it returned, and the revision it committed at, if it did. */
export interface OperationReceipt {
  readonly operationId: string;
  readonly committedRevision: number | null;
  readonly result: Json;
  readonly deduplicated: boolean;
}

/** A server function's answer across the RSC boundary, where a thrown error loses its fields. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

/** One committed change, as the authority's change log keeps it. */
export interface ChangeEvent {
  readonly revision: number;
  readonly eventId: string;
  readonly changed: readonly string[];
  /**
   * Of `changed`, the records of tables with public fields: what a page rendered without a session
   * may show, and so all a site that renders such pages is told of.
   */
  readonly published: readonly string[];
  readonly kind: 'session' | 'state';
  readonly created: number;
}

/** A table's name, and a record's id. */
const RESOURCE = /^([A-Za-z]\w{0,63}):([\w-]{1,64})$/u;

/** The resource name a record changes under, in the change log and in a cache tag. */
export function recordResource(table: string, id: string): string {
  return `${table}:${id}`;
}

/** The cache tag the framework gives what renders a record; applications do not keep it. */
export function recordTag(table: string, id: string): string {
  return `rq:${recordResource(table, id)}`;
}

/** The table and record a resource name names; nothing for any other resource. */
export function resourceOf(
  resource: string,
): { readonly table: string; readonly id: string } | undefined {
  const match = RESOURCE.exec(resource);
  return match === null ? undefined : { id: match[2] ?? '', table: match[1] ?? '' };
}

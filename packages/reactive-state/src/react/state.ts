import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  type ClientPart,
  type Frame,
  type Json,
  REACTIVE_BINDING,
  type StateBinding,
  type Value,
} from '../program.ts';
import { canonicalJson, toJson } from '../runtime/json.ts';
import { displayValue, type PendingOperation, type Predictor } from '../runtime/operations.ts';
import type { PageStore, Send, StoreStatus } from '../runtime/store.ts';
import type { ViewController } from '../runtime/view.ts';

/**
 * What a compiled Client Component reads its states with. `stateOf` turns what the authority made
 * of a state (`ClientPart['states']`) into the input `useReactiveState` takes: a persistent state's
 * binding, or the value a local state starts from where the authority computed it. A persistent
 * state's value is its field's as the nearest `LiveRoot`'s frame confirms it, with this session's
 * operations the frame does not reflect applied on top; its setter writes through the page's store.
 */

/** What the nearest `LiveRoot` hands the states rendered inside it. */
export interface Live {
  readonly frame: Frame;
  /** The session the frame was rendered for, as `renderRoot` names it. */
  readonly session: string | undefined;
  /** The page's store; none on the server, where nothing is written. */
  readonly store: PageStore | null;
  /** The root's `update` Server Function. */
  readonly send: Send;
  /**
   * What the root shows of its dynamic sites, and how it asks for a site it does not have yet; none
   * on the server, where nothing is asked for.
   */
  readonly sites: ViewController<ReactNode> | null;
}

export const LiveContext = createContext<Live | null>(null);

/**
 * What marks the value a local state starts from where the authority computed it, which `stateOf`
 * hands on: its setter writes the page's own state, the compiled updates included. Registered, as
 * `REACTIVE_BINDING` is.
 */
const REACTIVE_LOCAL: unique symbol = Symbol.for('arkorlab.reactive-state.local');

interface LocalInput {
  readonly [REACTIVE_LOCAL]: true;
  readonly value: Json;
}

/** The type of the state's value, which a state's input carries in its type alone. */
declare const STATE_VALUE: unique symbol;

/** What marks a local state's input in its type alone, which an input that may bind a field has not. */
declare const LOCAL_STATE: unique symbol;

/**
 * What `stateOf` answers for a state of a client part that may bind a field: a persistent state's
 * binding, or the value it starts from where the authority found it of no field. Typed by the
 * state's value alone.
 */
export type StateInput<T> = (LocalInput | StateBinding) & {
  readonly [STATE_VALUE]?: T;
  readonly [LOCAL_STATE]?: never;
};

/**
 * What `localOf` answers for a local state the authority started — one of a value of the page's,
 * which binds no field: the value it starts from. Typed by the state's value alone.
 */
export type LocalStateInput<T> = LocalInput & {
  readonly [STATE_VALUE]?: T;
  readonly [LOCAL_STATE]: true;
};

/** The props of every compiled Client Component: what the authority made of its part. */
export interface ClientPartProps {
  readonly part: ClientPart<ReactNode>;
}

/**
 * A persistent setter, the same function on every render while it writes to the same field, as
 * React's own setters are: it is passed on to a control as its `onChange`. Called with a value, it
 * writes through the `set` the compiler registered for the state; the compiler replaces each update
 * of the current value it can see with `compiled`, naming the update it registered, the values the
 * call captured, and the prediction the browser shows until the authority confirms it. It takes no
 * function of the current value itself — the authority is sent none — so a control typed to call a
 * setter with one, as React's own is (`Dispatch<SetStateAction<T>>`), is not given it. A local
 * state's setter is React's own (`localOf`): nothing of a local state is sent.
 */
export type ReactiveSetter<T> = ((next: T) => void) & {
  compiled(id: string, captures: Readonly<Record<string, Json>>, predict: (current: T) => T): void;
};

const FUNCTION_REFUSED =
  'A function of the current value cannot be sent to the authority: call the setter with it inside the component, where the compiler registers the update.';

/**
 * Where a local state the authority started stands: its part's instance, its key there, and whether
 * a site of the part, or a site's condition, reads it — whose value a view then sends, set.
 */
interface Place {
  readonly instance: string;
  readonly key: string;
  readonly read: boolean;
}

/** Of each local state's input the authority started, where it stands, where its part has an instance. */
const PLACE_OF = new WeakMap<LocalInput, Place>();

/** The input of the local state `key` of `part`, which the authority started of `value`. */
function startedOf(part: ClientPart<ReactNode>, key: string, value: Json): LocalInput {
  const made: LocalInput = { [REACTIVE_LOCAL]: true, value };
  const local = Object.freeze(made);
  if (part.instance !== undefined) {
    PLACE_OF.set(local, { instance: part.instance, key, read: part.reads?.includes(key) === true });
  }
  return local;
}

/** What the authority made of the state `key` of `part`, as `useReactiveState` takes it. */
export function stateOf<T = unknown>(part: ClientPart<ReactNode>, key: string): StateInput<T> {
  const source = part.states[key];
  if (source === undefined) {
    throw new Error(
      `The authority rendered no state "${key}" for this component: compile the application again.`,
    );
  }
  if ('value' in source) {
    return startedOf(part, key, source.value);
  }
  const binding: StateBinding = {
    [REACTIVE_BINDING]: true,
    field: source.field,
    ...(source.binding !== undefined && { binding: source.binding }),
    ...(source.set !== undefined && { set: source.set }),
  };
  return Object.freeze(binding);
}

/**
 * What the authority made of the local state `key` of `part` — the value it starts from, which binds
 * no field — as `useReactiveState` takes it, whose setter is then React's own.
 */
export function localOf<T = unknown>(part: ClientPart<ReactNode>, key: string): LocalStateInput<T> {
  const source = part.states[key];
  if (source === undefined || !('value' in source)) {
    throw new Error(
      `The authority rendered no local state "${key}" for this component: compile the application again.`,
    );
  }
  return startedOf(part, key, source.value) as LocalStateInput<T>;
}

/** What the authority rendered into the slot `key` of `part`: a reactive component the JSX renders. */
export function slotOf(part: ClientPart<ReactNode>, key: string): ReactNode {
  if (!Object.hasOwn(part.slots, key)) {
    throw new Error(
      `The authority rendered no slot "${key}" for this component: compile the application again.`,
    );
  }
  return part.slots[key];
}

/**
 * Whether a state's input is a persistent state's binding, which it marks as its own
 * (`REACTIVE_BINDING`), rather than a local state's object, whatever that holds.
 */
function isStateBinding(value: unknown): value is StateBinding {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, REACTIVE_BINDING)) {
    return false;
  }
  const { binding, field, set } = value as Partial<Record<string, unknown>>;
  return (
    (value as Partial<Record<typeof REACTIVE_BINDING, unknown>>)[REACTIVE_BINDING] === true &&
    typeof field === 'string' &&
    (binding === undefined || typeof binding === 'string') &&
    (set === undefined || typeof set === 'string')
  );
}

function isLocalInput(value: unknown): value is LocalInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, REACTIVE_LOCAL) &&
    (value as Partial<Record<typeof REACTIVE_LOCAL, unknown>>)[REACTIVE_LOCAL] === true
  );
}

function isValue(value: unknown): value is Value {
  return (
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Where a persistent setter writes: the field, its binding and `set`, under the root shown. */
interface Target {
  readonly field: string;
  readonly binding: string | undefined;
  readonly set: string | undefined;
  readonly live: Live;
}

/** A persistent setter, and how its component keeps it writing with the binding it renders now. */
interface Persistent<T> {
  readonly setter: ReactiveSetter<T>;
  /** The target the component renders now: the newest binding of the same field. */
  retarget: (target: Target) => void;
}

function noSetter(field: string): Error {
  return new Error(
    `The state of ${field} is read here without a setter: the component never writes it.`,
  );
}

/**
 * The setter of one field. Its component retargets it at each render with the newest binding of
 * the field, so it is the same function across renders; once the component renders another field
 * at the state's place, it makes another setter, and this one keeps writing where it did.
 */
function persistentSetter<T>(field: string): Persistent<T> {
  let target: Target | undefined;
  const current = (): Target => {
    if (target === undefined) {
      throw new Error(`The setter of ${field} was called before its component was rendered.`);
    }
    return target;
  };
  const write = (next: T | ((value: T) => T)): void => {
    if (typeof next === 'function') {
      throw new TypeError(FUNCTION_REFUSED);
    }
    const { binding, live, set } = current();
    if (binding === undefined) {
      throw noSetter(field);
    }
    if (set === undefined) {
      throw new Error(
        `The setter of ${field} is handed a value, for which no update was registered: compile the application again.`,
      );
    }
    if (!isValue(next)) {
      throw new TypeError('A persistent setter takes text, a finite number or a boolean.');
    }
    live.store?.set({
      binding,
      field,
      send: live.send,
      session: live.session,
      updaterId: set,
      value: next,
    });
  };
  const compiled = (
    id: string,
    captures: Readonly<Record<string, Json>>,
    predict: (value: T) => T,
  ): void => {
    const { binding, live } = current();
    if (binding === undefined) {
      throw noSetter(field);
    }
    // The update registered under `id` takes the field's value, of the type its frames hold, as the
    // compile that named both checked.
    live.store?.apply({
      binding,
      captures,
      field,
      predict: predict as unknown as Predictor,
      send: live.send,
      session: live.session,
      updaterId: id,
    });
  };
  return {
    retarget: (next) => {
      target = next;
    },
    setter: Object.assign(write, { compiled }),
  };
}

/**
 * The setter of a local state the authority started: the page's own state, which takes a value or
 * a function of the current one, as React's setter does — a state of JSON holds no function — or a
 * compiled update of the current one, run here alone, with what it captured. What it holds is what
 * the page sends the authority of it (`written`), so what the browser computes of it is what the
 * authority computes of what it is sent. Once called, the state is the page's (`keep`): it follows
 * the authority no more.
 */
function localSetter<T>(
  setLocal: Dispatch<SetStateAction<T>>,
  keep: () => void,
): ReactiveSetter<T> {
  const write = (next: T | ((value: T) => T)): void => {
    keep();
    setLocal((value) =>
      written(value, typeof next === 'function' ? (next as (current: T) => T)(value) : next),
    );
  };
  return Object.assign(write, {
    compiled: (
      _id: string,
      _captures: Readonly<Record<string, Json>>,
      predict: (value: T) => T,
    ): void => {
      keep();
      setLocal((value) => written(value, predict(value)));
    },
  });
}

/** Of each copy a local state holds, the page's object it was made of (`written`). */
const WRITTEN_OF = new WeakMap<WeakKey, unknown>();

/**
 * What a local state holds once `next` is written over `value`: `value` itself where `next` is it,
 * or is the object `value` was made of — so React, handed what the state holds, renders nothing
 * anew, as it does of its own states written what they hold — and else a copy of `next` as the page
 * sends it to the authority (`sentOf`), so that no order of keys tells one side's value from the
 * other's: another object, even one the page sends alike, is a new value, as React holds it. What
 * JSON does not carry as it is — a date, `NaN` — stays as it is: a site that reads it fails where it
 * stands, as the page cannot send it (`useSites`).
 */
function written<T>(value: T, next: T): T {
  if (Object.is(value, next) || madeOf(value, next)) {
    return value;
  }
  const sent = sentOf(next);
  if (sent === undefined) {
    return next;
  }
  const copy = JSON.parse(sent) as T;
  if (isObject(copy)) {
    WRITTEN_OF.set(copy, next);
  }
  return copy;
}

/** Whether `value` is the copy a local state was made of the object `next` (`WRITTEN_OF`). */
function madeOf(value: unknown, next: unknown): boolean {
  return isObject(value) && isObject(next) && WRITTEN_OF.get(value) === next;
}

function isObject(value: unknown): value is WeakKey {
  return typeof value === 'object' && value !== null;
}

/**
 * The text the page sends the authority of `value` (`toJson`): `-0` as `0`, an entry that holds
 * `undefined` left out, as a site's inputs are sent (`useSites`) — each object's keys in order of
 * their names, as the authority holds what it is sent, and starts a state of. None where JSON does
 * not carry it as it is.
 */
function sentOf(value: unknown): string | undefined {
  try {
    return canonicalJson(toJson(value));
  } catch {
    return undefined;
  }
}

const NONE: readonly PendingOperation[] = Object.freeze([]);

function ignore(): void {
  // Nothing was subscribed to.
}

function unsubscribed(): () => void {
  return ignore;
}

function none(): readonly PendingOperation[] {
  return NONE;
}

type InitialInput<T> = LocalStateInput<T> | StateInput<T> | T | (() => T);

function initialOf<T>(input: InitialInput<T>): T {
  if (isStateBinding(input)) {
    return undefined as T;
  }
  if (isLocalInput(input)) {
    return input.value as T;
  }
  return typeof input === 'function' ? (input as () => T)() : input;
}

/** The local cell behind a state position, which may first have rendered a field binding. */
interface LocalCell<T> {
  readonly initialized: boolean;
  /** Whether the page has set the state, which then follows the authority no more. */
  readonly kept: boolean;
  readonly value: T;
  readonly write: Dispatch<SetStateAction<T>>;
  readonly start: Dispatch<SetStateAction<boolean>>;
}

/**
 * Of each object the authority rendered of a local state, the value the state held that it was
 * found alike (`follows`): compared once, not again at each render the frame stands under.
 */
const ALIKE_OF = new WeakMap<WeakKey, unknown>();

/**
 * Whether a local state holding `value` takes what the authority renders of it now, `input`: one
 * the authority started, whose value the authority renders otherwise now — not another object
 * alike, which would render the page anew for nothing.
 */
function follows<T>(input: InitialInput<T>, value: T): boolean {
  if (!isLocalInput(input) || Object.is(input.value, value)) {
    return false;
  }
  const rendered = input.value;
  if (isObject(rendered) && ALIKE_OF.has(rendered) && Object.is(ALIKE_OF.get(rendered), value)) {
    return false;
  }
  const alike = sentOf(rendered) === sentOf(value);
  if (alike && isObject(rendered)) {
    ALIKE_OF.set(rendered, value);
  }
  return !alike;
}

/**
 * A field's hidden local cell starts only when this position first becomes local. A local state
 * the authority started follows what it renders until the page sets it: what it started of, the
 * page's data most often, would else stay as it was when the data changes.
 */
function localValue<T>(input: InitialInput<T>, cell: LocalCell<T>): T {
  if (cell.initialized && (cell.kept || !follows(input, cell.value))) {
    return cell.value;
  }
  const value = initialOf(input);
  cell.write(() => value);
  if (!cell.initialized) {
    cell.start(true);
  }
  return value;
}

/** Where a local state stands, and the root's sites it tells it is set: while it is rendered. */
interface Telling extends Omit<Place, 'read'> {
  readonly sites: ViewController<ReactNode>;
}

/** Where a local state stands, with the root's sites to tell: none where any of them is missing. */
function tellingOf(
  sites: ViewController<ReactNode> | null,
  instance: string | undefined,
  key: string | undefined,
): Telling | null {
  return sites === null || instance === undefined || key === undefined
    ? null
    : { instance, key, sites };
}

/**
 * The setter of a local state the authority started (`localSetter`), which sets it (`kept`) and
 * tells the root's sites where it stands (`ViewController.keep`): as it is called, before the render
 * it makes — which a transition may hold back while it waits for a site of the value set — asks for
 * anything; and again as each render that holds it set commits, for a part its sites let go of
 * (`release`) and rendered again with its states as they were. A view request sends its value from
 * then on, and leaves out those of the states still followed. One setter, whatever its part's place
 * and root: where it stands is read as it is called, from what the render committed last, and is
 * nothing once the component is no longer rendered — a part rendered anew in its place follows.
 */
function useKeptSetter<T>(
  input: InitialInput<T>,
  sites: ViewController<ReactNode> | null,
  setLocal: Dispatch<SetStateAction<T>>,
  {
    kept,
    setKept,
    value,
  }: { readonly kept: boolean; readonly setKept: Dispatch<boolean>; readonly value: T },
): ReactiveSetter<T> {
  const place = isLocalInput(input) ? PLACE_OF.get(input) : undefined;
  const instance = place?.instance;
  const key = place?.key;
  // Its value goes where a site of its part reads it: of no other state is one sent.
  const read = place?.read === true;
  // Where its first render stands, which a setter called before any render of it commits tells — in
  // that render, which may wait and never commit, and be thrown away with what it set.
  const first = useRef(tellingOf(sites, instance, key));
  const telling = useRef<Telling | null>(null);
  const committed = useRef(false);
  if (kept && sites !== null && instance !== undefined && key !== undefined) {
    // Told as each render that holds it set renders, where that render stands — as `ensure` is, of
    // what it waits for — so that a render at a new place, or its first, which may wait on a site of
    // it and never commit, has its request send the value: until the part next commits.
    sites.keep(instance, key, read ? { lasting: false, value } : { lasting: false });
  }
  useInsertionEffect(() => {
    committed.current = true;
    telling.current = tellingOf(sites, instance, key);
    return () => {
      telling.current = null;
    };
  }, [instance, key, sites]);
  const reactive = useMemo(() => {
    return localSetter(setLocal, () => {
      setKept(true);
      const at = committed.current ? telling.current : first.current;
      if (at !== null) {
        at.sites.keep(at.instance, at.key);
      }
    });
  }, [setKept, setLocal]);
  // As each render that holds it set commits, with the value it holds: a request sends it for a
  // site the view names not, whose conditions the authority checks of it.
  useEffect(() => {
    if (kept && sites !== null && instance !== undefined && key !== undefined) {
      sites.keep(instance, key, read ? { value } : {});
    }
  }, [instance, kept, key, read, sites, value]);
  return reactive;
}

export function useReactiveState<T>(state: StateInput<T>): [T, ReactiveSetter<T>];
export function useReactiveState<T>(
  initial: LocalStateInput<T> | T | (() => T),
): [T, Dispatch<SetStateAction<T>>];
/**
 * A persistent state, given what `stateOf` answers for one; a local state, given what `localOf`
 * answers or anything else — React's own, whose setter takes a function of the current value as
 * React's does. Both kinds call the same hooks in the same order, so a component may hold either at
 * any position.
 */
export function useReactiveState<T>(
  input: InitialInput<T>,
): [T, Dispatch<SetStateAction<T>> | ReactiveSetter<T>] {
  const live = useContext(LiveContext);
  const binding = isStateBinding(input) ? input : undefined;
  const [local, setLocal] = useState<T>(() => initialOf(input));
  const [initialized, setInitialized] = useState(binding === undefined);
  const [kept, setKept] = useState(false);
  const store = binding === undefined ? null : (live?.store ?? null);
  const field = binding?.field;
  const pending = useSyncExternalStore(
    store === null ? unsubscribed : store.subscribe,
    store === null || field === undefined ? none : () => store.pendingOf(field),
    none,
  );
  const persistent = useMemo(
    () => (field === undefined ? undefined : persistentSetter<T>(field)),
    [field],
  );
  const reactive = useKeptSetter(input, live?.sites ?? null, setLocal, {
    kept,
    setKept,
    value: local,
  });
  const writes = binding?.binding;
  const set = binding?.set;
  // Retargeted as each render commits, before any effect — a child's that calls it on mount too —
  // and anything the page does could call it.
  useInsertionEffect(() => {
    if (persistent !== undefined && live !== null && field !== undefined) {
      persistent.retarget({ binding: writes, field, live, set });
    }
  }, [field, live, persistent, set, writes]);
  if (binding === undefined) {
    return [
      localValue(input, {
        initialized,
        kept,
        start: setInitialized,
        value: local,
        write: setLocal,
      }),
      isLocalInput(input) ? reactive : setLocal,
    ];
  }
  if (live === null || persistent === undefined) {
    throw new Error('A persistent state is rendered inside <LiveRoot>, which renderRoot renders.');
  }
  const value = displayValue(live.frame, live.session, pending, binding.field);
  if (value === undefined) {
    throw new Error(`The frame holds no value of ${binding.field}: the authority did not bind it.`);
  }
  return [value as T, persistent.setter];
}

const IDLE: StoreStatus = Object.freeze({
  error: null,
  mismatched: false,
  offline: false,
  pending: 0,
  primary: undefined,
  revoked: false,
});

function idle(): StoreStatus {
  return IDLE;
}

/**
 * What the page says of its operations: how many are pending, why the last one failed, whether it
 * is offline, revoked, or asks for a reload. Idle on the server, and outside a `LiveRoot`.
 */
export function useReactiveStatus(): StoreStatus {
  const store = useContext(LiveContext)?.store ?? null;
  return useSyncExternalStore(
    store === null ? unsubscribed : store.subscribe,
    store === null ? idle : store.getStatus,
    idle,
  );
}

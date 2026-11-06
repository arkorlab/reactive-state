import { type Json, SET_STATES, type SiteInputs, type View, VIEW_LIMITS } from '../program.ts';
import { canonicalJson } from './json.ts';

/**
 * What a view request sends of what the page shows (`ViewController`): the parts it names, and of
 * each site's inputs, the states the page has set — those it still follows left out, for the
 * authority to render of its own values, which the page takes with the frame that brings them.
 */

/** Of each part, by its instance, the states the page has set, or whose values a subscription holds. */
export type StatesOf = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Of a part the page renders, the values of the states it set that the part's sites read — `{}` of
 * none; of a part it let go of, nothing.
 */
export type ValuesOf = (instance: string) => Readonly<Record<string, Json>> | undefined;

/** What a subscription holds of the page's: of each part, the set states and their values' text. */
export interface Held {
  readonly states: StatesOf;
  readonly values: ReadonlyMap<string, string>;
}

/**
 * The text of the values of the states the page set of a part, as a subscription holds them; of a
 * part named without them, `''`.
 */
function valuesText(values: Readonly<Record<string, Json>> | undefined): string {
  return values === undefined ? '' : canonicalJson(values);
}

/**
 * Whether a request carries the set values of a part whose view names `sites`: not where
 * `SET_STATES` would take it past the sites a part may name (`VIEW_LIMITS.sites`).
 */
function carriesSet(sites: Readonly<Record<string, SiteInputs>>): boolean {
  return Object.keys(sites).length < VIEW_LIMITS.sites;
}

function own<T>(target: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** The names of the inputs of a part's sites. */
function inputsOf(sites: Readonly<Record<string, SiteInputs>>): readonly string[] {
  return Object.values(sites).flatMap((inputs) => Object.keys(inputs));
}

/** Whether a site carries of the state `name` another value than the page set, `values`' own. */
function carriesOther(
  values: Readonly<Record<string, Json>> | undefined,
  name: string,
  value: Json,
): boolean {
  const set = values !== undefined && Object.hasOwn(values, name) ? values[name] : undefined;
  return set !== undefined && canonicalJson(set) !== canonicalJson(value);
}

/**
 * Of a part's `sites`, what a request sends of each one's inputs: those of the states the page has
 * set (`set`), into `part`. It answers the names of those every site that carries one carries of the
 * value the page set, `values` — a site a render not committed yet waits for may carry another.
 */
function sentSites(
  sites: Readonly<Record<string, SiteInputs>>,
  set: ReadonlySet<string> | undefined,
  part: Record<string, SiteInputs>,
  values: Readonly<Record<string, Json>> | undefined,
): ReadonlySet<string> {
  const carried = new Set<string>();
  const other = new Set<string>();
  for (const [site, inputs] of Object.entries(sites)) {
    const sent: Record<string, SiteInputs[string]> = {};
    for (const [name, value] of Object.entries(inputs)) {
      if (set?.has(name) === true) {
        own(sent, name, value);
        (carriesOther(values, name, value) ? other : carried).add(name);
      }
    }
    own(part, site, sent);
  }
  for (const name of other) {
    carried.delete(name);
  }
  return carried;
}

/**
 * Of `view`, what a request sends: of each site's inputs, those of the states the page has set
 * (`kept`); those it follows are left out, and rendered of the authority's values. Of each part the
 * page renders, the values of its set states too that the sites it names carry not, or carry
 * otherwise (`SET_STATES`, `{}` of none), for the authority to show a site the view names not where
 * its conditions hold of them — a part named without them shows the sites it names alone.
 */
export function sentInputs(view: View, kept: StatesOf, valuesOf?: ValuesOf): View {
  const sent: Record<string, Readonly<Record<string, SiteInputs>>> = {};
  for (const [instance, sites] of Object.entries(view)) {
    const part: Record<string, SiteInputs> = {};
    const setValues = valuesOf?.(instance);
    const carried = sentSites(sites, kept.get(instance), part, setValues);
    if (setValues !== undefined && carriesSet(sites)) {
      const rest: Record<string, Json> = {};
      for (const [name, value] of Object.entries(setValues)) {
        if (!carried.has(name)) {
          own(rest, name, value);
        }
      }
      own(part, SET_STATES, rest);
    }
    own(sent, instance, part);
  }
  return sent;
}

/** Whether a request's `view` stays within what the host and the authority read one of (`VIEW_LIMITS`). */
export function carries(view: View): boolean {
  return (
    Object.keys(view).length <= VIEW_LIMITS.parts &&
    Object.values(view).every((sites) => Object.keys(sites).length <= VIEW_LIMITS.sites) &&
    new TextEncoder().encode(JSON.stringify(view)).length <= VIEW_LIMITS.bytes
  );
}

/**
 * Whether the subscription a request is sent by, as `held` says, lacks what the page set of the
 * part `instance` showing `sites`: a set state a site reads, or the values of its set states — of a
 * part the subscription names, as a request sends them (`{}` too, which one named without them
 * lacks); of one it names not, which it renders as at first, any.
 */
function unheld(
  instance: string,
  sites: Readonly<Record<string, SiteInputs>>,
  {
    held,
    kept,
    valuesOf,
  }: { readonly held: Held; readonly kept: StatesOf; readonly valuesOf: ValuesOf },
): boolean {
  const set = kept.get(instance);
  const holds = held.states.get(instance);
  if (
    set !== undefined &&
    inputsOf(sites).some((name) => set.has(name) && holds?.has(name) !== true)
  ) {
    return true;
  }
  const values = valuesOf(instance);
  if (values === undefined || !carriesSet(sites)) {
    return false;
  }
  const text = held.values.get(instance);
  return text === undefined ? Object.keys(values).length > 0 : valuesText(values) !== text;
}

/**
 * The parts a request names: those the page shows otherwise than the frame, `changed`, and each of
 * `shown`, what the page shows, a state of which the page set (`kept`) though the subscription the
 * request is sent by does not hold its value (`held`) — the authority would else render that
 * state's site of its own value, which the page no longer takes. Those go as far as a request
 * carries (`carries`), the changed first; `rest` says whether some were left for a request after,
 * once the answer to this one holds these — where it named one, so that a part no request carries
 * alone is asked for no more. The changed count where no frame answered the view the page shows
 * (`answered`), whose answer shows them and leaves the next request the room they took; once one
 * did, the frame shows what the authority renders of them, which another request would not change.
 */
export function namedParts(
  shown: View,
  changed: View,
  state: {
    readonly answered: boolean;
    readonly held: Held;
    readonly kept: StatesOf;
    readonly valuesOf: ValuesOf;
  },
): { readonly named: View; readonly rest: boolean } {
  const { kept, valuesOf } = state;
  const named: Record<string, Readonly<Record<string, SiteInputs>>> = { ...changed };
  let added = !state.answered && Object.keys(changed).length > 0;
  let left = false;
  for (const [instance, sites] of Object.entries(shown)) {
    if (Object.hasOwn(named, instance) || !unheld(instance, sites, state)) {
      continue;
    }
    const more = { ...named };
    own(more, instance, sites);
    if (carries(sentInputs(more, kept, valuesOf))) {
      own(named, instance, sites);
      added = true;
    } else {
      left = true;
    }
  }
  return { named, rest: added && left };
}

/**
 * Of each part `view` names, the states whose values it sends — its sites' inputs, by name — and
 * where it sends the part's set values, the text of all of them, as `valuesOf` says them (those its
 * sites carry are its `SET_STATES`' too, to the authority).
 */
export function sendsOf(view: View, valuesOf?: ValuesOf): Held {
  const states = new Map<string, ReadonlySet<string>>();
  const values = new Map<string, string>();
  for (const [instance, sites] of Object.entries(view)) {
    states.set(instance, new Set(inputsOf(sites)));
    const sent = Object.hasOwn(sites, SET_STATES);
    values.set(instance, sent ? valuesText(valuesOf?.(instance) ?? sites[SET_STATES]) : '');
  }
  return { states, values };
}

/** What no subscription holds. */
export const NOTHING_HELD: Held = { states: new Map(), values: new Map() };

/**
 * What a frame's subscription holds, which a request `sends` was answered by, sent by one that held
 * `before`: the parts the request named, over what that one held of the rest — a part the frame
 * renders not, its parent's conditions took it away, of nothing.
 */
export function heldAfter(before: Held, sends: Held, rendered: View): Held {
  const states = new Map(before.states);
  const values = new Map(before.values);
  for (const [instance, sent] of sends.states) {
    if (Object.hasOwn(rendered, instance)) {
      states.set(instance, sent);
      values.set(instance, sends.values.get(instance) ?? '');
    } else {
      states.delete(instance);
      values.delete(instance);
    }
  }
  return { states, values };
}

/** What `held` says, but of the part `instance`, no longer rendered. */
export function heldWithout(held: Held, instance: string): Held {
  const states = new Map(held.states);
  const values = new Map(held.values);
  states.delete(instance);
  values.delete(instance);
  return { states, values };
}

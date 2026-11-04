import { type Json, SET_STATES, type SiteInputs } from '../program.ts';
import { HTTP_BAD_REQUEST } from '../status.ts';
import { AuthorityError } from './errors.ts';
import { kindOf } from './render.ts';
import type { ClientOutput, JsonKind } from './skeleton.ts';

/**
 * What a page's view says of a part's local states beside its sites: the values of those the page
 * has set (`SET_STATES`). A part the view names with them shows the sites it names and, of the
 * others, each its conditions show of those values and of the authority's own for the states the
 * page still follows — a site a followed state opens shows in the frame that brings the state's
 * value. One the view names without them shows the sites it names alone.
 */

/**
 * Whether a value of `given` kind may be sent for a state whose first value was of `first` kind:
 * the same kind, or `null` on either side — a state that starts as `null` is set to a value, and
 * one that starts as a value set to `null`, where its type allows, which the compile does not read.
 */
export function kindFits(given: JsonKind, first: JsonKind | undefined): boolean {
  return given === first || given === 'null' || first === 'null';
}

/** A view's statement of a part's states that no page makes: the whole view's refusal. */
function invalidSet(message: string): Error {
  return new AuthorityError(message, { code: 'INVALID_VIEW', status: HTTP_BAD_REQUEST });
}

/**
 * The values a view's entry for a part, `entry`, says the page set of the part's states: of each a
 * local state of the part's now, of the kind its first value is, or `null` where either is. What is
 * none of those — a state bound to a field since the page set it, a subscription's view of before —
 * is the authority's to render of its own value, as a state the page follows.
 */
export function setStatesOf(
  entry: Readonly<Record<string, unknown>>,
  output: ClientOutput,
): Readonly<Record<string, Json>> {
  if (!Object.hasOwn(entry, SET_STATES)) {
    return {};
  }
  const set = entry[SET_STATES];
  if (typeof set !== 'object' || set === null || Array.isArray(set)) {
    throw invalidSet('The states a view sets of a part are an object of their values.');
  }
  const values: Record<string, Json> = {};
  for (const [name, value] of Object.entries(set as Readonly<Record<string, Json>>)) {
    const state = Object.hasOwn(output.states, name) ? output.states[name] : undefined;
    if (state !== undefined && 'value' in state && kindFits(kindOf(value), kindOf(state.value))) {
      Object.defineProperty(values, name, { enumerable: true, value });
    }
  }
  return values;
}

/**
 * Into `set`, the values a site a view names carries, `inputs`, of the part's local states: those
 * the page set, which `SET_STATES` leaves out where the sites it names carry them alike.
 */
export function carryInputs(
  set: Record<string, Json>,
  inputs: SiteInputs,
  output: ClientOutput,
): void {
  for (const [name, value] of Object.entries(inputs)) {
    const state = Object.hasOwn(output.states, name) ? output.states[name] : undefined;
    if (state !== undefined && 'value' in state) {
      Object.defineProperty(set, name, { configurable: true, enumerable: true, value });
    }
  }
}

/** Of `set`, the values of the states `inputs` names: what a site the view names not is given. */
export function setInputsOf(
  set: Readonly<Record<string, Json>>,
  inputs: readonly string[],
): SiteInputs {
  const given: Record<string, Json> = {};
  for (const name of inputs) {
    if (Object.hasOwn(set, name)) {
      Object.defineProperty(given, name, { enumerable: true, value: set[name] });
    }
  }
  return given;
}

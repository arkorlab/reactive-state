import type { Json } from '../program.ts';
import { toJson } from './json.ts';

/**
 * The states of each part the page has set (`ViewController.keep`), whose values a view request
 * sends: those a setter or a committed render told, which last while the part is rendered, and
 * those a render told as it rendered, which last until the part next commits — a render at a new
 * place may wait and never commit, and one let go of holds nothing there. Of each, the value the
 * part's last committed render held, or the one a render not committed yet holds, until the part
 * next commits — where JSON carries it; where it does not, that the part holds one it cannot send.
 */

/** How a state is told set: by a render as it renders (`lasting: false`), and of what value. */
export interface Keeping {
  readonly lasting?: boolean;
  readonly value?: unknown;
}

/** Of each part, by its instance, the states set. */
type Sets = Map<string, Set<string>>;

/** A set state's value that JSON carries not (`undefined`, `NaN`, a function): no request sends it. */
const UNSENT: unique symbol = Symbol('unsent');

/** Of each part, by its instance, the values of its set states, or that one is unsent. */
type Values = Map<string, Map<string, Json | typeof UNSENT>>;

/**
 * Of each object a set state held, its copy as JSON, or that JSON carries it not: a render tells
 * the value as it renders, whatever else changed, and the same object is copied once.
 */
const COPIES = new WeakMap<WeakKey, Json | typeof UNSENT>();

/** `value` as a request sends it, or `UNSENT` where JSON carries it not. */
function copied(value: unknown): Json | typeof UNSENT {
  const held = typeof value === 'object' && value !== null ? value : undefined;
  if (held !== undefined && COPIES.has(held)) {
    return COPIES.get(held) as Json | typeof UNSENT;
  }
  let copy: Json | typeof UNSENT;
  try {
    copy = toJson(value);
  } catch {
    // What JSON carries not is sent of no site either, and the authority would show a site of its
    // own value: the part holds one it cannot send.
    copy = UNSENT;
  }
  if (held !== undefined) {
    COPIES.set(held, copy);
  }
  return copy;
}

function add(sets: Sets, instance: string, key: string): void {
  let set = sets.get(instance);
  if (set === undefined) {
    set = new Set();
    sets.set(instance, set);
  }
  set.add(key);
}

export class SetStates {
  readonly #lasting: Sets = new Map();
  readonly #rendering: Sets = new Map();
  readonly #values: Values = new Map();
  readonly #renderingValues: Values = new Map();

  /** The page set the state `key` of the part `instance`, as `keeping` says. */
  keep(instance: string, key: string, keeping: Keeping = {}): void {
    const lasting = keeping.lasting !== false;
    add(lasting ? this.#lasting : this.#rendering, instance, key);
    if (!('value' in keeping)) {
      return;
    }
    const all = lasting ? this.#values : this.#renderingValues;
    let values = all.get(instance);
    if (values === undefined) {
      values = new Map();
      all.set(instance, values);
    }
    values.set(key, copied(keeping.value));
  }

  /** A render of the part committed: what renders told of it before is let go of. */
  committed(instance: string): void {
    this.#rendering.delete(instance);
    this.#renderingValues.delete(instance);
  }

  /** The part is no longer rendered: rendered again, it starts its states anew. */
  released(instance: string): void {
    this.#lasting.delete(instance);
    this.#rendering.delete(instance);
    this.#values.delete(instance);
    this.#renderingValues.delete(instance);
  }

  /** Of each part, the states set: lasting, and told by a render not committed yet. */
  get kept(): ReadonlyMap<string, ReadonlySet<string>> {
    const kept = new Map<string, Set<string>>();
    for (const sets of [this.#lasting, this.#rendering]) {
      for (const [instance, keys] of sets) {
        for (const key of keys) {
          add(kept, instance, key);
        }
      }
    }
    return kept;
  }

  /**
   * Of the part `instance`, the values of its set states: its last committed render's, under those a
   * render not committed yet holds; `undefined` where one of them is a value JSON carries not.
   */
  valuesOf(instance: string): Readonly<Record<string, Json>> | undefined {
    const values = new Map(this.#values.get(instance));
    const rendering = this.#renderingValues.get(instance);
    if (rendering !== undefined) {
      for (const [key, value] of rendering) {
        values.set(key, value);
      }
    }
    const sent: Record<string, Json> = {};
    for (const [key, value] of values) {
      if (value === UNSENT) {
        return undefined;
      }
      Object.defineProperty(sent, key, { enumerable: true, value });
    }
    return sent;
  }
}

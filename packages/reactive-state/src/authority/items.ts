import { type Json, type SiteInputs, type SiteItem, VIEW_LIMITS } from '../program.ts';
import { frozenJson, isJson } from './canonical.ts';
import { withinSteps } from './steps.ts';

/** An item of a list site, checked: its key as text, its item a frozen copy of its JSON. */
export interface CheckedItem {
  readonly key: string;
  readonly item: Json;
  readonly render: () => unknown;
}

/**
 * The items the list site `site` renders of `inputs`, as its `each` answers them, checked: each
 * keyed by text or a number — kept as text, as React keeps a key — no key twice, each item JSON,
 * at most `VIEW_LIMITS.items` of them. `refuse` makes what each check that fails throws.
 */
export function itemsOf(
  site: string,
  each: (inputs: SiteInputs) => readonly SiteItem[],
  inputs: SiteInputs,
  refuse: (message: string) => Error,
): readonly CheckedItem[] {
  const answered: unknown = each(inputs);
  if (!Array.isArray(answered)) {
    throw new TypeError(
      `The list ${site} answered no array of items: compile the application again.`,
    );
  }
  // Its length bounds what is looked at of it, holes counted — a sparse array is as long as it says
  // at no cost — before its items are.
  const length = answered.length;
  if (length > VIEW_LIMITS.items) {
    throw refuse(
      `The list ${site} holds ${String(length)} entries, more than the ${String(VIEW_LIMITS.items)} a site renders.`,
    );
  }
  // A hole of a sparse array is none of its items, as React renders one: nothing.
  const items: CheckedItem[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const entry = entryAt(answered, index, site, refuse);
    if (entry === undefined) {
      continue;
    }
    const { item, key, render } = entry;
    if (!(typeof key === 'string' || (typeof key === 'number' && Number.isFinite(key)))) {
      throw refuse(`An item of the list ${site} has no key of text or a number.`);
    }
    const text = String(key);
    if (keys.has(text)) {
      throw refuse(`The list ${site} holds the key ${JSON.stringify(text)} twice.`);
    }
    keys.add(text);
    if (!isJson(item)) {
      throw refuse(`The item ${JSON.stringify(text)} of the list ${site} is no JSON.`);
    }
    items.push({ item: frozenJson(item), key: text, render: () => withinSteps(render) });
  }
  return items;
}

/** A stored own entry, with missing indices left as holes and accessors refused without a read. */
function entryAt(
  answered: readonly unknown[],
  index: number,
  site: string,
  refuse: (message: string) => Error,
): SiteItem | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(answered, index);
  if (descriptor === undefined) {
    return undefined;
  }
  if (!('value' in descriptor)) {
    throw refuse(`The list ${site} holds an accessor at entry ${String(index)}.`);
  }
  const value: unknown = descriptor.value;
  if (value === undefined) {
    return undefined;
  }
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw refuse(`The list ${site} holds no entry record at index ${String(index)}.`);
  }
  const key = Object.getOwnPropertyDescriptor(value, 'key');
  const item = Object.getOwnPropertyDescriptor(value, 'item');
  const render = Object.getOwnPropertyDescriptor(value, 'render');
  if (
    key === undefined ||
    item === undefined ||
    render === undefined ||
    !('value' in key) ||
    !('value' in item) ||
    !('value' in render)
  ) {
    throw refuse(`The list ${site} holds no own data fields at entry ${String(index)}.`);
  }
  const callback: unknown = render.value;
  if (typeof callback !== 'function') {
    throw refuse(`The list ${site} holds no render function at entry ${String(index)}.`);
  }
  return {
    item: item.value as Json,
    key: key.value as SiteItem['key'],
    render: callback as SiteItem['render'],
  };
}

/**
 * The items of `inputs`, as `itemsOf` checks them, or none where they break what a list is held to
 * — more items than a site renders, a key twice, an item of no JSON. Nothing is refused for it but
 * the list: it shows nothing at first, and a binding issued inside it finds its item no more. A
 * fault of `each` itself is thrown as it is.
 */
export function itemsWithin(
  site: string,
  each: (inputs: SiteInputs) => readonly SiteItem[],
  inputs: SiteInputs,
  invalid?: (message: string) => void,
): readonly CheckedItem[] | undefined {
  const refused = new Map<unknown, string>();
  const refuse = (message: string): Error => {
    const error = new Error(message);
    refused.set(error, message);
    return error;
  };
  try {
    return itemsOf(site, each, inputs, refuse);
  } catch (error) {
    const message = refused.get(error);
    if (message !== undefined) {
      invalid?.(message);
      return undefined;
    }
    throw error;
  }
}

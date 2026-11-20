import {
  type ArrowFunction,
  type Expression,
  type FunctionExpression,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isFunctionExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParenthesizedExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  type Node,
  type ObjectLiteralElementLike,
  type ReturnStatement,
} from 'typescript/ast';

import type { HookCall, OwnedState, TopLevel } from './analyze.ts';
import type { Fail } from './errors.ts';
import type { Fed, Item } from './hooks.ts';
import { functionOf } from './statements.ts';
import type { Setter, UpdaterSite, Uses, Writes } from './updaters.ts';

/**
 * What a custom hook returns, item by item, as its callers read it: the value of a state the
 * authority may hold, the setter of one, a function that writes one, or anything else — and what
 * the code that calls the hook holds through it.
 */

/**
 * Whether an item is the value of a state a parameter feeds, its setter, or a function that writes
 * one: what a caller reads from a hook it binds whole must not do. A state the hook starts itself
 * is the hook's own; its setter and its functions are followed only where the caller names them
 * one by one, and a hook bound whole stays untracked, as it was.
 */
function holdsFed(item: Item, fed: ReadonlyMap<string, Fed>): boolean {
  if (item.value !== undefined || (item.setter !== undefined && fed.has(item.setter.key))) {
    return true;
  }
  for (const keys of item.uses.values()) {
    if (keys.some((key) => fed.has(key))) {
      return true;
    }
  }
  return false;
}

/** What each name a hook's call binds is, item by item. */
function boundItems(call: HookCall): ReadonlyMap<string, Item> {
  const found = new Map<string, Item>();
  const { binding, hook } = call;
  const fail: Fail = hook.module.fail;
  if (binding.kind === 'whole') {
    const whole = hook.items.get('whole');
    let writes = false;
    for (const item of hook.items.values()) {
      writes ||= holdsFed(item, hook.fed);
    }
    if (whole !== undefined) {
      found.set(binding.name.text, whole);
    } else if (writes) {
      fail(
        `What \`${hook.name}\` returns is named item by item where it is called — \`const [a, b] = ${hook.name}(…)\` — since some of it writes a state, or is one.`,
        binding.name,
      );
    }
    return found;
  }
  for (const [item, name] of binding.names) {
    const shape = hook.items.get(item);
    if (shape === undefined) {
      fail(`\`${hook.name}\` returns no item \`${item}\` for \`${name.text}\` to name.`, name);
    }
    found.set(name.text, shape);
  }
  return found;
}

/** `uses`, its keys as a caller whose call of the hook keys its states with `prefix` names them. */
function prefixed(uses: Uses, prefix: string): Uses {
  return new Map([...uses].map(([id, keys]) => [id, keys.map((key) => `${prefix}${key}`)]));
}

/** What a body holds through the custom hooks it calls. */
export interface Held {
  /** The setters it holds of states the authority may hold, by name. */
  readonly setters: Map<string, Setter>;
  /** The functions it holds that write, by name, with what they write. */
  readonly writing: Map<string, Uses>;
  /** The updaters of the hooks it calls, by id. */
  readonly sites: Map<string, UpdaterSite>;
}

/** What a body that declares `states` holds through the custom hooks among them. */
export function heldThroughHooks(states: readonly OwnedState[]): Held {
  const held: Held = { setters: new Map(), sites: new Map(), writing: new Map() };
  for (const state of states) {
    if (state.kind === 'state') {
      continue;
    }
    for (const [id, site] of state.hook.sites) {
      held.sites.set(id, site);
    }
    for (const [name, item] of boundItems(state)) {
      if (item.setter !== undefined) {
        const key = `${state.prefix}${item.setter.key}`;
        held.setters.set(name, { ...item.setter, key, site: key });
      }
      if (item.uses.size > 0) {
        held.writing.set(name, prefixed(item.uses, state.prefix));
      }
    }
  }
  return held;
}

/** Whether `node` is a function written as an item: `return [value, () => …]`. */
function isFunctionItem(node: Node): node is ArrowFunction | FunctionExpression {
  return isArrowFunction(node) || isFunctionExpression(node);
}

const BY_NAME =
  'A custom hook returns its items by name, each where its callers find it: `{ value, update }`.';

/** What a hook returns, past the parentheses, the `as const` and the `satisfies` around it. */
function returnedExpression(returned: ReturnStatement): Expression | undefined {
  let expression = returned.expression;
  while (
    expression !== undefined &&
    (isParenthesizedExpression(expression) ||
      isAsExpression(expression) ||
      isSatisfiesExpression(expression))
  ) {
    expression = expression.expression;
  }
  return expression;
}

/** The items of what a hook returns: an array's by index, an object's by name, or the one value whole. */
export function itemsOf(returned: ReturnStatement, fail: Fail): ReadonlyMap<string, Expression> {
  const expression = returnedExpression(returned);
  if (expression === undefined) {
    return new Map();
  }
  if (isArrayLiteralExpression(expression)) {
    return new Map(
      expression.elements.map((element, index) => {
        if (isSpreadElement(element) || isOmittedExpression(element)) {
          fail(
            'A custom hook returns its items one by one, each where its callers find it: no spread, no hole.',
            element,
          );
        }
        return [String(index), unparenthesized(element)];
      }),
    );
  }
  if (!isObjectLiteralExpression(expression)) {
    return new Map([['whole', expression]]);
  }
  return new Map(expression.properties.map((property) => propertyItem(property, fail)));
}

/** An item a hook returns by name: `{ value }`, or `{ update: increase }`. */
function propertyItem(
  property: ObjectLiteralElementLike,
  fail: Fail,
): readonly [string, Expression] {
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    return [property.name.text, property.name];
  }
  if (!isPropertyAssignment(property)) {
    return fail(BY_NAME, property);
  }
  const { name } = property;
  if (!isIdentifier(name) && !isStringLiteral(name)) {
    return fail(BY_NAME, property);
  }
  return [name.text, unparenthesized(property.initializer)];
}

function unparenthesized(expression: Expression): Expression {
  let node = expression;
  while (isParenthesizedExpression(node)) {
    node = node.expression;
  }
  return node;
}

/** What a hook's body holds, which its items are made of. */
export interface ItemContext {
  readonly fed: ReadonlyMap<string, Fed>;
  readonly names: ReadonlyMap<string, TopLevel>;
  readonly held: Held;
  readonly writes: Writes;
}

/** What an item a hook returns is to its callers. */
export function itemOf(node: Node, context: ItemContext): Item {
  const plain: Item = { node, setter: undefined, uses: new Map(), value: undefined };
  if (isFunctionItem(node)) {
    return { ...plain, uses: context.writes.usesOf(node) };
  }
  const entry = isIdentifier(node) ? context.names.get(node.text) : undefined;
  if (entry === undefined || !isIdentifier(node)) {
    return plain;
  }
  if (entry.kind === 'state') {
    return context.fed.has(entry.state.value.text)
      ? { ...plain, value: entry.state.value.text }
      : plain;
  }
  if (entry.kind === 'setter') {
    return { ...plain, setter: context.held.setters.get(node.text) };
  }
  if (entry.kind === 'hooked') {
    const value = entry.call.hook.items.get(entry.item)?.value;
    return {
      node,
      setter: context.held.setters.get(node.text),
      uses: context.held.writing.get(node.text) ?? new Map(),
      value: value === undefined ? undefined : `${entry.call.prefix}${value}`,
    };
  }
  const fn = entry.kind === 'constant' ? functionOf(entry.declaration) : undefined;
  return fn === undefined ? plain : { ...plain, uses: context.writes.usesOf(fn) };
}

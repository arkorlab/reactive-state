import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import type { AssignedFrameSource } from './framed-assignment-patterns.ts';
import { framedHeldValues } from './framed-held-members.ts';
import { framedObjectSources } from './framed-object-members.ts';

/** What a member path of a value a construction passes on selects, as written values show it. */

/** A key no written name spells, which selects the fields whose computed names are not read. */
const UNREAD_NAME = '\0';

/**
 * The values a member path selects from a written value: an object literal's fields and its
 * getters' returns, an array literal's element at a written index (the whole array where a spread
 * hides the positions), and what a variable holds on the path where `point` reads it. A path no
 * written value resolves stays keyed on the value it reached.
 */
export function framedSelectedValues(
  value: Expression,
  keys: readonly string[],
  point: Node,
): readonly AssignedFrameSource[] {
  const found: AssignedFrameSource[] = [];
  const seen = new Set<Node>();
  const pending: AssignedFrameSource[] = [{ value, keys }];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const node = unwrapped(at.value);
    if (at.keys.length === 0 || seen.has(node)) {
      found.push(at);
      continue;
    }
    seen.add(node);
    const next = selectedStep(node, at.keys, point);
    if (next === undefined) found.push(at);
    else pending.push(...next);
  }
  return found;
}

/** One step along the path: an array element, an object literal's fields, a variable's values. */
function selectedStep(
  node: Expression,
  keys: readonly string[],
  point: Node,
): readonly AssignedFrameSource[] | undefined {
  if (isArrayLiteralExpression(node)) return arrayElements(node, keys);
  const sources = framedObjectSources(node, keys);
  if (sources !== undefined) return sources;
  if (!isIdentifier(node)) return undefined;
  const held = framedHeldValues(node, keys, point);
  if (held === undefined) return undefined;
  return held.initial === undefined ? held.held : [...held.held, held.initial];
}

/** The element a written index selects; a key other than an index selects no element's words. */
function arrayElements(
  array: ArrayLiteralExpression,
  keys: readonly string[],
): readonly AssignedFrameSource[] {
  const [key, ...rest] = keys;
  const index = key === undefined ? undefined : elementIndex(key);
  if (index === undefined) return [];
  for (const [position, element] of array.elements.entries()) {
    if (isSpreadElement(element)) return [{ value: array, keys: [] }];
    if (position === index) return [{ value: element, keys: rest }];
  }
  return [];
}

/** A canonical array index, as a written key spells it. */
function elementIndex(key: string): number | undefined {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key ? index : undefined;
}

/**
 * The members a value holds at a member path where the next key is one the compile cannot read:
 * an object literal's fields and getters' returns, members a spread copies, an array literal's
 * elements, through what variables hold where `point` reads them. A value it cannot list stands
 * whole; a path no written value resolves stays keyed.
 */
export function framedSelectedMembers(
  value: Expression,
  keys: readonly string[],
  point: Node,
): readonly AssignedFrameSource[] {
  const found: AssignedFrameSource[] = [];
  const seen = new Set<Node>();
  const pending = [...framedSelectedValues(value, keys, point)];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const node = unwrapped(at.value);
    if (at.keys.length > 0 || seen.has(node)) {
      found.push(at);
      continue;
    }
    seen.add(node);
    const listed = writtenMembers(node, point);
    if (listed === undefined) found.push(at);
    else {
      for (const member of listed.members)
        found.push(...framedSelectedValues(member.value, member.keys, point));
      pending.push(...listed.sources);
    }
  }
  return found;
}

/**
 * The members a written value lists, and the values whose members it copies or holds: a spread's
 * source, or what a variable holds; `undefined` for a value the compile cannot list.
 */
function writtenMembers(
  node: Expression,
  point: Node,
):
  | {
      readonly members: readonly AssignedFrameSource[];
      readonly sources: readonly AssignedFrameSource[];
    }
  | undefined {
  if (isArrayLiteralExpression(node)) {
    return {
      members: node.elements.flatMap((element) =>
        isSpreadElement(element) ? [] : [{ keys: [], value: element }],
      ),
      sources: node.elements.flatMap((element) =>
        isSpreadElement(element) ? [{ keys: [], value: element.expression }] : [],
      ),
    };
  }
  if (isObjectLiteralExpression(node)) return objectMembers(node);
  if (!isIdentifier(node)) return undefined;
  const held = framedHeldValues(node, [], point);
  if (held === undefined) return undefined;
  const sources = held.initial === undefined ? held.held : [...held.held, held.initial];
  return { members: [], sources };
}

/** An object literal's own fields by each written name and one no written name takes, and its spreads. */
function objectMembers(object: ObjectLiteralExpression): {
  readonly members: readonly AssignedFrameSource[];
  readonly sources: readonly AssignedFrameSource[];
} {
  const names = new Set<string>([UNREAD_NAME]);
  const sources: AssignedFrameSource[] = [];
  for (const property of object.properties) {
    if (isSpreadAssignment(property)) sources.push({ keys: [], value: property.expression });
    else {
      const name = writtenArrayKey(property.name);
      if (name !== undefined) names.add(name);
    }
  }
  const members = [...names].flatMap((name) => framedObjectSources(object, [name]) ?? []);
  return { members, sources };
}

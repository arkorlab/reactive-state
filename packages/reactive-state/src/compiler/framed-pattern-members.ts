import {
  type ElementAccessExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isExpression,
  isForOfStatement,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type PropertyAccessExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import {
  type AssignedFrameSource,
  assignmentPatternTargets,
  iteratedFrameSources,
} from './framed-assignment-patterns.ts';
import { framedKeyNames } from './framed-keys.ts';

/**
 * The members a destructuring assignment or a loop head writes, with the values it hands them.
 *
 * Routed: a named key or a position, to the value a written source holds there; a default, by the
 * values that may be missing; a nested pattern; a computed key with finite names, to those fields.
 * Handed whole, to be followed by `selectedValues`: the path a pattern selects of a source it does
 * not read here, a computed key the compile cannot read (any field), an object rest (a copy that
 * leaves out the names its pattern lists), an array rest (the entries from its position).
 * Not followed: a write a call makes to a member (`Object.assign(descriptor, ...)`), an array
 * method, a member of an alias a pattern makes.
 */

export interface MemberWrite {
  readonly member: PropertyAccessExpression | ElementAccessExpression;
  readonly values: readonly MemberSource[];
}

/** A value a member is given: a rest gives a copy of its source without some of its fields. */
export interface MemberSource extends AssignedFrameSource {
  readonly without?: readonly string[];
  /** The member is given a list of the source's entries: an array rest, no getter and no descriptor. */
  readonly list?: boolean;
}

/**
 * The members a pattern writes: routed to the value each position selects, and a position the
 * routing does not select, a rest or a computed key, to any field of the values at its level.
 */
export function patternMemberWrites(node: Node): readonly MemberWrite[] {
  const start = patternStart(node);
  if (start === undefined) return [];
  const found: MemberWrite[] = [];
  const pending = [start];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const target = unwrapped(at.target);
    if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
      found.push({ member: target, values: at.sources });
      continue;
    }
    const routed = assignmentPatternTargets(target, at.sources);
    pending.push(...routed);
    const covered = new Set<Node>(routed.map((each) => each.target));
    for (const unrouted of unroutedChildren(target)) {
      if (covered.has(unrouted.child)) continue;
      pending.push({ target: unrouted.child, sources: takenSources(at.sources, unrouted) });
    }
  }
  return found;
}

/** The pattern a node assigns, with the sources its right side or iterable hands it. */
function patternStart(
  node: Node,
): { readonly target: Expression; readonly sources: readonly AssignedFrameSource[] } | undefined {
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken)
    return { target: node.left, sources: [{ value: node.right, keys: [] }] };
  if (isForOfStatement(node) && isExpression(node.initializer))
    return { target: node.initializer, sources: iteratedFrameSources(node.expression) };
  return undefined;
}

/** A target the routing leaves out, and what it takes of the source: a copy, or fields. */
interface Unrouted {
  readonly child: Expression;
  /** A rest that is a member takes a copy of the source, without the names its pattern lists. */
  readonly copy: boolean;
  /** The finite names a computed key may take; none where they are unknown. */
  readonly keys?: readonly string[] | undefined;
  readonly without: readonly string[];
  /** The position an array rest starts at: it takes the entries from there on. */
  readonly suffix?: number | undefined;
}

/**
 * The targets of a pattern a rest or a computed key names. A rest that is a member takes a copy of
 * the source, no field of it; a computed key takes the fields its names allow, or any; a rest that
 * is a pattern takes any field.
 */
function unroutedChildren(target: Expression): readonly Unrouted[] {
  if (isArrayLiteralExpression(target))
    return target.elements.flatMap((each, at) =>
      isSpreadElement(each) ? [{ ...restOf(each.expression, []), suffix: at }] : [],
    );
  if (!isObjectLiteralExpression(target)) return [];
  const listed: string[] = [];
  for (const property of target.properties) {
    const name = isSpreadAssignment(property) ? undefined : listedName(property.name);
    if (name !== undefined) listed.push(name);
  }
  return target.properties.flatMap((property): Unrouted[] => {
    if (isSpreadAssignment(property)) return [restOf(property.expression, listed)];
    if (!isPropertyAssignment(property)) return [];
    return [
      { child: property.initializer, copy: false, keys: keyNames(property.name), without: [] },
    ];
  });
}

/**
 * The name a field of a pattern takes out of what a rest copies: written out, or a computed key the
 * compile reads as one name, a constant holding it; none where it may be one of several.
 */
function listedName(name: PropertyName): string | undefined {
  const written = writtenArrayKey(name);
  if (written !== undefined) return written;
  const names = keyNames(name);
  return names?.length === 1 ? names[0] : undefined;
}

/** A rest target: a member takes the copy itself, a pattern the fields of the copy. */
function restOf(child: Expression, without: readonly string[]): Unrouted {
  const member = unwrapped(child);
  const copy = isPropertyAccessExpression(member) || isElementAccessExpression(member);
  return { child, copy, without };
}

/** The finite names a computed key may take, none where it is not computed or they are unknown. */
function keyNames(name: PropertyName): readonly string[] | undefined {
  if (!isComputedPropertyName(name)) return undefined;
  const names = framedKeyNames(name.expression);
  return names === undefined || names.length === 0 ? undefined : names;
}

/**
 * The path key of a pattern's take of any field of a source: a computed key whose names the compile
 * cannot read. It is a name no written field has, so a field named by a program is never taken for it.
 */
export const ANY_FIELD = '\0any';

const FROM = '\0from:';

/** The path key of an array rest's take of the entries of a source from a position on. */
export function fromKey(position: number): string {
  return `${FROM}${String(position)}`;
}

/** The position a path key takes the entries from, none for any other key. */
export function suffixStart(key: string): number | undefined {
  return key.startsWith(FROM) ? Number(key.slice(FROM.length)) : undefined;
}

/** The entries of a source from a position on, which an array rest gives its member as a list. */
function listOf(source: AssignedFrameSource, suffix: number): MemberSource {
  return { value: source.value, keys: [...source.keys, fromKey(suffix)], list: true };
}

/** What a target the routing left out takes of the sources. */
function takenSources(
  sources: readonly AssignedFrameSource[],
  { copy, keys, without, suffix }: Unrouted,
): readonly AssignedFrameSource[] {
  if (copy && suffix !== undefined) return sources.map((source) => listOf(source, suffix));
  if (copy) return sources.map((source): MemberSource => ({ ...source, without }));
  const names = keys ?? [ANY_FIELD];
  return sources.flatMap((source) =>
    names.map((name) => ({ value: source.value, keys: [...source.keys, name] })),
  );
}

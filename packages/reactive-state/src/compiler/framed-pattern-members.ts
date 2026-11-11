import {
  type ElementAccessExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
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
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import {
  type AssignedFrameSource,
  assignmentPatternTargets,
  iteratedFrameSources,
} from './framed-assignment-patterns.ts';

/** The members a destructuring assignment or a loop head writes, with the values it hands them. */

export interface MemberWrite {
  readonly member: PropertyAccessExpression | ElementAccessExpression;
  readonly values: readonly AssignedFrameSource[];
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
    for (const { child, copies } of unroutedChildren(target)) {
      if (covered.has(child)) continue;
      pending.push({ target: child, sources: copies ? at.sources : anyField(at.sources) });
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

/** A target the routing leaves out, and whether it takes a copy of the source or any field of it. */
interface Unrouted {
  readonly child: Expression;
  readonly copies: boolean;
}

/**
 * The targets of a pattern a rest or a computed key names. A rest that is a member takes a copy of
 * the source whole, no field of it; a computed key, or a rest that is a pattern, takes any field.
 */
function unroutedChildren(target: Expression): readonly Unrouted[] {
  if (isArrayLiteralExpression(target))
    return target.elements.flatMap((each) =>
      isSpreadElement(each) ? [rest(each.expression)] : [],
    );
  if (!isObjectLiteralExpression(target)) return [];
  return target.properties.flatMap((property): Unrouted[] => {
    if (isSpreadAssignment(property)) return [rest(property.expression)];
    return isPropertyAssignment(property) ? [{ child: property.initializer, copies: false }] : [];
  });
}

/** A rest target: a member takes the copy itself, a pattern the fields of the copy. */
function rest(child: Expression): Unrouted {
  const member = unwrapped(child);
  return { child, copies: isPropertyAccessExpression(member) || isElementAccessExpression(member) };
}

/** The path key of a pattern's take of any field of a source: a computed key it cannot read. */
export const ANY_FIELD = '*';

/**
 * Any field of the sources, left to the reader that follows a path: the values a written object or
 * list holds, spreads and getters among them, and those of the constant, the condition or the
 * parameter that stands for one.
 */
function anyField(sources: readonly AssignedFrameSource[]): readonly AssignedFrameSource[] {
  return sources.map((source) => ({ value: source.value, keys: [...source.keys, ANY_FIELD] }));
}

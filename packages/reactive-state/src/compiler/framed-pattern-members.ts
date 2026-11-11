import {
  type ElementAccessExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isElementAccessExpression,
  isExpression,
  isForOfStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
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
    for (const child of unroutedChildren(target)) {
      if (!covered.has(child)) pending.push({ target: child, sources: anyField(at.sources) });
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

/** The targets of a pattern a spread or a computed key names: where it takes any field. */
function unroutedChildren(target: Expression): readonly Expression[] {
  if (isArrayLiteralExpression(target))
    return target.elements.flatMap((each) => (isSpreadElement(each) ? [each.expression] : []));
  if (!isObjectLiteralExpression(target)) return [];
  return target.properties.flatMap((property): Expression[] => {
    if (isSpreadAssignment(property)) return [property.expression];
    return isPropertyAssignment(property) ? [property.initializer] : [];
  });
}

/** Any field of the sources: the values of a written object, the elements of a written list. */
function anyField(sources: readonly AssignedFrameSource[]): readonly AssignedFrameSource[] {
  return sources.flatMap((source) => {
    const value = unwrapped(source.value);
    if (isArrayLiteralExpression(value))
      return value.elements.map((element) => ({ value: element, keys: [] }));
    if (!isObjectLiteralExpression(value)) return [source];
    return value.properties.flatMap((property): AssignedFrameSource[] => {
      if (isPropertyAssignment(property)) return [{ value: property.initializer, keys: [] }];
      if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
        return [{ value: property.name, keys: [] }];
      return isSpreadAssignment(property) ? [{ value: property.expression, keys: [] }] : [];
    });
  });
}

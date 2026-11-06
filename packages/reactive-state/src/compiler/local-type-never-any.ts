import { factory, isIntersectionTypeNode, isUnionTypeNode, SyntaxKind } from 'typescript/ast';

import { typeReadingKey, type TypeReading } from './local-type-environment.ts';
import { intersectionNeverTruth } from './local-type-intersection-never.ts';

/** Written whole-any operands retain native conditional relations before constituent comparisons. */

type Resolve = (reading: TypeReading) => TypeReading | undefined;
type Compare = (source: TypeReading, target: TypeReading) => boolean | undefined;

const NEVER = factory.createKeywordTypeNode(SyntaxKind.NeverKeyword);

/** Written any keeps its original environment; synthetic uncertainty and nested values prove no any. */
export function normalizedAnyOperand(
  at: TypeReading | undefined,
  resolve: Resolve,
  compare: Compare,
): TypeReading | undefined {
  if (at === undefined) return undefined;
  const extended = { ...at, type: NEVER };
  const pending = [at];
  const seen = new Set<string>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const reading = resolve(next) ?? next;
    const key = typeReadingKey(reading);
    if (seen.has(key)) continue;
    seen.add(key);
    const { type } = reading;
    if (type.kind === SyntaxKind.AnyKeyword && type.pos >= 0) return reading;
    if (isIntersectionTypeNode(type) && emptyIntersection(reading, resolve, extended, compare))
      continue;
    if (isUnionTypeNode(type) || isIntersectionTypeNode(type)) {
      pending.push(...type.types.map((member) => ({ ...reading, type: member })));
    }
  }
  return at;
}

/** Existing exact-true empty operands and finite primitive emptiness still dominate an intersection. */
function emptyIntersection(
  at: TypeReading,
  resolve: Resolve,
  target: TypeReading,
  compare: Compare,
): boolean {
  if (intersectionNeverTruth(at, resolve) === true) return true;
  if (!isIntersectionTypeNode(at.type)) return false;
  return at.type.types.some((type) => {
    const operand = resolve({ ...at, type });
    return operand !== undefined && compare(operand, target) === true;
  });
}

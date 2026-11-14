import {
  isIntersectionTypeNode,
  isTemplateLiteralTypeNode,
  isUnionTypeNode,
  SyntaxKind,
} from 'typescript/ast';

import type { LocalTypeBinding } from './local-type-aliases.ts';
import { conditionalUtilityReadings } from './local-type-conditional-utilities.ts';
import { typeReadingKey, type TypeReading } from './local-type-environment.ts';
import { intersectionNeverTruth } from './local-type-intersection-never.ts';
import { intrinsicStringArgument } from './local-type-intrinsic-keys.ts';
import { keyofNeverTruth } from './local-type-keyof.ts';
import { COMPARISON_PRIMITIVES } from './local-type-primitive-identities.ts';

/** Source-written template and intersection domains retain possible never before branch selection. */

interface Scope {
  readonly written: (
    reading: TypeReading,
    preserve?: ReadonlySet<LocalTypeBinding>,
  ) => TypeReading | undefined;
  readonly kind: (reading: TypeReading) => SyntaxKind | undefined;
  readonly selected: (reading: TypeReading) => TypeReading | undefined;
  readonly compare: (source: TypeReading, target: TypeReading) => boolean | undefined;
}

interface Parts {
  readonly mode: 'any' | 'all';
  readonly readings: readonly TypeReading[];
}

interface Combination {
  readonly start: number;
  readonly key: string;
  readonly parts: Parts;
}

/**
 * Whether an operand is never. An iterative product/union walk keeps every interpolation in its
 * original generic environment; an operand never or possibly never is not claimed nonempty.
 */
export function neverOperandTruth(at: TypeReading, scope: Scope): boolean | undefined {
  type Task = { readonly reading: TypeReading } | { readonly combination: Combination };

  const pending: Task[] = [{ reading: at }];
  const active = new Set<string>();
  const results: (boolean | undefined)[] = [];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if ('combination' in next) {
      const { start, key, parts } = next.combination;
      results.push(combined(parts, results.splice(start)));
      active.delete(key);
      continue;
    }
    const reading = scope.selected(next.reading) ?? next.reading;
    const key = typeReadingKey(reading);
    if (active.has(key)) {
      results.push(undefined);
      continue;
    }
    const parts = writtenParts(reading, scope);
    if (parts === undefined) {
      results.push(leafEmpty(reading, scope));
      continue;
    }
    active.add(key);
    pending.push({ combination: { start: results.length, key, parts } });
    for (const source of parts.readings.toReversed()) pending.push({ reading: source });
  }
  return results[0];
}

/** One empty interpolation empties a product; every alternative must be empty to empty a union. */
function combined(parts: Parts, values: readonly (boolean | undefined)[]): boolean | undefined {
  const decisive = parts.mode === 'any';
  if (values.includes(decisive)) return decisive;
  return values.includes(undefined) ? undefined : !decisive;
}

/** Native case maps and settled conditional utilities preserve their argument's empty result. */
function writtenParts(at: TypeReading, scope: Scope): Parts | undefined {
  const { type } = at;
  if (isTemplateLiteralTypeNode(type)) {
    return {
      mode: 'any',
      readings: type.templateSpans.map((span) => ({ ...at, type: span.type })),
    };
  }
  if (isUnionTypeNode(type)) {
    return {
      mode: 'all',
      readings: type.types.map((source) => ({ ...at, type: source })),
    };
  }
  const mapping = intrinsicStringArgument(at);
  if (mapping !== undefined) return { mode: 'all', readings: [mapping.reading] };
  const utility = conditionalUtilityReadings(at, scope.selected, scope.compare);
  return utility === undefined ? undefined : { mode: 'all', readings: utility };
}

/**
 * A leaf is nonempty only when its written syntax says so. An unproved intersection, a parameter no
 * argument fills, an indexed access, a query, a mapping or a reference this file cannot read may
 * each be never, so none of them is claimed otherwise and a conditional on it keeps both branches.
 */
function leafEmpty(at: TypeReading, scope: Scope): boolean | undefined {
  if (isIntersectionTypeNode(at.type)) return intersectionNeverTruth(at, scope.selected);
  if (at.type.kind === SyntaxKind.NeverKeyword) return true;
  const keys = keyofNeverTruth(at, scope.written, scope.kind);
  return keys ?? (neverFree(at, scope) ? false : undefined);
}

/** A primitive, a literal or a written object shape; a mapped type over never is never, so it is not one. */
function neverFree(at: TypeReading, scope: Scope): boolean {
  if (at.type.kind === SyntaxKind.MappedType) return false;
  const kind = scope.kind(at);
  return (
    kind === SyntaxKind.UnknownKeyword || (kind !== undefined && COMPARISON_PRIMITIVES.has(kind))
  );
}

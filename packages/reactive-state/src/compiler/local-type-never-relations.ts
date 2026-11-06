import {
  isIdentifier,
  isIntersectionTypeNode,
  isTemplateLiteralTypeNode,
  isTypeParameterDeclaration,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
} from 'typescript/ast';

import { localTypeBinding, type LocalTypeBinding } from './local-type-aliases.ts';
import { conditionalUtilityReadings } from './local-type-conditional-utilities.ts';
import { typeReadingKey, type TypeReading } from './local-type-environment.ts';
import { intersectionNeverTruth } from './local-type-intersection-never.ts';
import { intrinsicStringArgument } from './local-type-intrinsic-keys.ts';
import { keyofNeverTruth } from './local-type-keyof.ts';

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

interface Domain {
  readonly empty: boolean | undefined;
  readonly template: boolean;
  readonly intersection: boolean;
}

interface Parts {
  readonly mode: 'any' | 'all';
  readonly template: boolean;
  readonly readings: readonly TypeReading[];
}

interface Combination {
  readonly start: number;
  readonly key: string;
  readonly parts: Parts;
}

/** Written templates and intersections preserve empty-domain proofs before branch selection. */
export function neverOperandTruth(at: TypeReading, scope: Scope): boolean | undefined {
  const result = templateDomain(at, scope);
  return result.template || result.intersection
    ? result.empty
    : (keyofNeverTruth(at, scope.written, scope.kind) ?? false);
}

/** An iterative product/union walk keeps every interpolation in its original generic environment. */
function templateDomain(at: TypeReading, scope: Scope): Domain {
  type Task = { readonly reading: TypeReading } | { readonly combination: Combination };

  const pending: Task[] = [{ reading: at }];
  const active = new Set<string>();
  const results: Domain[] = [];
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
      results.push({ empty: undefined, template: false, intersection: false });
      continue;
    }
    const parts = writtenParts(reading, scope);
    if (parts === undefined) {
      results.push({
        empty: leafEmpty(reading, scope),
        template: false,
        intersection: isIntersectionTypeNode(reading.type),
      });
      continue;
    }
    active.add(key);
    pending.push({ combination: { start: results.length, key, parts } });
    for (const source of parts.readings.toReversed()) pending.push({ reading: source });
  }
  return results[0] ?? { empty: undefined, template: false, intersection: false };
}

/** One empty interpolation empties a product; every alternative must be empty to empty a union. */
function combined(parts: Parts, values: readonly Domain[]): Domain {
  const decisive = parts.mode === 'any';
  let empty: boolean | undefined = !decisive;
  if (values.some((value) => value.empty === decisive)) empty = decisive;
  else if (values.some((value) => value.empty === undefined)) empty = undefined;
  return {
    empty,
    template: parts.template || values.some((value) => value.template),
    intersection: values.some((value) => value.intersection),
  };
}

/** Native case maps and settled conditional utilities preserve their argument's empty result. */
function writtenParts(at: TypeReading, scope: Scope): Parts | undefined {
  const { type } = at;
  if (isTemplateLiteralTypeNode(type)) {
    return {
      mode: 'any',
      readings: type.templateSpans.map((span) => ({ ...at, type: span.type })),
      template: true,
    };
  }
  if (isUnionTypeNode(type)) {
    return {
      mode: 'all',
      readings: type.types.map((source) => ({ ...at, type: source })),
      template: false,
    };
  }
  const mapping = intrinsicStringArgument(at);
  if (mapping !== undefined) return { mode: 'all', readings: [mapping.reading], template: false };
  const utility = conditionalUtilityReadings(at, scope.selected, scope.compare);
  return utility === undefined ? undefined : { mode: 'all', readings: utility, template: false };
}

/** Declared unbound spans and unproved intersections retain uncertainty in their own environments. */
function leafEmpty(at: TypeReading, scope: Scope): boolean | undefined {
  if (isIntersectionTypeNode(at.type)) return intersectionNeverTruth(at, scope.selected);
  if (at.type.kind === SyntaxKind.NeverKeyword) return true;
  if (unboundParameter(at)) return undefined;
  return keyofNeverTruth(at, scope.written, scope.kind) ?? false;
}

/** Only the original type parameter's missing actual argument adds an uncertain template span. */
function unboundParameter(at: TypeReading): boolean {
  const { type } = at;
  if (!isTypeReferenceNode(type) || !isIdentifier(type.typeName)) return false;
  const binding = localTypeBinding(type.typeName);
  return (
    binding !== undefined &&
    binding !== null &&
    isTypeParameterDeclaration(binding) &&
    !at.bindings.has(binding)
  );
}

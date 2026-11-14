import {
  factory,
  isExpressionWithTypeArguments,
  isIntersectionTypeNode,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isParenthesizedTypeNode,
  isUnionTypeNode,
  isTemplateLiteralTypeNode,
  SyntaxKind,
  TokenFlags,
} from 'typescript/ast';

import { typeReadingKey, type TypeReading } from './local-type-environment.ts';
import { actualQueryArgument } from './local-type-query-argument-scope.ts';
import { finiteIndexKeys } from './local-type-template-keys.ts';
import { literalKey, literalKind } from './local-type-utility-readings.ts';

/** Complete finite literal index intersections retain set membership and original type scopes. */

type Resolve = (reading: TypeReading) => TypeReading | undefined;
type Domain = ReadonlyMap<string, TypeReading>;

interface IndexStep {
  readonly kind: 'read' | 'node';
  readonly reading: TypeReading;
  readonly ancestors: ReadonlySet<string>;
}

interface CombinedStep {
  readonly kind: 'combine';
  readonly count: number;
  readonly intersection: boolean;
}

type Step = IndexStep | CombinedStep;

interface Expansion {
  readonly steps: readonly Step[];
  readonly domain?: Domain;
  readonly intersection?: true;
}

/** Only wholly known finite domains replace the preexisting indexed-operand alternatives. */
export function intersectedIndexReadings(
  at: TypeReading,
  resolve: Resolve,
): TypeReading[] | undefined {
  if (!actualQueryArgument(at)) return undefined;
  const pending: Step[] = [{ ancestors: new Set(), kind: 'read', reading: at }];
  const values: Domain[] = [];
  let intersection = false;
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    if (step.kind === 'combine') {
      const combined = combinedDomain(step, values);
      if (combined === undefined) return undefined;
      values.push(combined);
      continue;
    }
    const expansion = expandedIndex(step, resolve);
    if (expansion === undefined) return undefined;
    if (expansion.intersection === true) intersection = true;
    if (expansion.domain === undefined) pending.push(...expansion.steps);
    else values.push(expansion.domain);
  }
  return completedIndex(values, intersection);
}

/** Nonempty finite selections replace no existing opaque conditional or empty-index boundary. */
function completedIndex(
  values: readonly Domain[],
  intersection: boolean,
): TypeReading[] | undefined {
  const domain = values[0];
  if (domain === undefined || !intersection || values.length !== 1) return undefined;
  return domain.size === 0 ? undefined : [...domain.values()];
}

/** Alias and union alternatives keep each environment; nested intersections remain explicit. */
function expandedIndex(step: IndexStep, resolve: Resolve): Expansion | undefined {
  const { reading, ancestors } = step;
  if (step.kind === 'read') {
    const key = typeReadingKey(reading);
    if (ancestors.has(key)) return undefined;
    const readings = indexOperands(reading, resolve);
    if (readings.length === 0) return undefined;
    const path = new Set([...ancestors, key]);
    return {
      steps: [
        { count: readings.length, intersection: false, kind: 'combine' },
        ...readings
          .toReversed()
          .map((each): IndexStep => ({ ancestors: path, kind: 'node', reading: each })),
      ],
    };
  }
  const { type } = reading;
  if (isIntersectionTypeNode(type)) {
    return {
      intersection: true,
      steps: [
        { count: type.types.length, intersection: true, kind: 'combine' },
        ...type.types.toReversed().map((member): IndexStep => {
          const selected = { ...reading, type: member };
          return { ancestors, kind: 'read', reading: selected };
        }),
      ],
    };
  }
  const domain = literalDomain(reading, resolve);
  return domain === undefined ? undefined : { domain, steps: [] };
}

/** Union branches remain visible even when their original type cannot be resolved. */
function indexOperands(at: TypeReading, resolve: Resolve): readonly TypeReading[] {
  const result: TypeReading[] = [];
  const pending: IndexStep[] = [{ ancestors: new Set(), kind: 'read', reading: at }];
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    const key = typeReadingKey(step.reading);
    const reading = step.ancestors.has(key)
      ? step.reading
      : (resolve(step.reading) ?? step.reading);
    const path = new Set([...step.ancestors, key]);
    const { type } = reading;
    if (step.ancestors.has(key)) {
      result.push(reading);
    } else if (isParenthesizedTypeNode(type)) {
      pending.push({ ancestors: path, kind: 'read', reading: { ...reading, type: type.type } });
    } else if (isUnionTypeNode(type)) {
      for (const member of type.types) {
        pending.push({ ancestors: path, kind: 'read', reading: { ...reading, type: member } });
      }
    } else {
      result.push(reading);
    }
  }
  return result;
}

/**
 * String and numeric literal identities remain distinct until the final property selection; a
 * template without substitutions, `` `a` ``, is the string `'a'`, as a finite template key is.
 */
function literalDomain(at: TypeReading, resolve: Resolve): Domain | undefined {
  const { type } = at;
  if (isExpressionWithTypeArguments(type)) return undefined;
  if (type.kind === SyntaxKind.NeverKeyword) return new Map();
  if (isLiteralTypeNode(type)) {
    const key = literalKey(type);
    const kind = isNoSubstitutionTemplateLiteral(type.literal)
      ? SyntaxKind.StringKeyword
      : literalKind(type);
    return key === undefined ? undefined : new Map([[`${kind}:${key}`, at]]);
  }
  if (!isTemplateLiteralTypeNode(type)) return undefined;
  const keys = finiteIndexKeys(at, (reading) => indexOperands(reading, resolve));
  return keys === undefined
    ? undefined
    : new Map(
        keys.map((key) => {
          return [
            `${SyntaxKind.StringKeyword}:${key}`,
            {
              ...at,
              type: factory.createLiteralTypeNode(
                factory.createStringLiteral(key, TokenFlags.None),
              ),
            },
          ];
        }),
      );
}

/** Uniform set operators preserve an explicit empty domain rather than dropping a never result. */
function combinedDomain(step: CombinedStep, values: Domain[]): Domain | undefined {
  if (step.count === 0 || values.length < step.count) return undefined;
  const domains = values.splice(values.length - step.count, step.count);
  const result = new Map(domains[0]);
  for (const domain of domains.slice(1)) {
    if (step.intersection) {
      for (const key of result.keys()) if (!domain.has(key)) result.delete(key);
    } else {
      for (const [key, reading] of domain) result.set(key, reading);
    }
  }
  return result;
}

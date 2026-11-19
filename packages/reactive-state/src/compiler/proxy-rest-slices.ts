import {
  type Expression,
  isArrayLiteralExpression,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { arrayChangedBefore, arrayIndex, spreadElementOrigins } from './proxy-arrays.ts';
import {
  type Context,
  heldConstant,
  type Origin,
  peeled,
  propertyKey,
  writtenBefore,
} from './proxy-values.ts';

/** Static definedness classification for a destructuring slot or default check. */
export type PresenceStatus = 'defined' | 'possible' | 'undefined';

/** Source `Origin` optionally viewed through an array rest `.slice(sliceStart)` offset. */
export interface PatternSource {
  readonly origin: Origin;
  readonly sliceStart?: number | null | undefined;
}

interface ProjectedStep {
  readonly next?: Expression | undefined;
  readonly status?: PresenceStatus | undefined;
}

/** Own property names on `Object.prototype` that are inherited by plain `{}` literals. */
const OBJECT_PROTOTYPE_KEYS: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(Object.prototype),
);

/** Steps `source` through `key`, translating numeric indices when `source` is a sliced rest array. */
export function stepPatternSource(
  source: PatternSource | undefined,
  key: string | null,
): PatternSource | undefined {
  if (source === undefined) {
    return undefined;
  }
  if (source.sliceStart === undefined) {
    return { origin: { ...source.origin, keys: [...source.origin.keys, key] } };
  }
  if (key === null) {
    return { origin: { ...source.origin, keys: [...source.origin.keys, null] } };
  }
  const offset = arrayIndex(key);
  if (offset === undefined) {
    return undefined;
  }
  const mapped = source.sliceStart === null ? null : String(source.sliceStart + offset);
  return { origin: { ...source.origin, keys: [...source.origin.keys, mapped] } };
}

/** Slices `source` from `offset` (`null` when an earlier spread made the start unknown). */
export function slicePatternRest(
  source: PatternSource | undefined,
  offset: number | null,
): PatternSource | undefined {
  if (source === undefined) {
    return undefined;
  }
  if (source.sliceStart === undefined) {
    return { origin: source.origin, sliceStart: offset };
  }
  const combined =
    offset === null || source.sliceStart === null ? null : source.sliceStart + offset;
  return { origin: source.origin, sliceStart: combined };
}

/** Materializes `Origin`s when a leaf target binding or member expression is reached. */
export function finishPatternLeaf(
  source: PatternSource | undefined,
  readAt: Origin,
): readonly Origin[] {
  if (source === undefined) {
    return [];
  }
  return source.sliceStart === undefined
    ? [projectReadOrigin(source.origin, readAt)]
    : restSliceOrigins(source.origin, readAt);
}

/** Projects an object rest `{ ...target }` against a direct or rest-sliced `PatternSource`. */
export function patternObjectRestOrigins(
  source: PatternSource | undefined,
  readAt: Origin,
  omittedKeys: ReadonlySet<string>,
): readonly Origin[] {
  if (source === undefined) {
    return [];
  }
  return source.sliceStart === undefined
    ? objectRestOrigins(source.origin, readAt, omittedKeys)
    : slicedArrayObjectRestOrigins(source.origin, source.sliceStart, readAt, omittedKeys);
}

/** A rest array is fresh; only its indexed elements retain actual argument identities. */
export function restOrigins(given: readonly Origin[], at: Origin): readonly Origin[] {
  if (at.keys.length === 0) {
    return spreadElementOrigins(given, at);
  }
  const [key, ...rest] = at.keys;
  if (key === undefined || key === null) {
    return given.map((each) => {
      return {
        ...each,
        excluded: at.excluded,
        keys: [...each.keys, ...rest],
        spread: at.spread,
      };
    });
  }
  const index = arrayIndex(key);
  const selected = index === undefined ? undefined : given[index];
  return selected === undefined
    ? []
    : [
        {
          ...selected,
          excluded: at.excluded,
          keys: [...selected.keys, ...rest],
          spread: at.spread,
        },
      ];
}

/** Classifies whether a projected destructuring `source` is defined, `undefined`, or either. */
export function projectedOriginPresence(
  source: Origin,
  leafPresence: (origin: Origin) => PresenceStatus,
): PresenceStatus {
  if (source.keys.length === 0) {
    return leafPresence(source);
  }
  let current: Expression = source.value;
  for (const key of source.keys) {
    if (key === null) {
      return 'possible';
    }
    const resolved = unwrapUnmutatedLiteral(current, source.context);
    if (resolved === undefined) {
      return 'possible';
    }
    const stepped = stepProjectedLiteral(resolved, key, source.context);
    if (stepped.status !== undefined) {
      return stepped.status;
    }
    if (stepped.next === undefined) {
      return 'possible';
    }
    current = stepped.next;
  }
  return leafPresence({ ...source, keys: [], value: current });
}

/** Projects `{ ...target }` applied to `origin.slice(sliceStart)` across `readAt`. */
function slicedArrayObjectRestOrigins(
  origin: Origin,
  sliceStart: number | null,
  readAt: Origin,
  omittedKeys: ReadonlySet<string>,
): readonly Origin[] {
  if (readAt.keys.length > 0) {
    const [firstKey, ...rest] = readAt.keys;
    if (firstKey !== undefined && firstKey !== null && omittedKeys.has(firstKey)) {
      return [];
    }
    const stepped = stepPatternSource({ origin, sliceStart }, firstKey ?? null);
    return stepped === undefined
      ? []
      : [
          {
            ...stepped.origin,
            excluded: readAt.excluded,
            keys: [...stepped.origin.keys, ...rest],
            spread: readAt.spread,
          },
        ];
  }
  if (sliceStart === null) {
    return [{ ...origin, excluded: undefined, keys: [...origin.keys, null], spread: undefined }];
  }
  const excluded = buildSlicedExcludedIndices(sliceStart, omittedKeys, readAt.excluded);
  return [{ ...origin, excluded, keys: [...origin.keys], spread: true }];
}

/** Collects outer array indices skipped before `sliceStart` or stripped on a sliced rest object. */
function buildSlicedExcludedIndices(
  sliceStart: number,
  omittedKeys: ReadonlySet<string>,
  outerExcluded: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  const merged = new Set<string>();
  for (let index = 0; index < sliceStart; index += 1) {
    merged.add(String(index));
  }
  for (const key of omittedKeys) {
    const offset = arrayIndex(key);
    if (offset !== undefined) {
      merged.add(String(sliceStart + offset));
    }
  }
  if (outerExcluded !== undefined) {
    for (const key of outerExcluded) {
      const offset = arrayIndex(key);
      if (offset !== undefined) {
        merged.add(String(sliceStart + offset));
      }
    }
  }
  return merged.size > 0 ? merged : undefined;
}

/** Combines `source`'s accumulated member path with the outer read's `keys` and spread state. */
function projectReadOrigin(source: Origin, readAt: Origin): Origin {
  return {
    ...source,
    excluded: readAt.excluded,
    keys: [...source.keys, ...readAt.keys],
    spread: readAt.spread,
  };
}

/** Projects an array rest slice `[...target]` for whole-array or indexed reads at `readAt`. */
function restSliceOrigins(source: Origin | undefined, readAt: Origin): readonly Origin[] {
  if (source === undefined) {
    return [];
  }
  if (readAt.keys.length === 0) {
    return [{ ...source, excluded: undefined, keys: [...source.keys, null], spread: undefined }];
  }
  const [firstKey, ...rest] = readAt.keys;
  return firstKey === null || (firstKey !== undefined && arrayIndex(firstKey) !== undefined)
    ? [
        {
          ...source,
          excluded: readAt.excluded,
          keys: [...source.keys, null, ...rest],
          spread: readAt.spread,
        },
      ]
    : [];
}

/** Projects an object rest copy `{ ...target }` across `readAt`, excluding stripped keys. */
function objectRestOrigins(
  source: Origin,
  readAt: Origin,
  omittedKeys: ReadonlySet<string>,
): readonly Origin[] {
  if (readAt.keys.length === 0) {
    let excluded: ReadonlySet<string> | undefined;
    if (omittedKeys.size > 0 || readAt.excluded !== undefined) {
      const merged = new Set(readAt.excluded);
      for (const key of omittedKeys) {
        merged.add(key);
      }
      excluded = merged;
    }
    return [{ ...source, excluded, keys: [...source.keys], spread: true }];
  }
  const [firstKey] = readAt.keys;
  if (firstKey !== undefined && firstKey !== null && omittedKeys.has(firstKey)) {
    return [];
  }
  return [
    {
      ...source,
      excluded: readAt.excluded,
      keys: [...source.keys, ...readAt.keys],
      spread: readAt.spread,
    },
  ];
}

/** Unwraps `expr` to an unmutated array or object literal when statically fixed. */
function unwrapUnmutatedLiteral(expr: Expression, context: Context): Expression | undefined {
  let current = peeled(expr);
  const seen = new Set<Expression>();
  while (isIdentifier(current) && !seen.has(current)) {
    seen.add(current);
    const held = heldConstant(current, context);
    if (
      held === undefined ||
      writtenBefore(current, context) ||
      arrayChangedBefore(current, context)
    ) {
      return undefined;
    }
    current = peeled(held);
  }
  return isObjectLiteralExpression(current) || isArrayLiteralExpression(current)
    ? current
    : undefined;
}

/** Steps one static `key` into an unmutated object or array literal for definedness checks. */
function stepProjectedLiteral(literal: Expression, key: string, context: Context): ProjectedStep {
  if (isArrayLiteralExpression(literal)) {
    const index = arrayIndex(key);
    if (index === undefined || literal.elements.some((each) => isSpreadElement(each))) {
      return { status: 'possible' };
    }
    const element = literal.elements[index];
    return element === undefined || isOmittedExpression(element)
      ? { status: 'undefined' }
      : { next: element };
  }
  return isObjectLiteralExpression(literal)
    ? stepProjectedObject(literal, key, context)
    : { status: 'possible' };
}

/** Steps one static `key` into an unmutated `ObjectLiteralExpression` for definedness checks. */
function stepProjectedObject(
  object: ObjectLiteralExpression,
  key: string,
  context: Context,
): ProjectedStep {
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return { status: 'possible' };
    }
    const named = propertyKey(property.name, context);
    if (named === undefined) {
      return { status: 'possible' };
    }
    if (named !== key) {
      continue;
    }
    if (isPropertyAssignment(property)) {
      return { next: property.initializer };
    }
    if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      return { next: property.name };
    }
    return { status: isMethodDeclaration(property) ? 'defined' : 'possible' };
  }
  return key === '__proto__' || OBJECT_PROTOTYPE_KEYS.has(key)
    ? { status: 'possible' }
    : { status: 'undefined' };
}

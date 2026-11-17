import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { metadataInitializer } from './input-callees.ts';
import { readsOf } from './local-module-reads.ts';
import { arrayChangedBefore, arrayIndex, type ArrayScope } from './proxy-arrays.ts';
import {
  type Context,
  type OriginKey,
  originKey,
  peeled,
  propertyKey,
  writtenBefore,
} from './proxy-values.ts';
import { interveningEvaluation } from './written-evaluation.ts';

/** Pending expression and remaining member keys during container alias traversal. */
export interface ContainerStep {
  readonly expr: Expression;
  readonly remaining: readonly OriginKey[];
}

interface ExpandedArray {
  readonly exactPrefix: readonly Expression[];
  readonly spreadSources: readonly Expression[];
  readonly unknownTail: readonly Expression[];
}

/** Checks whether `candidate` resolves directly or through `const` containers to `scope`. */
export function resolvesToContainerAlias(
  candidate: Expression,
  scope: ArrayScope,
  context: Context,
  restContainers?: ReadonlySet<Identifier>,
): boolean {
  const { keys, root } = peelAccessChain(candidate, context);
  return expressionReachesScope(
    { expr: root, remaining: keys },
    (leaf) => matchesScopeIdentifier(leaf, scope),
    context,
    restContainers,
  );
}

/** Peels outer property and element accesses from `candidate` into `(root, keys)`. */
export function peelAccessChain(
  candidate: Expression,
  context: Context,
): { readonly keys: readonly OriginKey[]; readonly root: Expression } {
  const keys: OriginKey[] = [];
  let current = peeled(candidate);
  for (;;) {
    if (isPropertyAccessExpression(current)) {
      keys.unshift(current.name.text);
      current = peeled(current.expression);
      continue;
    }
    if (isElementAccessExpression(current)) {
      keys.unshift(originKey(current.argumentExpression, context) ?? null);
      current = peeled(current.expression);
      continue;
    }
    return { keys, root: current };
  }
}

/** Checks whether stepping `initial` along its `remaining` keys reaches `matchesLeaf`. */
export function expressionReachesScope(
  initial: ContainerStep,
  matchesLeaf: (leaf: Expression) => boolean,
  context: Context,
  restContainers?: ReadonlySet<Identifier>,
): boolean {
  const pending: ContainerStep[] = [initial];
  const visited = new Set<Expression>();
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    const expr = peeled(step.expr);
    if (step.remaining.length === 0) {
      if (matchesLeaf(expr)) {
        return true;
      }
      continue;
    }
    const [firstKey, ...rest] = step.remaining;
    if (firstKey === undefined) {
      continue;
    }
    if (matchesRestContainer(expr, firstKey, restContainers)) {
      if (rest.length === 0) {
        return true;
      }
      continue;
    }
    const resolved = unwrapConstContainer(expr, visited);
    if (resolved !== undefined) {
      pending.push(...stepContainerKey(resolved, firstKey, rest, context));
    }
  }
  return false;
}

/** Checks whether `expr` reads a rest-parameter container indexed by `firstKey`. */
function matchesRestContainer(
  expr: Expression,
  firstKey: OriginKey,
  restContainers: ReadonlySet<Identifier> | undefined,
): boolean {
  if (restContainers === undefined || restContainers.size === 0 || !isIdentifier(expr)) {
    return false;
  }
  if (firstKey !== null && arrayIndex(firstKey) === undefined) {
    return false;
  }
  return [...restContainers].some((restParam) => readsOf(restParam, restParam.parent.parent)(expr));
}

/** Checks whether `expr` is an identifier reading one of `scope.aliases`. */
function matchesScopeIdentifier(expr: Expression, scope: ArrayScope): boolean {
  return (
    isIdentifier(expr) && [...scope.aliases].some((alias) => readsOf(alias, scope.owner)(expr))
  );
}

/** Resolves `node` across local `const` identifiers without calling external `follow` hooks. */
function unwrapConstContainer(node: Expression, seen: Set<Expression>): Expression | undefined {
  let current: Expression = peeled(node);
  while (isIdentifier(current)) {
    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);
    const held = metadataInitializer(current);
    if (held === undefined) {
      return undefined;
    }
    current = peeled(held);
  }
  return current;
}

/** Advances one static or dynamic `key` step into an array or object literal container. */
function stepContainerKey(
  container: Expression,
  key: OriginKey,
  rest: readonly OriginKey[],
  context: Context,
): readonly ContainerStep[] {
  if (isArrayLiteralExpression(container)) {
    return stepArrayContainer(container, key, rest, context);
  }
  return isObjectLiteralExpression(container)
    ? stepObjectContainer(container, key, rest, context)
    : [];
}

/** Selects candidate array elements at `key`, accounting for known and unknown spreads. */
function stepArrayContainer(
  container: ArrayLiteralExpression,
  key: OriginKey,
  rest: readonly OriginKey[],
  context: Context,
): readonly ContainerStep[] {
  const expanded = expandArrayElements(container, context, new Set([container]));
  if (key === null) {
    return [
      ...nonHoleSteps(expanded.exactPrefix, rest),
      ...nonHoleSteps(expanded.unknownTail, rest),
      ...expanded.spreadSources.map((each) => ({ expr: each, remaining: [null, ...rest] })),
    ];
  }
  const index = arrayIndex(key);
  if (index === undefined) {
    return [];
  }
  if (index < expanded.exactPrefix.length) {
    const exact = expanded.exactPrefix[index];
    return exact === undefined || isOmittedExpression(exact)
      ? []
      : [{ expr: exact, remaining: rest }];
  }
  if (expanded.spreadSources.length === 0) {
    return [];
  }
  return [
    ...nonHoleSteps(expanded.unknownTail, rest),
    ...expanded.spreadSources.map((each) => ({ expr: each, remaining: [null, ...rest] })),
  ];
}

/** Converts non-omitted array elements into `ContainerStep` entries carrying `rest`. */
function nonHoleSteps(
  elements: readonly Expression[],
  rest: readonly OriginKey[],
): readonly ContainerStep[] {
  return elements.flatMap((each) =>
    isOmittedExpression(each) ? [] : [{ expr: each, remaining: rest }],
  );
}

/** Partitions `container`'s elements into an exact prefix, unknown spreads, and trailing items. */
function expandArrayElements(
  container: ArrayLiteralExpression,
  context: Context,
  seen: ReadonlySet<ArrayLiteralExpression>,
): ExpandedArray {
  const exactPrefix: Expression[] = [];
  const spreadSources: Expression[] = [];
  const unknownTail: Expression[] = [];
  for (const element of container.elements) {
    if (!isSpreadElement(element)) {
      const bucket = spreadSources.length === 0 ? exactPrefix : unknownTail;
      bucket.push(element);
      continue;
    }
    const inlined = inlineUnmutatedSpreadArray(element.expression, context, seen);
    if (inlined === undefined) {
      spreadSources.push(element.expression);
      continue;
    }
    const bucket = spreadSources.length === 0 ? exactPrefix : unknownTail;
    bucket.push(...inlined);
  }
  return { exactPrefix, spreadSources, unknownTail };
}

/** Resolves `expr` to exact elements when it is an unmutated array literal without unknown spreads. */
export function inlineUnmutatedSpreadArray(
  expr: Expression,
  context: Context,
  seen: ReadonlySet<ArrayLiteralExpression>,
): readonly Expression[] | undefined {
  let target = peeled(expr);
  if (isIdentifier(target)) {
    const held = metadataInitializer(target);
    if (
      held === undefined ||
      arrayChangedBefore(target, context) ||
      interveningEvaluation(held, target)
    ) {
      return undefined;
    }
    target = peeled(held);
  }
  if (!isArrayLiteralExpression(target) || seen.has(target)) {
    return undefined;
  }
  const nested = expandArrayElements(target, context, new Set([...seen, target]));
  return nested.spreadSources.length === 0 ? nested.exactPrefix : undefined;
}

/** Selects candidate object entries at `key`, respecting spreads and overwriting properties. */
function stepObjectContainer(
  container: ObjectLiteralExpression,
  key: OriginKey,
  rest: readonly OriginKey[],
  context: Context,
): readonly ContainerStep[] {
  return key === null
    ? stepObjectAllEntries(container, rest)
    : stepObjectNamedEntries(container, key, rest, context);
}

/** Collects all data and spread entries of `container` when `key` is dynamic (`null`). */
function stepObjectAllEntries(
  container: ObjectLiteralExpression,
  rest: readonly OriginKey[],
): readonly ContainerStep[] {
  return container.properties.toReversed().flatMap((property) => {
    if (isSpreadAssignment(property)) {
      return [{ expr: property.expression, remaining: [null, ...rest] }];
    }
    const expr = dataPropertyExpression(property);
    return expr === undefined ? [] : [{ expr, remaining: rest }];
  });
}

/** Collects candidate entries for a static `key` on `container`, stopping at definite overwrites. */
function stepObjectNamedEntries(
  container: ObjectLiteralExpression,
  key: string,
  rest: readonly OriginKey[],
  context: Context,
): readonly ContainerStep[] {
  const steps: ContainerStep[] = [];
  for (const property of container.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      steps.push({ expr: property.expression, remaining: [key, ...rest] });
      if (spreadGuaranteesKey(property.expression, key, context)) {
        break;
      }
      continue;
    }
    const named = propertyKey(property.name, context);
    if (named === undefined) {
      pushDataStep(property, rest, steps);
    } else if (named === key) {
      pushDataStep(property, rest, steps);
      break;
    }
  }
  return steps;
}

/** Appends a `{ expr, remaining }` step when `property` is a non-setter data property. */
function pushDataStep(
  property: ObjectLiteralElementLike,
  rest: readonly OriginKey[],
  out: ContainerStep[],
): void {
  const expr = dataPropertyExpression(property);
  if (expr !== undefined) {
    out.push({ expr, remaining: rest });
  }
}

/** Checks whether `expr` is an unmutated object literal with a guaranteed static own `key`. */
function spreadGuaranteesKey(expr: Expression, key: string, context: Context): boolean {
  const direct = peeled(expr);
  const literal =
    isIdentifier(direct) && !writtenBefore(direct, context) ? metadataInitializer(direct) : direct;
  const resolved = literal === undefined ? undefined : peeled(literal);
  if (resolved === undefined || !isObjectLiteralExpression(resolved)) {
    return false;
  }
  return resolved.properties.some((prop) => {
    if (isSpreadAssignment(prop) || isSetAccessorDeclaration(prop)) {
      return false;
    }
    const named = propertyKey(prop.name, context);
    return named === key && (isComputedPropertyName(prop.name) || named !== '__proto__');
  });
}

/** Extracts the value expression of a plain data property on an object literal. */
function dataPropertyExpression(property: ObjectLiteralElementLike): Expression | undefined {
  if (isPropertyAssignment(property)) {
    return property.initializer;
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? property.name
    : undefined;
}

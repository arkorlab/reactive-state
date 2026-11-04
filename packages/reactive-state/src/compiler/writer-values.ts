import {
  type ArrowFunction,
  type Expression,
  type FunctionExpression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNonNullExpression,
  isOmittedExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isVoidExpression,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import type { TopLevel } from './analyze.ts';
import { globalOf, unwrapped } from './bounded.ts';
import { arrayValues } from './writer-arrays.ts';
import {
  bindingPath,
  missingValue,
  pathKey,
  propertyKey,
  type Reading,
  selectedBy,
  type Selection,
  type Step,
  writtenKey,
} from './writer-bindings.ts';
import { prototypeValue, spreadsOwnKey } from './writer-prototypes.ts';

/**
 * What a browser value may hold that writes a state (`updaters.ts`): names and functions, through
 * constants and either answer of a condition, or entries of objects and arrays. Each value and
 * path is followed once, so aliases that reach each other finish without caching a partial answer.
 */

type Writer = ArrowFunction | FunctionExpression | Identifier;
interface Pending extends Reading {
  readonly trail: ReadonlySet<Expression>;
}

interface Followed {
  readonly values: readonly Reading[];
  readonly writers: readonly Writer[];
}

/** The operators that answer one of their operands. */
const EITHER: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** The members through which a function is called as itself. */
const CALLING: ReadonlySet<string> = new Set(['apply', 'call']);

const OBJECT_REST = 'object-rest';

/** The value read from `reference`, including the members read of it, but a function's `call` or `apply`. */
export function writerValue(
  reference: Identifier,
  names: ReadonlyMap<string, TopLevel>,
): Expression {
  let value: Expression = reference;
  for (;;) {
    const { parent } = value;
    const container = containerOf(value);
    if (container !== undefined) {
      value = container;
      continue;
    }
    if (
      (isParenthesizedExpression(parent) ||
        isAsExpression(parent) ||
        isNonNullExpression(parent) ||
        isSatisfiesExpression(parent)) &&
      parent.expression === value
    ) {
      value = parent;
      continue;
    }
    // An unknown key can select call/apply too; keep the callable receiver in that case.
    if (
      (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
      parent.expression === value &&
      (!CALLING.has(keyOf(parent, names) ?? 'call') || heldWriters(value, names).length === 0)
    ) {
      if (
        keyOf(parent, names) === 'bind' &&
        isCallExpression(parent.parent) &&
        parent.parent.expression === parent &&
        heldWriters(value, names).length > 0
      ) {
        value = parent.parent;
        continue;
      }
      value = parent;
      continue;
    }
    const unwrappedValue = unwrapped(value);
    return isObjectLiteralExpression(unwrappedValue) || isArrayLiteralExpression(unwrappedValue)
      ? reference
      : value;
  }
}

/** The names and functions `value` may hold, following aliases and the members the code reads. */
export function heldWriters(
  value: Expression,
  names: ReadonlyMap<string, TopLevel>,
): readonly Writer[] {
  const found: Writer[] = [];
  const seen = new Map<Expression, Set<string>>();
  const pending: Pending[] = [{ keys: [], trail: new Set(), value }];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const current = { ...at, value: unwrapped(at.value) };
    const paths = seen.get(current.value) ?? new Set<string>();
    const path = pathKey(current.keys);
    if (paths.has(path) || current.trail.has(current.value)) {
      continue;
    }
    paths.add(path);
    seen.set(current.value, paths);
    const held = heldAt(current, names);
    found.push(...held.writers);
    const trail = new Set([...current.trail, current.value]);
    pending.push(...held.values.map((each) => ({ ...each, trail })));
  }
  return found;
}

/** What `at` holds next: a constant's initializer, a condition's answers, or a container's entries. */
function heldAt(at: Reading, names: ReadonlyMap<string, TopLevel>): Followed {
  const forwarded = forwardedValue(at, names);
  if (forwarded !== undefined) {
    return { values: forwarded, writers: [] };
  }
  const { value } = at;
  const { keys, fallback, missing } = defaultPrefix(at, names);
  if (missing) {
    return { values: fallback, writers: [] };
  }
  const selected = selectedValue(value, keys, names);
  if (selected !== undefined) {
    return { values: [...fallback, ...selected], writers: [] };
  }
  const defaults = keys.flatMap((step, index) => {
    return typeof step === 'object' && step.kind === 'default'
      ? [{ keys: keys.slice(index + 1), value: step.value }]
      : [];
  });
  return {
    values: [...fallback, ...defaults],
    writers: keys.length === 0 && isWriter(value) ? [value] : [],
  };
}

/** The defaults reached before selecting another member, retaining the original value where it is defined. */
function defaultPrefix(
  { value, keys: initial }: Reading,
  names: ReadonlyMap<string, TopLevel>,
): {
  readonly keys: readonly Step[];
  readonly fallback: readonly Reading[];
  readonly missing: boolean;
} {
  const fallback: Reading[] = [];
  let keys = initial;
  for (;;) {
    const [first, ...rest] = keys;
    if (typeof first !== 'object' || first.kind !== 'default') {
      return { fallback, keys, missing: false };
    }
    const defined = definedValue(value, names);
    if (defined !== true) {
      fallback.push({ keys: rest, value: first.value });
    }
    if (defined === false) {
      return { fallback, keys: rest, missing: true };
    }
    keys = rest;
  }
}

/** A value followed before applying a binding's projections or defaults. */
function forwardedValue(
  { value, keys }: Reading,
  names: ReadonlyMap<string, TopLevel>,
): readonly Reading[] | undefined {
  if (isIdentifier(value)) {
    return constantHeld(value, keys, names);
  }
  if (isCallExpression(value)) {
    const callee = unwrapped(value.expression);
    if (
      (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
      keyOf(callee, names) === 'bind'
    ) {
      return [{ keys, value: callee.expression }];
    }
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    return [{ keys: [keyOf(value, names), ...keys], value: value.expression }];
  }
  if (isConditionalExpression(value)) {
    return [value.whenTrue, value.whenFalse].map((each) => ({ keys, value: each }));
  }
  if (isBinaryExpression(value)) {
    return binaryHeld(value, keys);
  }
  return undefined;
}

/** A member selected from a literal holder, including rest exclusions and shifted array indices. */
function selectedValue(
  value: Expression,
  keys: readonly Step[],
  names: ReadonlyMap<string, TopLevel>,
): readonly Reading[] | undefined {
  if (keys.length === 0 && (isObjectLiteralExpression(value) || isArrayLiteralExpression(value))) {
    return [];
  }
  const selection = selectedBy(keys);
  if (selection === undefined) {
    return keys.length === 0 ? undefined : [];
  }
  if (selection.missing) {
    return inheritedMember(value, selection, names) ? [] : missingValue(selection.rest);
  }
  if (isObjectLiteralExpression(value)) {
    return objectValues(value, selection, names);
  }
  if (!isArrayLiteralExpression(value)) {
    return undefined;
  }
  return inheritedMember(value, selection, names)
    ? []
    : arrayValues(value.elements, selection, names);
}

/** What an alias holds, with every key of a nested destructuring binding before any members read of it. */
function constantHeld(
  value: Identifier,
  keys: readonly Step[],
  names: ReadonlyMap<string, TopLevel>,
): readonly Reading[] | undefined {
  const entry = names.get(value.text);
  const declaration = entry?.kind === 'constant' ? entry.declaration : undefined;
  if (declaration?.initializer === undefined) {
    return undefined;
  }
  const taken = bindingPath(declaration.name, value.text, names);
  return [
    {
      keys: [...(taken ?? []), ...keys],
      value: declaration.initializer,
    },
  ];
}

/** The values a binary expression may answer as they are. */
function binaryHeld(value: Expression, keys: readonly Step[]): readonly Reading[] {
  if (!isBinaryExpression(value)) {
    return [];
  }
  if (value.operatorToken.kind === SyntaxKind.CommaToken) {
    return [{ keys, value: value.right }];
  }
  return EITHER.has(value.operatorToken.kind)
    ? [value.left, value.right].map((each) => ({ keys, value: each }))
    : [];
}

/** What an object's selected entry holds, or all its entries where none is selected. */
function objectValues(
  value: ObjectLiteralExpression,
  selection: Selection,
  names: ReadonlyMap<string, TopLevel>,
): readonly Reading[] {
  const { key, rest } = selection;
  const found: Reading[] = [];
  let prototype: Expression | undefined;
  for (const property of value.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      found.push(spreadReading(property.expression, selection));
      if (spreadsOwnKey(property.expression, key, names)) {
        return found;
      }
      continue;
    }
    const inherited = prototypeValue(property, names);
    if (inherited !== undefined) {
      prototype = inherited;
      continue;
    }
    const named = propertyKey(property.name, names);
    if (unselectedProperty(named, selection)) {
      continue;
    }
    const held = propertyValue(property);
    if (held !== undefined) {
      found.push({ keys: rest, value: held });
    }
    if (key !== undefined && named === key) {
      return found;
    }
  }
  return inheritedValues({ found, prototype, selection, value }, names);
}

/** A spread's selected own entry, retaining exclusions from rest bindings. */
function spreadReading(value: Expression, { key, rest, excluded, shape }: Selection): Reading {
  const projection: readonly Step[] =
    shape !== OBJECT_REST && excluded.size === 0
      ? []
      : [{ excluded: [...excluded], kind: OBJECT_REST }];
  return { keys: [...projection, key, ...rest], value };
}

/** The prototype's member or a missing-entry default, after all possible own entries. */
function inheritedValues(
  {
    found,
    prototype,
    selection,
    value,
  }: {
    readonly found: readonly Reading[];
    readonly prototype: Expression | undefined;
    readonly selection: Selection;
    readonly value: ObjectLiteralExpression;
  },
  names: ReadonlyMap<string, TopLevel>,
): readonly Reading[] {
  const { key, rest, shape } = selection;
  if (prototype !== undefined && shape !== OBJECT_REST) {
    return [...found, { keys: [key, ...rest], value: prototype }];
  }
  return inheritedMember(value, selection, names) ? found : [...found, ...missingValue(rest)];
}

/** Whether a known own property is removed or another property is selected. */
function unselectedProperty(named: string | undefined, { key, excluded }: Selection): boolean {
  return named !== undefined && (excluded.has(named) || (key !== undefined && key !== named));
}

/** Whether a missing own entry still holds a defined member of the resulting container's prototype. */
function inheritedMember(
  value: Expression,
  { key, shape }: Selection,
  names: ReadonlyMap<string, TopLevel>,
): boolean {
  if (key === undefined) {
    return false;
  }
  if (shape === OBJECT_REST) {
    return Object.hasOwn(Object.prototype, key);
  }
  if (shape === 'array-rest' || isArrayLiteralExpression(value)) {
    return (
      key === 'length' ||
      Object.hasOwn(Array.prototype, key) ||
      Object.hasOwn(Object.prototype, key)
    );
  }
  if (!isObjectLiteralExpression(value)) {
    return false;
  }
  const prototype = value.properties.some((property) => {
    return (
      isPropertyAssignment(property) &&
      !isComputedPropertyName(property.name) &&
      propertyKey(property.name, names) === '__proto__'
    );
  });
  return !prototype && Object.hasOwn(Object.prototype, key);
}

/** The value a property writes, rather than a method or an accessor. */
function propertyValue(
  property: ObjectLiteralExpression['properties'][number],
): Expression | undefined {
  if (isPropertyAssignment(property)) {
    return property.initializer;
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? property.name
    : undefined;
}

/** Whether a value is a function written there or a name of one. */
function isWriter(value: Expression): value is Writer {
  return isIdentifier(value) || isArrowFunction(value) || isFunctionExpression(value);
}

/** The key of a member read, by its name or constant text or numbers in brackets. */
function keyOf(value: Expression, names: ReadonlyMap<string, TopLevel>): string | undefined {
  if (isPropertyAccessExpression(value)) {
    return value.name.text;
  }
  return isElementAccessExpression(value) ? writtenKey(value.argumentExpression, names) : undefined;
}

/** Whether a value is definitely defined, definitely undefined, or unknown before a binding's default. */
function definedValue(
  value: Expression,
  names: ReadonlyMap<string, TopLevel>,
): boolean | undefined {
  if (
    isOmittedExpression(value) ||
    isVoidExpression(value) ||
    (isIdentifier(value) && globalOf(value) === 'undefined')
  ) {
    return false;
  }
  if (isIdentifier(value)) {
    return names.get(value.text)?.kind === 'setter' ? true : undefined;
  }
  if (
    isCallExpression(value) ||
    isPropertyAccessExpression(value) ||
    isElementAccessExpression(value)
  ) {
    return undefined;
  }
  return true;
}

/** The object or array that holds `value` as an entry, where it is written inline. */
function containerOf(value: Expression): Expression | undefined {
  const { parent } = value;
  if (isArrayLiteralExpression(parent)) {
    return parent;
  }
  const stored =
    (isPropertyAssignment(parent) && parent.initializer === value) ||
    (isShorthandPropertyAssignment(parent) && isIdentifier(parent.name) && parent.name === value) ||
    (isSpreadAssignment(parent) && parent.expression === value);
  return stored && isObjectLiteralExpression(parent.parent) ? parent.parent : undefined;
}

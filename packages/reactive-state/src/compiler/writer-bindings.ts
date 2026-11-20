import {
  type BindingElement,
  type BindingName,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isBinaryExpression,
  isBindingElement,
  isComputedPropertyName,
  isIdentifier,
  isNumericLiteral,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import type { TopLevel } from './analyze.ts';
import { unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import type { Constant } from './numbers.ts';

/** The selections a destructured writer alias makes, including rest projections and defaults. */

export type Key = string | undefined;
export type Step =
  | Key
  | { readonly kind: 'array-rest'; readonly from: number }
  | { readonly kind: 'object-rest'; readonly excluded: readonly Key[] }
  | { readonly kind: 'default'; readonly value: Expression };

type Projection = Extract<Step, { readonly kind: 'array-rest' | 'object-rest' }>;

export interface Reading {
  readonly value: Expression;
  readonly keys: readonly Step[];
}

interface Bound {
  readonly binding: BindingName;
  readonly keys: readonly Step[];
}

interface Projected {
  readonly key: Key;
  readonly from: number;
  readonly excluded: ReadonlySet<string>;
  readonly missing: boolean;
}

export interface Selection {
  readonly key: Key;
  readonly rest: readonly Step[];
  readonly excluded: ReadonlySet<string>;
  readonly from: number;
  readonly missing: boolean;
  readonly shape: 'array-rest' | 'object-rest' | undefined;
}

/** Every selection that takes `name` from `binding`, including nested patterns. */
export function bindingPath(
  binding: BindingName,
  name: string,
  names: ReadonlyMap<string, TopLevel>,
): readonly Step[] | undefined {
  const pending: Bound[] = [{ binding, keys: [] }];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (isIdentifier(current.binding)) {
      if (current.binding.text === name) {
        return current.keys;
      }
      continue;
    }
    pending.push(...nestedBindings(current, names));
  }
  return undefined;
}

/** Each nested binding, with its rest projection or selected key and optional default. */
function nestedBindings(
  { binding: pattern, keys }: Bound,
  names: ReadonlyMap<string, TopLevel>,
): readonly Bound[] {
  if (isIdentifier(pattern)) {
    return [];
  }
  const found: Bound[] = [];
  for (const [index, element] of pattern.elements.entries()) {
    if (isBindingElement(element) && element.name !== undefined) {
      const steps = bindingSteps(element, { index, names, pattern });
      const fallback: readonly Step[] =
        element.initializer === undefined ? [] : [{ kind: 'default', value: element.initializer }];
      found.push({ binding: element.name, keys: [...keys, ...steps, ...fallback] });
    }
  }
  return found;
}

/** The property, index or rest projection of an element of a pattern. */
function bindingSteps(
  element: BindingElement,
  {
    index,
    names,
    pattern,
  }: {
    readonly index: number;
    readonly names: ReadonlyMap<string, TopLevel>;
    readonly pattern: Exclude<BindingName, Identifier>;
  },
): readonly Step[] {
  const array = isArrayBindingPattern(pattern);
  if (element.dotDotDotToken !== undefined) {
    return [
      array
        ? { from: index, kind: 'array-rest' }
        : {
            excluded: pattern.elements.flatMap((each) => {
              return isBindingElement(each) && each.dotDotDotToken === undefined
                ? [bindingKey(each, names)]
                : [];
            }),
            kind: 'object-rest',
          },
    ];
  }
  return [array ? String(index) : bindingKey(element, names)];
}

/** The property name a non-rest element takes, including a computed constant key. */
function bindingKey(element: BindingElement, names: ReadonlyMap<string, TopLevel>): Key {
  if (element.propertyName !== undefined) {
    return propertyKey(element.propertyName, names);
  }
  return element.name !== undefined && isIdentifier(element.name) ? element.name.text : undefined;
}

/** A property's key, where the code names it or computes it of a constant. */
export function propertyKey(name: PropertyName, names: ReadonlyMap<string, TopLevel>): Key {
  if (isIdentifier(name)) {
    return name.text;
  }
  return isComputedPropertyName(name) ? writtenKey(name.expression, names) : literalKey(name);
}

/** A member key written as constant text or numbers, including concatenated invocation names. */
export function writtenKey(node: Expression, names: ReadonlyMap<string, TopLevel>): Key {
  const value = keyOperand(node, { following: new Set(), names });
  return value === undefined ? undefined : String(value);
}

/** The literal text or number a key adds, without evaluating calls or following a cycle. */
function keyOperand(
  node: Expression,
  context: {
    readonly names: ReadonlyMap<string, TopLevel>;
    readonly following: ReadonlySet<Expression>;
  },
): Constant | undefined {
  const value = keyValue(node, context.names);
  if (context.following.has(value)) {
    return undefined;
  }
  const literal = literalKey(value);
  if (literal !== undefined) {
    return isNumericLiteral(value) ? Number(value.text) : literal;
  }
  if (!isBinaryExpression(value) || value.operatorToken.kind !== SyntaxKind.PlusToken) {
    return undefined;
  }
  const following = new Set([...context.following, value]);
  const left = keyOperand(value.left, { ...context, following });
  const right = keyOperand(value.right, { ...context, following });
  if (left === undefined || right === undefined) {
    return undefined;
  }
  return typeof left === 'string' || typeof right === 'string'
    ? String(left) + String(right)
    : left + right;
}

/** A computed key followed through constants whose own binding is an identifier. */
export function keyValue(node: Expression, names: ReadonlyMap<string, TopLevel>): Expression {
  let value = unwrapped(node);
  const seen = new Set<string>();
  while (isIdentifier(value) && !seen.has(value.text)) {
    seen.add(value.text);
    const entry = names.get(value.text);
    if (
      entry?.kind !== 'constant' ||
      !isIdentifier(entry.declaration.name) ||
      entry.declaration.initializer === undefined
    ) {
      break;
    }
    value = unwrapped(entry.declaration.initializer);
  }
  return value;
}

/** The first member selected after rest projections, expressed in the original holder's coordinates. */
export function selectedBy(keys: readonly Step[]): Selection | undefined {
  const projections: Projection[] = [];
  let index = 0;
  for (const step of keys) {
    if (typeof step !== 'object' || step.kind === 'default') {
      break;
    }
    projections.push(step);
    index += 1;
  }
  if (index >= keys.length || typeof keys[index] === 'object') {
    return undefined;
  }
  let selected: Projected = {
    excluded: new Set(),
    from: 0,
    key: keys[index] as Key,
    missing: false,
  };
  for (const projection of projections.toReversed()) {
    selected = projectedBy(selected, projection);
  }
  return {
    ...selected,
    rest: keys.slice(index + 1),
    shape: projections.at(-1)?.kind,
  };
}

/** A member selection moved through one rest projection toward the original holder. */
function projectedBy(selected: Projected, projection: Projection): Projected {
  const { key } = selected;
  if (projection.kind === 'object-rest') {
    const excluded = new Set(selected.excluded);
    for (const each of projection.excluded) {
      if (each !== undefined) {
        excluded.add(each);
      }
    }
    return {
      ...selected,
      excluded,
      missing: selected.missing || (key !== undefined && excluded.has(key)),
    };
  }
  const excluded = new Set(
    [...selected.excluded].flatMap((each) =>
      isArrayIndex(each) ? [String(Number(each) + projection.from)] : [],
    ),
  );
  const indexed = key === undefined || isArrayIndex(key);
  return {
    excluded,
    from: selected.from + projection.from,
    key: key !== undefined && indexed ? String(Number(key) + projection.from) : key,
    missing: selected.missing || !indexed,
  };
}

/** Whether a key selects one of an array's elements. */
export function isArrayIndex(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/u.test(key);
}

/** A path's identity without serializing syntax nodes, whose parents point back to them. */
export function pathKey(keys: readonly Step[]): string {
  return JSON.stringify(
    keys.map((step) => {
      return typeof step === 'object' && step.kind === 'default'
        ? ['default', step.value.pos, step.value.end]
        : step;
    }),
  );
}

/** The fallback of a missing entry, where a binding supplies one immediately. */
export function missingValue(keys: readonly Step[]): readonly Reading[] {
  const [first, ...rest] = keys;
  return typeof first === 'object' && first.kind === 'default'
    ? [{ keys: rest, value: first.value }]
    : [];
}

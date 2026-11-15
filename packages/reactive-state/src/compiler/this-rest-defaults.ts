import {
  type BindingElement,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBindingElement,
  isIdentifier,
  isObjectLiteralExpression,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';

import { patternKey } from './code-globals.ts';

/** Mutable walk state while stepping through destructuring bindings and chosen defaults. */
export interface DefaultWalk {
  chosen: boolean;
  excluded: ReadonlySet<string> | undefined;
  offset: number;
  value: Expression | undefined;
}

/** Binding projections in their evaluation order, including defaults at outer pattern levels. */
export function bindingSteps(name: Identifier): readonly BindingElement[] {
  const steps: BindingElement[] = [];
  for (let at: Node = name; !isVariableDeclaration(at); at = at.parent) {
    if (isBindingElement(at)) {
      steps.unshift(at);
    }
  }
  return steps;
}

/** Static member keys projected by a non-rest destructuring binding; `[undefined]` when defaulted. */
export function projectedKeys(name: Identifier): readonly (string | undefined)[] {
  const keys: (string | undefined)[] = [];
  for (const step of bindingSteps(name)) {
    if (step.initializer !== undefined || step.dotDotDotToken !== undefined) {
      return [undefined];
    }
    keys.push(patternName(step));
  }
  return keys;
}

/** Adjusts `path` in place when stepping backward through an unchosen rest container binding. */
export function adjustRestPath(name: Identifier, path: (string | undefined)[]): void {
  const step = name.parent;
  if (!isBindingElement(step)) {
    return;
  }
  if (isArrayBindingPattern(step.parent)) {
    const restIndex = step.parent.elements.indexOf(step);
    const first = path[0];
    if (first === undefined) {
      path.unshift(undefined);
    } else if (restIndex > 0) {
      path[0] = isNonNegativeIndex(first) ? String(Number(first) + restIndex) : undefined;
    }
    return;
  }
  const excluded = excludedObjectKeys(step);
  const first = path[0];
  if (first === undefined || excluded === undefined || excluded.has(first)) {
    path.unshift(undefined);
  }
}

/** Records array-slice offsets or excluded object keys when `step` is a `...rest` binding element. */
export function advanceRestStep(
  step: BindingElement,
  current: Expression,
  walk: DefaultWalk,
): boolean {
  if (isArrayBindingPattern(step.parent)) {
    if (
      !isArrayLiteralExpression(current) ||
      current.elements.some((each) => isSpreadElement(each))
    ) {
      return false;
    }
    walk.offset += step.parent.elements.indexOf(step);
    walk.value = current;
    return true;
  }
  if (!isIdentifier(step.name) || !isObjectLiteralExpression(current)) {
    return false;
  }
  const excluded = excludedObjectKeys(step);
  if (excluded === undefined) {
    return false;
  }
  walk.excluded = excluded;
  walk.value = current;
  return true;
}

/** Shifts an array pattern step's index by any enclosing array-rest offset. */
export function shiftedStepKey(step: BindingElement, offset: number): string | undefined {
  const key = patternName(step);
  if (key === undefined || offset === 0) {
    return key;
  }
  return isNonNegativeIndex(key) ? String(Number(key) + offset) : undefined;
}

/** Validates and shifts `path` when `name` itself binds a rest container inside a chosen default. */
export function finalizeRestPath(
  name: Identifier,
  walk: DefaultWalk,
  path: readonly (string | undefined)[],
): readonly (string | undefined)[] | undefined {
  const rest = isBindingElement(name.parent) && name.parent.dotDotDotToken !== undefined;
  if (!rest) {
    return path;
  }
  const first = path[0];
  if (first === undefined) {
    return undefined;
  }
  if (walk.excluded !== undefined) {
    return walk.excluded.has(first) ? undefined : path;
  }
  if (walk.offset === 0) {
    return path;
  }
  return isNonNegativeIndex(first)
    ? [String(Number(first) + walk.offset), ...path.slice(1)]
    : undefined;
}

/** Whether `key` is a canonical non-negative safe integer index string. */
export function isNonNegativeIndex(key: string): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key;
}

/** An object binding's written key or an array binding's position. */
function patternName(step: BindingElement): string | undefined {
  return isArrayBindingPattern(step.parent)
    ? String(step.parent.elements.indexOf(step))
    : patternKey(step);
}

/** Static sibling property keys excluded before `rest` in an object binding pattern. */
function excludedObjectKeys(rest: BindingElement): ReadonlySet<string> | undefined {
  if (isArrayBindingPattern(rest.parent)) {
    return undefined;
  }
  const excluded = new Set<string>();
  for (const element of rest.parent.elements) {
    if (element === rest) {
      break;
    }
    const key = patternKey(element);
    if (key === undefined) {
      return undefined;
    }
    excluded.add(key);
  }
  return excluded;
}

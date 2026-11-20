import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

/** The arguments consumed by the native locking operations; later evaluations may change them. */
const ARITY = { descriptor: 3, pair: 2, single: 1 } as const;
const LOCK_ARITIES: ReadonlyMap<string, number> = new Map([
  ['Object.create', ARITY.pair],
  ['Object.defineProperties', ARITY.pair],
  ['Object.defineProperty', ARITY.descriptor],
  ['Object.freeze', ARITY.single],
  ['Object.seal', ARITY.single],
]);

/** Whether strict deletion targets an own property the code shows cannot be configured. */
export function deletesLocked(node: Node, resolve: Resolve | undefined): boolean {
  if (!isDeleteExpression(node)) {
    return false;
  }
  const member = unwrapped(node.expression);
  if (!(isPropertyAccessExpression(member) || isElementAccessExpression(member))) {
    return false;
  }
  const key = isPropertyAccessExpression(member)
    ? member.name.text
    : keyOf(member.argumentExpression, resolve);
  return key !== undefined && lockedAt(member.expression, key, resolve);
}

/** Whether a literal key is known, following constants used for computed names too. */
function keyOf(node: Expression, resolve: Resolve | undefined): string | undefined {
  const value = constantValue(node, resolve);
  return value === undefined ? undefined : String(value);
}

/** Whether a target has the own property being deleted, before any locking operation. */
function ownAt(node: Expression, key: string, resolve: Resolve | undefined): boolean | undefined {
  const value = writtenOf(node, resolve);
  const text = constantValue(value, resolve);
  if (typeof text === 'string') {
    return key === 'length' || indexOf(key, text.length) !== undefined;
  }
  if (isArrayLiteralExpression(value)) {
    return arrayOwn(value, key);
  }
  return isObjectLiteralExpression(value) ? objectOwn(value, key, resolve) : undefined;
}

/** Whether an array literal writes an own element, with holes and spreads preserved. */
function arrayOwn(value: ArrayLiteralExpression, key: string): boolean | undefined {
  if (key === 'length') {
    return true;
  }
  if (value.elements.some((each) => isSpreadElement(each))) {
    return undefined;
  }
  const index = indexOf(key, value.elements.length);
  const element = index === undefined ? undefined : value.elements[index];
  return element !== undefined && !isOmittedExpression(element);
}

/** A property name read as text, excluding a literal's prototype-setting entry. */
function propertyKey(
  property: ObjectLiteralElementLike,
  resolve: Resolve | undefined,
): string | undefined {
  if (isSpreadAssignment(property)) {
    return undefined;
  }
  const name = property.name;
  if (isComputedPropertyName(name)) {
    return keyOf(name.expression, resolve);
  }
  const key = literalKey(name) ?? (isIdentifier(name) ? name.text : undefined);
  return key === '__proto__' && isPropertyAssignment(property) ? undefined : key;
}

/** Whether an object literal necessarily writes an own property. */
function objectOwn(
  value: ObjectLiteralExpression,
  key: string,
  resolve: Resolve | undefined,
): boolean | undefined {
  let untold = false;
  for (const property of value.properties) {
    const named = propertyKey(property, resolve);
    if (named === undefined) {
      untold = true;
    } else if (named === key) {
      return true;
    }
  }
  return untold ? undefined : false;
}

/** An array or text's own index, without alternate numeric spellings or an out-of-bounds index. */
function indexOf(key: string, length: number): number | undefined {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
    ? index
    : undefined;
}

/** A data property of a dictionary written whole; accessors and unknown overrides remain untold. */
function dataAt(
  node: Expression,
  key: string,
  resolve: Resolve | undefined,
): Expression | undefined {
  const value = writtenOf(node, resolve);
  if (!isObjectLiteralExpression(value)) {
    return undefined;
  }
  let found: Expression | undefined;
  for (const property of value.properties) {
    const named = propertyKey(property, resolve);
    if (named === undefined) {
      return undefined;
    }
    if (dataValue(property) === undefined) {
      return undefined;
    }
    if (named === key) {
      found = dataValue(property);
    }
  }
  return found;
}

/** The written value of a data property; accessors remain untold. */
function dataValue(property: ObjectLiteralElementLike): Expression | undefined {
  if (isPropertyAssignment(property)) {
    return property.initializer;
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? property.name
    : undefined;
}

/** Whether a descriptor necessarily makes a property non-configurable. */
function locksDescriptor(node: Expression, fresh: boolean, resolve: Resolve | undefined): boolean {
  const descriptor = writtenOf(node, resolve);
  if (!plainDescriptor(descriptor, resolve)) {
    return false;
  }
  const configurable = dataAt(descriptor, 'configurable', resolve);
  if (configurable === undefined) {
    return fresh && ownAt(descriptor, 'configurable', resolve) === false;
  }
  const value = writtenOf(configurable, resolve);
  return (
    value.kind === SyntaxKind.FalseKeyword ||
    primitiveOf(value, resolve) === 'nothing' ||
    constantValue(value, resolve) === 0 ||
    constantValue(value, resolve) === ''
  );
}

/** Whether descriptor conversion reads only own data properties written with known names. */
function plainDescriptor(node: Expression, resolve: Resolve | undefined): boolean {
  const descriptor = writtenOf(node, resolve);
  return (
    isObjectLiteralExpression(descriptor) &&
    descriptor.properties.every(
      (each) => propertyKey(each, resolve) !== undefined && dataValue(each) !== undefined,
    )
  );
}

/** Whether a chain of known locking and defining operations leaves this own property locked. */
function lockedAt(node: Expression, key: string, resolve: Resolve | undefined): boolean {
  let current = node;
  let locked = false;
  const seen = new Set<Expression>();
  for (;;) {
    const value = writtenOf(current, resolve);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (locked && ownAt(value, key, resolve) === true) {
      return true;
    }
    const primitive = constantValue(value, resolve);
    if (typeof primitive === 'string' || isArrayLiteralExpression(value)) {
      return (
        ownAt(value, key, resolve) === true && (typeof primitive === 'string' || key === 'length')
      );
    }
    if (!isCallExpression(value) || value.arguments.some((each) => isSpreadElement(each))) {
      return false;
    }
    const step = lockStep(value, key, locked, resolve);
    if (step.target === undefined) {
      return step.locked;
    }
    current = step.target;
    locked = step.locked;
  }
}

/** The target followed through another locking operation, or its final answer. */
interface Step {
  readonly target?: Expression;
  readonly locked: boolean;
}

/** What a descriptor dictionary preserves, and whether it creates a new object. */
interface Defining {
  readonly named: Expression | undefined;
  readonly locked: boolean;
  readonly fresh: boolean;
}

/** What one locking or defining operation tells of the property, before its target is followed. */
function lockStep(
  value: CallExpression,
  key: string,
  locked: boolean,
  resolve: Resolve | undefined,
): Step {
  const path = globalPath(writtenOf(value.expression, resolve))?.join('.') ?? '';
  const [target, named, third] = value.arguments;
  const arity = LOCK_ARITIES.get(path);
  if (target === undefined || arity === undefined || value.arguments.length > arity) {
    return { locked: false };
  }
  switch (path) {
    case 'Object.freeze':
    case 'Object.seal': {
      return { locked: true, target };
    }
    case 'Object.defineProperty': {
      const own = ownAt(target, key, resolve);
      if (
        own !== undefined &&
        named !== undefined &&
        third !== undefined &&
        keyOf(named, resolve) === key
      ) {
        return {
          locked:
            (locked && plainDescriptor(third, resolve)) || locksDescriptor(third, !own, resolve),
        };
      }
      return { locked: false };
    }
    case 'Object.defineProperties': {
      return definedLock(target, { fresh: false, locked, named }, key, resolve);
    }
    case 'Object.create': {
      return definedLock(target, { fresh: true, locked, named }, key, resolve);
    }
    default: {
      return { locked: false };
    }
  }
}

/** What a dictionary of property descriptors locks, keeping existing flags on updated properties. */
function definedLock(
  target: Expression,
  { fresh, locked, named }: Defining,
  key: string,
  resolve: Resolve | undefined,
): Step {
  const descriptor = named === undefined ? undefined : dataAt(named, key, resolve);
  const own = ownAt(target, key, resolve);
  if (descriptor !== undefined && (fresh || own !== undefined)) {
    return {
      locked:
        (locked && plainDescriptor(descriptor, resolve)) ||
        locksDescriptor(descriptor, fresh || own === false, resolve),
    };
  }
  return { locked: false };
}

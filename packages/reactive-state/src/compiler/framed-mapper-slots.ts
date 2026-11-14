import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isClassExpression,
  isConditionalExpression,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTemplateExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/**
 * What a mapper's source slot, or a member of it, holds: a written expression (a literal keeps its
 * members), a value known to be present, none (`absent`), or one the source does not show.
 */
export type MapperSlot = Expression | 'absent' | 'defined' | 'unknown';

const UNDEFINED = new Set(['undefined']);
/** Members every ordinary object inherits, which a missing own field does not leave undefined. */
const INHERITED = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);
const INDEX = /^(?:0|[1-9]\d*)$/u;

/** The values a written slot may take, through whole const aliases and both conditional arms. */
export function mapperSlotValues(expression: Expression): MapperSlot[] {
  const found: MapperSlot[] = [];
  const pending = [expression];
  const seen = new Set<Node>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next);
    const followed = seen.has(value) ? undefined : followedValues(value);
    seen.add(value);
    if (followed === undefined) found.push(...slotsOf(value));
    else pending.push(...followed);
  }
  return found;
}

/** The values a slot's member may take; reading a member of no value throws instead. */
export function mapperMemberSlots(state: MapperSlot, key: string): MapperSlot[] {
  if (state === 'absent') return [];
  if (typeof state === 'string') return ['unknown'];
  if (isObjectLiteralExpression(state)) return objectMember(state, key);
  return isArrayLiteralExpression(state) ? arrayMember(state, key) : ['unknown'];
}

/** Whether a slot may hold undefined: none, or a value the source does not show to be present. */
export function mapperSlotAbsent(state: MapperSlot): boolean {
  if (state === 'absent' || state === 'unknown') return true;
  if (state === 'defined') return false;
  return !isObjectLiteralExpression(state) && !isArrayLiteralExpression(state) && !present(state);
}

/** Conditional arms and whole const aliases stand for the values they may give. */
function followedValues(value: Expression): readonly Expression[] | undefined {
  if (isConditionalExpression(value)) return [value.whenTrue, value.whenFalse];
  const initializer = isIdentifier(value) ? constantInitializer(value) : undefined;
  return initializer === undefined ? undefined : [initializer];
}

/** The native undefined is no value; any other written expression stands for itself. */
function slotsOf(value: Expression): readonly MapperSlot[] {
  return [framedNativeConstructor(value, UNDEFINED) || isVoidExpression(value) ? 'absent' : value];
}

/** Primitive literals and fresh creations are values, never undefined. */
function present(value: Expression): boolean {
  return (
    framedMapKey(value) !== undefined ||
    isNewExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value) ||
    isRegularExpressionLiteral(value) ||
    isTemplateExpression(value)
  );
}

/** The last written own field of the key, or an inherited member, or none. */
function objectMember(literal: ObjectLiteralExpression, key: string): MapperSlot[] {
  let found: MapperSlot[] | undefined;
  for (const property of literal.properties) {
    if (isSpreadAssignment(property)) return ['unknown'];
    const name = writtenArrayKey(property.name);
    // A written `__proto__` field installs a prototype whose members the source does not show.
    if (name === undefined || (name === '__proto__' && isPropertyAssignment(property)))
      return ['unknown'];
    if (name === key) found = ownField(property);
  }
  if (found !== undefined) return found;
  return [INHERITED.has(key) ? 'defined' : 'absent'];
}

/** A data field's written value, a method, or an accessor whose result the source does not show. */
function ownField(property: ObjectLiteralExpression['properties'][number]): MapperSlot[] {
  if (isPropertyAssignment(property)) return mapperSlotValues(property.initializer);
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    return mapperSlotValues(property.name);
  return [isMethodDeclaration(property) ? 'defined' : 'unknown'];
}

/** A written element, a hole or a position past the end; a spread hides later positions. */
function arrayMember(literal: ArrayLiteralExpression, key: string): MapperSlot[] {
  if (key === 'length') return ['defined'];
  if (!INDEX.test(key)) return ['unknown'];
  const position = Number(key);
  for (const [at, element] of literal.elements.entries()) {
    if (isSpreadElement(element)) return ['unknown'];
    if (at === position)
      return isOmittedExpression(element) ? ['absent'] : mapperSlotValues(element);
  }
  return ['absent'];
}

/** A whole const binding's initializer. */
function constantInitializer(name: Identifier): Expression | undefined {
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  return binding !== undefined &&
    selected?.keys.length === 0 &&
    isVariableDeclaration(binding) &&
    isVariableDeclarationList(binding.parent) &&
    /^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
    ? binding.initializer
    : undefined;
}

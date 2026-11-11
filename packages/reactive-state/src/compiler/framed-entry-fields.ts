import {
  type Expression,
  isBinaryExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import {
  type AssignedFrameSource,
  iteratedFrameSources,
  literalKey,
} from './framed-assignment-patterns.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedCondition } from './framed-sources.ts';

/** The values a computed key may select from what a destructuring assignment reads. */

/**
 * What sources may hand an unrouted target: their fields or elements, and themselves. The fields a
 * written spread copies into an object literal are the object's own, and a field a later one of
 * the same name overwrites is no value the key can select.
 */
export function possibleFields(
  sources: readonly AssignedFrameSource[],
  seen = new Set<Node>(),
): readonly AssignedFrameSource[] {
  return sources.flatMap((source) => {
    const value = unwrapped(source.value);
    if (source.keys.length > 0) return [source];
    if (!isObjectLiteralExpression(value))
      return [source, ...iteratedFrameSources(value), ...resolvedFields(value, seen)];
    return survivingFields(value, { data: new Set(), getters: new Set() }, true);
  });
}

/**
 * The fields of what an expression stands for where it is not a literal: a constant holds an
 * object, a condition or a logical operator hands over one of two. Each is read once.
 */
function resolvedFields(value: Expression, seen: Set<Node>): readonly AssignedFrameSource[] {
  const held = isIdentifier(value) ? frameBindingOf(value) : undefined;
  const declaration = held?.keys.length === 0 ? held.binding : undefined;
  const initializer =
    declaration !== undefined && isVariableDeclaration(declaration) && isConstant(declaration)
      ? declaration.initializer
      : undefined;
  const chosen = initializer === undefined ? choices(value) : [initializer];
  const fresh = chosen.filter((each) => !seen.has(each));
  for (const each of fresh) seen.add(each);
  return possibleFields(
    fresh.map((each) => ({ value: each, keys: [] })),
    seen,
  );
}

/** Whether a variable is declared with `const`, which no later write changes. */
function isConstant(declaration: VariableDeclaration): boolean {
  const list = declaration.parent;
  return isVariableDeclarationList(list) && /^const\b/u.test(list.getText(list.getSourceFile()));
}

/** The operators that hand over one of their operands. */
const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** What a conditional or a logical expression may hand over: a written literal condition takes one. */
function choices(value: Expression): readonly Expression[] {
  if (isConditionalExpression(value)) {
    const taken = framedCondition(value.condition);
    if (taken !== undefined) return [taken ? value.whenTrue : value.whenFalse];
    return [value.whenTrue, value.whenFalse];
  }
  return isBinaryExpression(value) && LOGICAL.has(value.operatorToken.kind)
    ? [value.left, value.right]
    : [];
}

/**
 * The values a written object holds, each field read as the fields after it leave it. A read of a
 * field reaches the prototype the object sets as well, behind its own fields; a spread copies the
 * own fields only, and passes `false`.
 */
function survivingFields(
  object: ObjectLiteralExpression,
  overwritten: Overwritten,
  inherited: boolean,
): AssignedFrameSource[] {
  const found: AssignedFrameSource[] = [];
  const later = { data: new Set(overwritten.data), getters: new Set(overwritten.getters) };
  for (const property of object.properties.toReversed()) {
    const name = fieldName(property);
    const taken = isGetAccessorDeclaration(property) ? later.getters : later.data;
    if (name === undefined || !taken.has(name)) found.push(...fieldValues(property, later));
    for (const each of fieldNames(property)) {
      later.data.add(each);
      if (!isSetAccessorDeclaration(property)) later.getters.add(each);
    }
  }
  return [...found.toReversed(), ...(inherited ? inheritedValues(object, later) : [])];
}

/**
 * What the prototype a written object sets holds: the prototype itself, which the name
 * `__proto__` reads, and its fields that no field of the object, nor one after it, hides.
 */
function inheritedValues(
  object: ObjectLiteralExpression,
  later: Overwritten,
): AssignedFrameSource[] {
  const proto = object.properties.find((each) => setsPrototype(each));
  if (proto === undefined || !isPropertyAssignment(proto)) return [];
  const own = object.properties.flatMap((each) => fieldNames(each));
  const hidden = { data: withNames(later.data, own), getters: withNames(later.getters, own) };
  const value = unwrapped(proto.initializer);
  if (!isObjectLiteralExpression(value))
    return [...possibleFields([{ value: proto.initializer, keys: [] }])];
  return [{ value: proto.initializer, keys: [] }, ...survivingFields(value, hidden, true)];
}

/** The names of a set, and more. */
function withNames(names: ReadonlySet<string>, more: readonly string[]): Set<string> {
  const merged = new Set(names);
  for (const each of more) merged.add(each);
  return merged;
}

/**
 * The names the fields after one have set. A setter after a getter completes its accessor, and
 * the getter's results stay; a setter hides a value written before it, and every other field,
 * a spread among them, hides the getters and the values written before it.
 */
interface Overwritten {
  readonly data: ReadonlySet<string>;
  readonly getters: ReadonlySet<string>;
}

/**
 * The values one field holds: a getter, what it returns; a spread of a written object, that
 * object's own fields. A spread copies a getter as data, so a field after the spread hides what the
 * getter returned as it hides a value.
 */
function fieldValues(
  property: ObjectLiteralElementLike,
  later: Overwritten,
): readonly AssignedFrameSource[] {
  if (setsPrototype(property)) return [];
  if (isPropertyAssignment(property)) return [{ value: property.initializer, keys: [] }];
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    return [{ value: property.name, keys: [] }];
  if (isGetAccessorDeclaration(property))
    return returnedBy(property).map((value) => ({ value, keys: [] }));
  if (!isSpreadAssignment(property)) return [];
  const copied = unwrapped(property.expression);
  return isObjectLiteralExpression(copied)
    ? survivingFields(copied, { data: later.data, getters: later.data }, false)
    : possibleFields([{ value: property.expression, keys: [] }]);
}

/**
 * The name a written field sets, none for a spread or a computed one the compile cannot read. A
 * written `__proto__: value` sets the prototype and names no field; `['__proto__']` does.
 */
function fieldName(property: ObjectLiteralElementLike): string | undefined {
  if (isSpreadAssignment(property) || setsPrototype(property)) return undefined;
  return literalKey(property.name);
}

/** A written `__proto__: value`, which sets the prototype; `['__proto__']` and a shorthand do not. */
function setsPrototype(property: ObjectLiteralElementLike): boolean {
  return (
    isPropertyAssignment(property) &&
    !isComputedPropertyName(property.name) &&
    literalKey(property.name) === '__proto__'
  );
}

/** The names a field of a written object always sets: its own, or those of the literal it spreads. */
function fieldNames(property: ObjectLiteralElementLike): readonly string[] {
  if (!isSpreadAssignment(property)) {
    const name = fieldName(property);
    return name === undefined ? [] : [name];
  }
  const copied = unwrapped(property.expression);
  return isObjectLiteralExpression(copied)
    ? copied.properties.flatMap((each) => fieldNames(each))
    : [];
}

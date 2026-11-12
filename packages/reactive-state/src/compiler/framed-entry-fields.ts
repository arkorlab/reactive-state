import {
  type BinaryExpression,
  type Expression,
  isBinaryExpression,
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
  isVoidExpression,
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
  setsPrototype,
} from './framed-assignment-patterns.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedCondition } from './framed-sources.ts';

/** The values a computed key may select from what a destructuring assignment reads. */

/**
 * What a read of fields goes through. The names the fields after the one being read have set: a
 * setter after a getter completes its accessor, and the getter's results stay; a setter hides a
 * value written before it, and every other field, a spread among them, hides the getters and the
 * values written before it. Whether a prototype counts: a read reaches it, behind the own fields,
 * and a spread copies the own fields only. And what the read has been to.
 */
interface Reading {
  readonly data: ReadonlySet<string>;
  readonly getters: ReadonlySet<string>;
  readonly inherited: boolean;
  readonly seen: Seen;
}

/** What each way of reading has read, an object with the names the fields after it had hidden. */
interface Seen {
  readonly full: Map<Node, readonly Hiding[]>;
  readonly own: Map<Node, readonly Hiding[]>;
}

interface Hiding {
  readonly data: ReadonlySet<string>;
  readonly getters: ReadonlySet<string>;
}

/**
 * What sources may hand an unrouted target: their fields or elements, and themselves. The fields a
 * written spread copies into an object literal are the object's own, and a field a later one of
 * the same name overwrites is no value the key can select.
 */
export function possibleFields(
  sources: readonly AssignedFrameSource[],
): readonly AssignedFrameSource[] {
  const seen = { full: new Map(), own: new Map() };
  return fieldsOf(sources, { data: new Set(), getters: new Set(), inherited: true, seen });
}

/** The fields of the sources: of a written object as it holds them, of the rest as they resolve. */
function fieldsOf(
  sources: readonly AssignedFrameSource[],
  reading: Reading,
): readonly AssignedFrameSource[] {
  return sources.flatMap((source) => {
    const value = unwrapped(source.value);
    if (source.keys.length > 0) return [source];
    if (!isObjectLiteralExpression(value))
      return [source, ...iteratedFrameSources(value), ...resolvedFields(value, reading)];
    return survivingFields(value, reading);
  });
}

/**
 * Whether the way of reading has not yet read the object under names hidden at least as much: one
 * read under fewer hidden names reads everything a read under more would, so the second is skipped.
 */
function firstRead(reading: Reading, node: Node): boolean {
  const table = reading.inherited ? reading.seen.full : reading.seen.own;
  const earlier = table.get(node) ?? [];
  const covered = earlier.some(
    (each) => isSubset(each.data, reading.data) && isSubset(each.getters, reading.getters),
  );
  if (covered) return false;
  table.set(node, [...earlier, { data: new Set(reading.data), getters: new Set(reading.getters) }]);
  return true;
}

function isSubset(small: ReadonlySet<string>, large: ReadonlySet<string>): boolean {
  for (const each of small) if (!large.has(each)) return false;
  return true;
}

/**
 * The fields of what an expression stands for where it is not a literal: a constant holds an
 * object, a condition or a logical operator hands over one of two. Each is read once.
 */
function resolvedFields(value: Expression, reading: Reading): readonly AssignedFrameSource[] {
  const initializer = constantInitializer(value);
  const chosen = initializer === undefined ? choices(value) : [initializer];
  const fresh = chosen.filter((each) => firstRead(reading, each));
  return fieldsOf(
    fresh.map((each) => ({ value: each, keys: [] })),
    reading,
  );
}

/** The initializer of the constant a name stands for whole. */
function constantInitializer(value: Expression): Expression | undefined {
  const held = isIdentifier(value) ? frameBindingOf(value) : undefined;
  const declaration = held?.keys.length === 0 ? held.binding : undefined;
  return declaration !== undefined && isVariableDeclaration(declaration) && isConstant(declaration)
    ? declaration.initializer
    : undefined;
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

/** The assignments that hand over their left where it holds, and their right where not. */
const LOGICAL_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * What an expression may hand over: one of the branches of a condition, a written literal condition
 * taking one; an operand of a logical expression; the result of an assignment or a comma.
 */
function choices(value: Expression): readonly Expression[] {
  if (isConditionalExpression(value)) {
    const taken = framedCondition(value.condition);
    if (taken !== undefined) return [taken ? value.whenTrue : value.whenFalse];
    return [value.whenTrue, value.whenFalse];
  }
  if (!isBinaryExpression(value)) return [];
  const kind = value.operatorToken.kind;
  if (kind === SyntaxKind.EqualsToken || kind === SyntaxKind.CommaToken) return [value.right];
  return LOGICAL.has(kind) || LOGICAL_ASSIGNMENTS.has(kind) ? operands(value) : [];
}

/**
 * The operands of a logical expression that it may hand over: where the left is a written
 * literal, the short-circuit rule picks the left, which ends it, or the right.
 */
function operands(value: BinaryExpression): readonly Expression[] {
  const { left, right } = value;
  const kind = value.operatorToken.kind;
  if (
    kind === SyntaxKind.QuestionQuestionToken ||
    kind === SyntaxKind.QuestionQuestionEqualsToken
  ) {
    const nullish = nullishness(left);
    if (nullish === undefined) return [left, right];
    return [nullish ? right : left];
  }
  const truth = framedCondition(left);
  if (truth === undefined) return [left, right];
  const and =
    kind === SyntaxKind.AmpersandAmpersandToken ||
    kind === SyntaxKind.AmpersandAmpersandEqualsToken;
  return [truth === and ? right : left];
}

/**
 * Whether what an expression is written as, through the constants that hold it, is null or
 * undefined: `null`, `void 0`, an `undefined` no declaration shadows; or a written value, which is
 * neither. None where the compile cannot tell.
 */
function nullishness(expression: Expression): boolean | undefined {
  const value = writtenValue(expression);
  if (value === undefined) return undefined;
  if (isIdentifier(value))
    return value.text === 'undefined' && frameBindingOf(value) === undefined ? true : undefined;
  if (isVoidExpression(value) || value.kind === SyntaxKind.NullKeyword) return true;
  return framedCondition(value) !== undefined || isObjectLiteralExpression(value)
    ? false
    : undefined;
}

/**
 * What an expression is written as, through the constants that hold it; none where a constant
 * holds itself, however many names the chain passes through.
 */
function writtenValue(expression: Expression): Expression | undefined {
  const seen = new Set<Node>();
  let value = unwrapped(expression);
  for (
    let held = constantInitializer(value);
    held !== undefined;
    held = constantInitializer(value)
  ) {
    if (seen.has(held)) return undefined;
    seen.add(held);
    value = unwrapped(held);
  }
  return value;
}

/**
 * The values a written object holds, each field read as the fields after it leave it. A read of a
 * field reaches the prototype the object sets as well, behind its own fields; a spread copies the
 * own fields only.
 */
function survivingFields(object: ObjectLiteralExpression, reading: Reading): AssignedFrameSource[] {
  const found: AssignedFrameSource[] = [];
  const later = { data: new Set(reading.data), getters: new Set(reading.getters) };
  for (const property of object.properties.toReversed()) {
    const name = fieldName(property);
    const taken = isGetAccessorDeclaration(property) ? later.getters : later.data;
    if (name === undefined || !taken.has(name))
      found.push(...fieldValues(property, { ...reading, ...later }));
    for (const each of fieldNames(property)) {
      later.data.add(each);
      if (!isSetAccessorDeclaration(property)) later.getters.add(each);
    }
  }
  const inherited = reading.inherited ? inheritedValues(object, { ...reading, ...later }) : [];
  return [...found.toReversed(), ...inherited];
}

/**
 * What the prototype a written object sets holds: the prototype itself, which the name
 * `__proto__` reads unless an own field of that name shadows the accessor, and its fields that no
 * field of the object, nor one after it, hides.
 */
function inheritedValues(
  object: ObjectLiteralExpression,
  reading: Reading,
): readonly AssignedFrameSource[] {
  const proto = object.properties.find((each) => setsPrototype(each));
  if (proto === undefined || !isPropertyAssignment(proto)) return [];
  const own = object.properties.flatMap((each) => fieldNames(each));
  const hidden = {
    ...reading,
    data: withNames(reading.data, own),
    getters: withNames(reading.getters, own),
  };
  const value = unwrapped(proto.initializer);
  const container = { value: proto.initializer, keys: [] };
  const read = isObjectLiteralExpression(value)
    ? [container, ...survivingFields(value, hidden)]
    : fieldsOf([container], hidden);
  return hidden.data.has('__proto__') ? read.filter((each) => each !== container) : read;
}

/** The names of a set, and more. */
function withNames(names: ReadonlySet<string>, more: readonly string[]): Set<string> {
  const merged = new Set(names);
  for (const each of more) merged.add(each);
  return merged;
}

/**
 * The values one field holds: a getter, what it returns; a spread, the own fields of what it
 * spreads, a written object or a constant that holds one. A spread copies a getter as data, so a
 * field after the spread hides what the getter returned as it hides a value.
 */
function fieldValues(
  property: ObjectLiteralElementLike,
  reading: Reading,
): readonly AssignedFrameSource[] {
  if (setsPrototype(property)) return [];
  if (isPropertyAssignment(property)) return [{ value: property.initializer, keys: [] }];
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    return [{ value: property.name, keys: [] }];
  if (isGetAccessorDeclaration(property))
    return returnedBy(property).map((value) => ({ value, keys: [] }));
  if (!isSpreadAssignment(property)) return [];
  const copied = { ...reading, getters: reading.data, inherited: false };
  return fieldsOf([{ value: property.expression, keys: [] }], copied);
}

/**
 * The name a written field sets, none for a spread or a computed one the compile cannot read. A
 * written `__proto__: value` sets the prototype and names no field; `['__proto__']` does.
 */
function fieldName(property: ObjectLiteralElementLike): string | undefined {
  if (isSpreadAssignment(property) || setsPrototype(property)) return undefined;
  return literalKey(property.name);
}

/**
 * The names a field of a written object always sets: its own, or those of the literal it spreads,
 * a constant that holds one included.
 */
function fieldNames(property: ObjectLiteralElementLike, seen = new Set<Node>()): readonly string[] {
  if (!isSpreadAssignment(property)) {
    const name = fieldName(property);
    return name === undefined ? [] : [name];
  }
  const copied = writtenValue(property.expression);
  if (copied === undefined || !isObjectLiteralExpression(copied) || seen.has(copied)) return [];
  if (!isStable(property.expression)) return [];
  seen.add(copied);
  return copied.properties.flatMap((each) => fieldNames(each, seen));
}

/**
 * Whether the names a spread's object sets are certain: a written literal is, and so is a constant
 * that the program only ever spreads, or only gives to another constant that is stable in turn. A
 * constant may be given or lose fields where it is named otherwise, and a spread of it sets those it
 * then has.
 */
function isStable(expression: Expression, seen = new Set<Node>()): boolean {
  const value = unwrapped(expression);
  if (isObjectLiteralExpression(value)) return true;
  const held = isIdentifier(value) ? frameBindingOf(value) : undefined;
  const declaration = held?.keys.length === 0 ? held.binding : undefined;
  if (declaration === undefined || !isVariableDeclaration(declaration)) return false;
  if (seen.has(declaration)) return true;
  if (!isIdentifier(declaration.name)) return false;
  seen.add(declaration);
  const { text } = declaration.name;
  const pending: Node[] = [declaration.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isIdentifier(node) &&
      node.text === text &&
      node !== declaration.name &&
      frameBindingOf(node)?.binding === declaration &&
      !isSpreadAssignment(node.parent) &&
      !givenToStable(node, seen)
    )
      return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const initial = declaration.initializer;
  return initial === undefined || !isIdentifier(unwrapped(initial)) || isStable(initial, seen);
}

/** Whether a name is the initializer of a constant that is stable in turn: only an alias of it. */
function givenToStable(name: Node, seen: Set<Node>): boolean {
  const { parent } = name;
  if (!isVariableDeclaration(parent)) return false;
  const initial: Node | undefined = parent.initializer;
  return initial === name && isIdentifier(parent.name) && isStable(parent.name, seen);
}

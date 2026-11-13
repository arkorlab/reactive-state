import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type ObjectLiteralExpression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isConditionalExpression,
  isExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';

/**
 * Where `Object.fromEntries` converts to a name what an object holds. For each entry it reads the
 * field `0`, its own or one it inherits, and converts what it finds to the name it installs: an object
 * there is converted by its `Symbol.toPrimitive` or its `toString`, or those of its prototype, which
 * run application code. So the places that may be a name are the first of a list, and the field `0` of
 * an object: its own, one a spread brings, one the prototype it writes (`__proto__`) has, in turn.
 * What the compile cannot tell the field of is every place of what it is held by.
 */

/** The operators that give the value of one of their operands. */
const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * The expressions one stands for: itself past what wraps it, or, through a condition, a comma, a
 * logical operand, the operands that give their value on.
 */
export function valuesOf(expression: Expression): readonly Expression[] {
  const found: Expression[] = [];
  const pending = [expression];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at);
    if (isConditionalExpression(value)) pending.push(value.whenTrue, value.whenFalse);
    else if (!isBinaryExpression(value)) found.push(value);
    else if (value.operatorToken.kind === SyntaxKind.CommaToken) pending.push(value.right);
    else if (LOGICAL.has(value.operatorToken.kind)) pending.push(value.left, value.right);
    else found.push(value);
  }
  return found;
}

/** How many prototypes written one in another are followed: past it, the whole object is the place. */
const PROTOTYPES = 8;

/** The first of a list; every element of one with a spread, whose first is not known. */
function listSlots(list: ArrayLiteralExpression): readonly Node[] {
  return list.elements.some((each) => isSpreadElement(each))
    ? list.elements
    : list.elements.slice(0, 1);
}

/** The places of what an expression stands for, held as an object an entry inherits from or copies. */
function sourceSlots(source: Expression, inherited: number | undefined): readonly Node[] {
  return valuesOf(source).flatMap((value): readonly Node[] => {
    if (value.kind === SyntaxKind.NullKeyword) return [];
    if (isArrayLiteralExpression(value)) return listSlots(value);
    if (!isObjectLiteralExpression(value)) return [value];
    return objectSlots(value, inherited);
  });
}

/**
 * The places of an object written out that may be the field `0`: its own fields of that name, or of
 * a name the compile cannot read, a spread (which copies the own fields of what it spreads), and,
 * where `inherited` is a depth, the prototype it writes.
 */
function objectSlots(
  object: ObjectLiteralExpression,
  inherited: number | undefined,
): readonly Node[] {
  return object.properties.flatMap((property): readonly Node[] => {
    if (isSpreadAssignment(property)) return sourceSlots(property.expression, undefined);
    const name = writtenArrayKey(property.name);
    if (name === '__proto__' && isPropertyAssignment(property)) {
      if (inherited === undefined) return [];
      return inherited >= PROTOTYPES
        ? [property.initializer]
        : sourceSlots(property.initializer, inherited + 1);
    }
    if (name !== undefined && name !== '0') return [];
    return isPropertyAssignment(property) ? [property.initializer] : [property];
  });
}

/** The places of one entry that may be the name it is installed under. */
function entrySlots(entry: Expression): readonly Node[] {
  if (isArrayLiteralExpression(entry)) return listSlots(entry);
  return isObjectLiteralExpression(entry) ? objectSlots(entry, 0) : [];
}

const SLOTS = new WeakMap<CallExpression, readonly Node[]>();

/** The places of the entries of the call's argument that may be names, whatever the entry is written as. */
function nameSlots(call: CallExpression): readonly Node[] {
  const known = SLOTS.get(call);
  if (known !== undefined) return known;
  const slots: Node[] = [];
  const lists = call.arguments.slice(0, 1).flatMap((each) => valuesOf(each));
  for (let list = lists.pop(); list !== undefined; list = lists.pop()) {
    if (!isArrayLiteralExpression(list)) continue;
    for (const element of list.elements) {
      if (isSpreadElement(element)) lists.push(...valuesOf(element.expression));
      else slots.push(...valuesOf(element).flatMap((entry) => entrySlots(entry)));
    }
  }
  SLOTS.set(call, slots);
  return slots;
}

/** Whether a node lies within another. */
function within(node: Node, container: Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

/**
 * Whether a function lies within an object that may be the name of an entry, and is not that name
 * itself: a function converted to a name is not called by the conversion, one an object holds that is
 * converted may be.
 */
export function convertedToName(made: Node, call: CallExpression): boolean {
  return nameSlots(call).some((slot) => {
    const values = isExpression(slot) ? valuesOf(slot) : [slot];
    return values.some((value) => value !== made && within(made, value));
  });
}

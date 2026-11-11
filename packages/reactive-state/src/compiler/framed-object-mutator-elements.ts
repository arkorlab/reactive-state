import {
  type BinaryExpression,
  type Block,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isVoidExpression,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyName,
  SyntaxKind,
  type VariableStatement,
} from 'typescript/ast';

import { answersLater, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import type { WrittenArrayElement } from './framed-array-elements.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedFactoryReturns } from './framed-factory-returns.ts';
import { heldMemberWrites, heldValue, isConstant } from './framed-held-member-writes.ts';
import { framedAppliedArguments, framedKeyNames } from './framed-keys.ts';
import { keyMayBeSlot, nameMayBeSlot, slotKey } from './framed-mutator-keys.ts';
import { framedCondition } from './framed-sources.ts';
import { framedAssignedValues } from './framed-writes.ts';

/** Native object mutators install the values their written numeric keys carry on an array. */

const PATHS = {
  assign: 'Object.assign',
  properties: 'Object.defineProperties',
  property: 'Object.defineProperty',
} as const;

const MUTATORS: ReadonlySet<string> = new Set(Object.values(PATHS));

/** The operators that hand over one of their operands. */
const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

export interface MutatorElements {
  readonly target: Expression;
  readonly elements: readonly WrittenArrayElement[];
}

/**
 * The target of a native object mutator and the values it may install at the selected index: a
 * written numeric key carries its value, an opaque key or source keeps each value possible.
 */
export function objectMutatorElements(
  call: CallExpression,
  index: number | undefined,
): MutatorElements | undefined {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  if (path === undefined || !MUTATORS.has(path)) return undefined;
  const [target, ...rest] = writtenArguments(call);
  if (target === undefined || isSpreadElement(target)) return undefined;
  const reading = freshReading();
  const mutated = returnedTarget(target);
  if (path === PATHS.assign)
    return {
      target: mutated,
      elements: rest.flatMap((source) => assignedValues(source, index, reading)),
    };
  const defined =
    path === PATHS.properties
      ? definedMaps(rest, index, reading)
      : definedProperty(rest, index, reading);
  return { target: mutated, elements: defined };
}

/** The natives that hand back the object they were given first. */
const RETURNS_TARGET: ReadonlySet<string> = new Set([
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'Object.setPrototypeOf',
  PATHS.assign,
  PATHS.properties,
  PATHS.property,
]);

/**
 * The object a mutation reaches through the natives that return their first argument:
 * Object.assign(Object.assign(a, {}), ...) mutates a.
 */
function returnedTarget(target: Expression): Expression {
  let at = target;
  for (;;) {
    const inner = unwrapped(at);
    if (!isCallExpression(inner)) return at;
    const path = globalPathOf(unwrapped(inner.expression))?.join('.');
    const [first] = writtenArguments(inner);
    if (path === undefined || !RETURNS_TARGET.has(path)) return at;
    if (first === undefined || isSpreadElement(first)) return at;
    at = first;
  }
}

/**
 * What a read of descriptors goes through: whether a descriptor's inherited fields count, as they
 * do for a descriptor and not for what a spread copies, and the objects a constant holds, which
 * are read once in each way however many times the program names them.
 */
interface Reading {
  readonly inherited: boolean;
  readonly seen: {
    readonly full: Set<Node>;
    readonly own: Set<Node>;
    readonly maps: Set<Node>;
    readonly sources: Set<Node>;
  };
}

function freshReading(): Reading {
  return {
    inherited: true,
    seen: { full: new Set(), own: new Set(), maps: new Set(), sources: new Set() },
  };
}

/** Whether an object a constant holds is read for the first time in the way the set stands for. */
function firstRead(seen: Set<Node>, held: Node): boolean {
  if (seen.has(held)) return false;
  seen.add(held);
  return true;
}

/**
 * The call's arguments in order, each spread of a written list, or of a constant list nothing
 * changes, replaced by the entries it stands for; a spread the compile cannot read stays one. A
 * list is expanded each time it is spread, but never within itself.
 */
function writtenArguments(call: CallExpression): readonly Expression[] {
  type Listed = readonly (readonly Expression[])[];
  const written: Expression[] = [];
  const pending = call.arguments.toReversed().map((node) => ({ node, within: [] as Listed }));
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const listed = isSpreadElement(each.node)
      ? framedAppliedArguments(call, each.node.expression)
      : undefined;
    if (listed === undefined || each.within.includes(listed)) written.push(each.node);
    else {
      const within = [...each.within, listed];
      for (const node of listed.toReversed()) pending.push({ node, within });
    }
  }
  return written;
}

/**
 * The key and the descriptor of a definition, after its target. A spread the compile cannot read
 * may be empty, so the argument that follows it may be the key or the descriptor, and what it
 * holds is possible beside that.
 */
function definedProperty(
  args: readonly Expression[],
  index: number | undefined,
  reading: Reading,
): WrittenArrayElement[] {
  const [key] = args;
  if (key === undefined) return [];
  if (!isSpreadElement(key) && !keyMayBeSlot(key, index)) return [];
  return descriptorCandidates(args, reading);
}

/**
 * Every argument that may take the descriptor's position: a spread may be empty, so each argument
 * up to the second written one may be preceded by the key alone.
 */
function descriptorCandidates(
  args: readonly Expression[],
  reading: Reading,
): WrittenArrayElement[] {
  const found: WrittenArrayElement[] = [];
  let written = 0;
  let spread = false;
  for (const argument of args) {
    if (written > 1) break;
    if (isSpreadElement(argument)) {
      const keys = [written === 0 && !spread ? '1' : '0', 'value'];
      found.push({ value: argument.expression, keys });
      spread = true;
    } else {
      if (spread || written === 1) found.push(...descriptorValues(argument, reading));
      written += 1;
    }
  }
  return found;
}

/** The descriptor maps that may take the position after the target: each up to the first written one. */
function definedMaps(
  args: readonly Expression[],
  index: number | undefined,
  reading: Reading,
): WrittenArrayElement[] {
  const found: WrittenArrayElement[] = [];
  for (const map of args) {
    found.push(...definedValues(map, index, reading));
    if (!isSpreadElement(map)) break;
  }
  return found;
}

/** One assign source's values at numeric keys; a getter there answers what it returns. */
function assignedValues(
  source: Expression,
  index: number | undefined,
  reading: Reading,
): WrittenArrayElement[] {
  if (isOmittedExpression(source)) return [];
  if (isSpreadElement(source)) return [{ value: source.expression, keys: ['0', slotKey(index)] }];
  const value = unwrapped(source);
  if (isArrayLiteralExpression(value)) return [{ value, keys: [], array: true }];
  if (!isObjectLiteralExpression(value)) {
    const held = heldValue(value);
    const alternatives = isObjectLiteralExpression(held) ? [held] : alternativesOf(held);
    const opaque = opaqueSource(source, index);
    if (alternatives === undefined || !firstRead(reading.seen.sources, held)) return opaque;
    return [...opaque, ...alternatives.flatMap((each) => assignedValues(each, index, reading))];
  }
  const found: WrittenArrayElement[] = [];
  for (const property of value.properties) {
    if (isSpreadAssignment(property))
      found.push(...assignedValues(property.expression, index, reading));
    else if (!nameMayBeSlot(property.name, index)) continue;
    else if (isPropertyAssignment(property)) found.push({ value: property.initializer, keys: [] });
    else if (isGetAccessorDeclaration(property)) found.push(...returnedValues(property.body));
  }
  return found;
}

/**
 * An opaque source's value at the selected slot; at an unknown one, any element it holds as an
 * array or a tuple does.
 */
function opaqueSource(source: Expression, index: number | undefined): WrittenArrayElement[] {
  const selected = { value: source, keys: [slotKey(index)] };
  return index === undefined ? [selected, { value: source, keys: [], array: true }] : [selected];
}

/**
 * A descriptor map's entries at numeric keys, those of a spread or a constant it names read as
 * written; an opaque map keeps its slot's descriptor.
 */
function definedValues(
  descriptors: Expression,
  index: number | undefined,
  reading: Reading,
): WrittenArrayElement[] {
  if (isOmittedExpression(descriptors)) return [];
  const slot = slotKey(index);
  const value = unwrapped(descriptors);
  if (isSpreadElement(descriptors))
    return [{ value: descriptors.expression, keys: ['0', slot, 'value'] }];
  if (!isObjectLiteralExpression(value)) {
    const held = heldValue(value);
    const opaque = [{ value: descriptors, keys: [slot, 'value'] }];
    const alternatives = isObjectLiteralExpression(held) ? [held] : alternativesOf(held);
    if (alternatives === undefined || !firstRead(reading.seen.maps, held)) return opaque;
    return [...opaque, ...alternatives.flatMap((each) => definedValues(each, index, reading))];
  }
  const found: WrittenArrayElement[] = [];
  for (const property of value.properties) {
    if (isSpreadAssignment(property))
      found.push(...definedValues(property.expression, index, reading));
    else if (isPropertyAssignment(property) && nameMayBeSlot(property.name, index))
      found.push(...descriptorValues(property.initializer, reading));
    else if (isGetAccessorDeclaration(property) && nameMayBeSlot(property.name, index))
      found.push(
        ...returnedValues(property.body).flatMap((each) => descriptorValues(each.value, reading)),
      );
  }
  return found;
}

/**
 * A descriptor's written `value` and what its written `get` returns; an opaque one keeps both. A
 * constant's fields may be assigned, and each value assigned to `value` or `get` is possible.
 */
function descriptorValues(
  descriptor: Expression | undefined,
  reading: Reading,
): WrittenArrayElement[] {
  if (descriptor === undefined || isOmittedExpression(descriptor)) return [];
  if (isSpreadElement(descriptor)) return [{ value: descriptor.expression, keys: ['0', 'value'] }];
  const value = unwrapped(descriptor);
  if (isObjectLiteralExpression(value))
    return value.properties.flatMap((property) => descriptorEntry(property, reading));
  const names: Identifier[] = [];
  const held = heldValue(value, names);
  const opaque = [{ value: descriptor, keys: ['value'] }];
  const seen = reading.inherited ? reading.seen.full : reading.seen.own;
  if (!isObjectLiteralExpression(held)) {
    const alternatives = alternativesOf(held);
    if (alternatives === undefined || !firstRead(seen, held)) return opaque;
    const chosen = alternatives.flatMap((each) => descriptorValues(each, reading));
    return [...opaque, ...chosen, ...descriptorWrites(names)];
  }
  if (!firstRead(seen, held)) return opaque;
  const entries = held.properties.flatMap((property) => descriptorEntry(property, reading));
  return [...opaque, ...entries, ...descriptorWrites(names)];
}

/**
 * The name a descriptor's field is written under, a computed one resolved by what its constants
 * and annotations allow. A name that may be `value` or `get` and may be another is none known.
 */
function descriptorKey(name: PropertyName): string | undefined {
  const key = writtenArrayKey(name);
  if (key !== undefined || !isComputedPropertyName(name)) return key;
  const names = framedKeyNames(name.expression);
  if (names === undefined || names.length === 0) return undefined;
  const reads = names.some((each) => each === 'value' || each === 'get');
  return !reads || names.length === 1 ? names[0] : undefined;
}

/** The fields a spread copies, or those a written prototype gives a descriptor to inherit. */
function copiedFields(
  property: ObjectLiteralElementLike,
  reading: Reading,
): WrittenArrayElement[] | undefined {
  if (isSpreadAssignment(property))
    return descriptorValues(property.expression, { ...reading, inherited: false });
  const prototype = reading.inherited
    ? prototypeField(property, writtenArrayKey(property.name))
    : undefined;
  return prototype === undefined ? undefined : descriptorValues(prototype, reading);
}

/**
 * One field of a written descriptor: its `value`, what its `get` returns, the own fields of a
 * spread, the fields of a prototype. A spread copies own fields only, so what it holds inherited
 * from its prototype is lost.
 */
function descriptorEntry(
  property: ObjectLiteralElementLike,
  reading: Reading,
): WrittenArrayElement[] {
  const copied = copiedFields(property, reading);
  if (copied !== undefined) return copied;
  if (isSpreadAssignment(property)) return [];
  const key = descriptorKey(property.name);
  if (key !== undefined && key !== 'value' && key !== 'get') return [];
  const found: WrittenArrayElement[] = [];
  if (key !== 'get' && isPropertyAssignment(property))
    found.push({ value: property.initializer, keys: [] });
  else if (
    key === 'value' &&
    isShorthandPropertyAssignment(property) &&
    isIdentifier(property.name)
  )
    found.push({ value: property.name, keys: [] });
  else if (key !== 'value' && isMethodDeclaration(property) && !answersLater(property))
    found.push(...returnedValues(property.body));
  if (key !== 'value' && isPropertyAssignment(property))
    found.push(...functionReturns(property.initializer));
  if (key !== 'value' && isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    found.push(...functionReturns(property.name));
  return isGetAccessorDeclaration(property) ? [...found, ...accessedValues(property, key)] : found;
}

/** The object a written `__proto__: object` field sets as the prototype, whose fields are inherited. */
function prototypeField(
  property: ObjectLiteralElementLike,
  key: string | undefined,
): Expression | undefined {
  const written = key === '__proto__' && isPropertyAssignment(property);
  return written && !isComputedPropertyName(property.name) ? property.initializer : undefined;
}

/** A descriptor field written as an accessor: its `value`, or the getter its `get` hands over. */
function accessedValues(
  property: ObjectLiteralElementLike & { readonly body?: Block | undefined },
  key: string | undefined,
): WrittenArrayElement[] {
  const returned = returnedValues(property.body);
  const getters = key === 'value' ? [] : returned.flatMap((each) => functionReturns(each.value));
  return key === 'get' ? getters : [...returned, ...getters];
}

/**
 * What a written synchronous function, or a name that holds one, returns as a getter. A name that
 * is assigned before the getter is read may hold what it is assigned instead, as it stands where it
 * is named. Each place that names a function is read once, which keeps a name that holds itself
 * from being followed for good.
 */
function functionReturns(initializer: Expression, seen = new Set<Node>()): WrittenArrayElement[] {
  if (seen.has(initializer)) return [];
  seen.add(initializer);
  const names: Identifier[] = [];
  const held = heldValue(initializer, names);
  const alternatives = alternativesOf(held);
  const returned =
    alternatives === undefined
      ? bodyReturns(held)
      : alternatives.flatMap((each) => functionReturns(each, seen));
  const replaced = names
    .flatMap((name) => [...variableInitializer(name), ...framedAssignedValues(name)])
    .flatMap((each) => functionReturns(each, seen));
  return distinctElements([...returned, ...replaced]);
}

/** The elements without the repeats that reading one function from two places makes. */
function distinctElements(elements: readonly WrittenArrayElement[]): WrittenArrayElement[] {
  const same = (left: WrittenArrayElement, right: WrittenArrayElement): boolean =>
    left.value === right.value && left.keys.join('.') === right.keys.join('.');
  return elements.filter((each, at) => elements.findIndex((other) => same(other, each)) === at);
}

/**
 * The values a conditional or a logical expression may hand over, the one a written literal
 * condition takes alone; none for any other expression.
 */
function alternativesOf(
  value: Expression | FunctionDeclaration,
): readonly Expression[] | undefined {
  if (isConditionalExpression(value)) {
    const taken = framedCondition(value.condition);
    if (taken !== undefined) return [taken ? value.whenTrue : value.whenFalse];
    return [value.whenTrue, value.whenFalse];
  }
  if (isBinaryExpression(value) && LOGICAL.has(value.operatorToken.kind)) return operands(value);
  return undefined;
}

/**
 * Whether what an expression is written as, through the constants that hold it, is null or
 * undefined: `null`, `void 0`, an `undefined` no declaration shadows; or a written value, which is
 * neither. None where the compile cannot tell.
 */
function nullishness(expression: Expression): boolean | undefined {
  const value = heldValue(expression);
  if (isFunctionDeclaration(value)) return false;
  if (isIdentifier(value))
    return value.text === 'undefined' && frameBindingOf(value) === undefined ? true : undefined;
  if (isVoidExpression(value) || value.kind === SyntaxKind.NullKeyword) return true;
  const written =
    framedCondition(value) !== undefined ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value);
  return written ? false : undefined;
}

/**
 * The operands of a logical expression that it may hand over: where the left is a written
 * literal, the short-circuit rule picks the left, which ends it, or the right.
 */
function operands(value: BinaryExpression): readonly Expression[] {
  const { left, right } = value;
  const kind = value.operatorToken.kind;
  if (kind === SyntaxKind.QuestionQuestionToken) {
    const nullish = nullishness(left);
    if (nullish === undefined) return [left, right];
    return [nullish ? right : left];
  }
  const truth = framedCondition(left);
  if (truth === undefined) return [left, right];
  const taken = truth === (kind === SyntaxKind.AmpersandAmpersandToken) ? right : left;
  return [taken];
}

/** What a written function returns when it is called. */
function bodyReturns(fn: Expression | FunctionDeclaration): WrittenArrayElement[] {
  if (isFunctionDeclaration(fn)) return answersLater(fn) ? [] : returnedValues(fn.body);
  if ((!isArrowFunction(fn) && !isFunctionExpression(fn)) || answersLater(fn)) return [];
  return isBlock(fn.body) ? returnedValues(fn.body) : [{ value: fn.body, keys: [] }];
}

/**
 * The values assigned to the `value` and `get` fields of an object a constant holds, or of what it
 * is aliased to: a constant does not keep its fields from changing. An assignment anywhere counts.
 */
function descriptorWrites(names: readonly Identifier[]): WrittenArrayElement[] {
  const [first] = names;
  if (first === undefined) return [];
  return heldMemberWrites(first, names).flatMap(({ key, value }) => {
    const installed = key === undefined || key === 'value' ? [{ value, keys: [] }] : [];
    return key === undefined || key === 'get'
      ? [...installed, ...functionReturns(value)]
      : installed;
  });
}

/** The initializer of a variable that is not a constant: what it holds before a write replaces it. */
function variableInitializer(name: Identifier): readonly Expression[] {
  const selected = frameBindingOf(name);
  const declaration = selected?.keys.length === 0 ? selected.binding : undefined;
  const held =
    declaration !== undefined && isVariableDeclaration(declaration) && !isConstant(declaration)
      ? declaration.initializer
      : undefined;
  return held === undefined ? [] : [held];
}

/** What a getter's body may return: by its flow where that is followed, by each `return` else. */
function returnedValues(body: Block | undefined): WrittenArrayElement[] {
  if (body === undefined) return [];
  const values = framedFactoryReturns(body, constantStatement) ?? writtenReturns(body);
  return values.map((value) => ({ value, keys: [] }));
}

/** Each value a body writes after `return`, those of its nested functions and classes left out. */
function writtenReturns(body: Block): readonly Expression[] {
  const found: Expression[] = [];
  const pending: Node[] = [body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isReturnStatement(node) && node.expression !== undefined) found.push(node.expression);
    node.forEachChild((child) => {
      if (!hasOwnReturns(child)) pending.push(child);
    });
  }
  return found;
}

/** A nested function, a setter among them, or a class: what it returns is not the getter's. */
function hasOwnReturns(node: Node): boolean {
  return (
    isAnswering(node) ||
    isSetAccessorDeclaration(node) ||
    isClassDeclaration(node) ||
    isClassExpression(node)
  );
}

/** A constant declaration, as the object-member readers take it, keeps the body's flow followed. */
function constantStatement(statement: VariableStatement): boolean {
  return /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()));
}

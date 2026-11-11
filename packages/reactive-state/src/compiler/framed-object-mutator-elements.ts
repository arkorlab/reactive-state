import {
  type Block,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
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
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyName,
  type VariableStatement,
} from 'typescript/ast';

import { answersLater, isAnswering, overloadsOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import type { WrittenArrayElement } from './framed-array-elements.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameBindingOf, frameDeclarationOf, } from './framed-bindings.ts';
import { framedFactoryReturns } from './framed-factory-returns.ts';
import { framedAppliedArguments, framedKeyNames } from './framed-keys.ts';
import { framedAssignedValues, } from './framed-writes.ts';

/** Native object mutators install the values their written numeric keys carry on an array. */

const MUTATORS = new Set(['Object.assign', 'Object.defineProperties', 'Object.defineProperty']);

/** How many times a getter's name is followed through the functions it may be assigned. */
const REPLACEMENTS = { depth: 3 } as const;

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
  if (path === 'Object.assign')
    return { target, elements: rest.flatMap((source) => assignedValues(source, index)) };
  const reading = freshReading();
  const defined =
    path === 'Object.defineProperties'
      ? definedMaps(rest, index, reading)
      : definedProperty(rest, index, reading);
  return { target, elements: defined };
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
  };
}

function freshReading(): Reading {
  return { inherited: true, seen: { full: new Set(), own: new Set(), maps: new Set() } };
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
function assignedValues(source: Expression, index: number | undefined): WrittenArrayElement[] {
  if (isOmittedExpression(source)) return [];
  if (isSpreadElement(source)) return [{ value: source.expression, keys: ['0', slotKey(index)] }];
  const value = unwrapped(source);
  if (isArrayLiteralExpression(value)) return [{ value, keys: [], array: true }];
  if (!isObjectLiteralExpression(value)) return opaqueSource(source, index);
  const found: WrittenArrayElement[] = [];
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) found.push(...assignedValues(property.expression, index));
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
    return isObjectLiteralExpression(held) && firstRead(reading.seen.maps, held)
      ? [...opaque, ...definedValues(held, index, reading)]
      : opaque;
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
  const held = heldValue(value);
  const opaque = [{ value: descriptor, keys: ['value'] }];
  const seen = reading.inherited ? reading.seen.full : reading.seen.own;
  if (!isObjectLiteralExpression(held) || !firstRead(seen, held)) return opaque;
  const entries = held.properties.flatMap((property) => descriptorEntry(property, reading));
  return [...opaque, ...entries];
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
  const key = writtenArrayKey(property.name);
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
 * is assigned before the getter is read may hold what it is assigned instead.
 */
function functionReturns(initializer: Expression, depth = 0): WrittenArrayElement[] {
  const names: Identifier[] = [];
  const returned = bodyReturns(heldValue(initializer, names));
  if (depth >= REPLACEMENTS.depth) return returned;
  const replaced = names
    .flatMap((name) => [...variableInitializer(name), ...framedAssignedValues(name)])
    .flatMap((each) => functionReturns(each, depth + 1));
  return [...returned, ...replaced];
}

/** What a written function returns when it is called. */
function bodyReturns(fn: Expression | FunctionDeclaration): WrittenArrayElement[] {
  if (isFunctionDeclaration(fn)) return answersLater(fn) ? [] : returnedValues(fn.body);
  if ((!isArrowFunction(fn) && !isFunctionExpression(fn)) || answersLater(fn)) return [];
  return isBlock(fn.body) ? returnedValues(fn.body) : [{ value: fn.body, keys: [] }];
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

/**
 * What a name holds: a function it declares, or the initializer of a constant it names whole; the
 * names it passes through are given back.
 */
function heldValue(
  expression: Expression,
  names: Identifier[] = [],
): Expression | FunctionDeclaration {
  let value = unwrapped(expression);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    names.push(value);
    const declared = frameDeclarationOf(value);
    if (declared !== undefined && isFunctionDeclaration(declared))
      return implementationOf(declared);
    const selected = frameBindingOf(value);
    const held =
      selected?.keys.length === 0 &&
      isVariableDeclaration(selected.binding) &&
      isConstant(selected.binding)
        ? selected.binding.initializer
        : undefined;
    if (held === undefined) return value;
    value = unwrapped(held);
  }
  return value;
}

/** The declaration that has the body among those a function is declared over: its signatures. */
function implementationOf(declared: FunctionDeclaration): FunctionDeclaration {
  const written = overloadsOf(declared).find(
    (each): each is FunctionDeclaration => isFunctionDeclaration(each) && each.body !== undefined,
  );
  return written ?? declared;
}

/** Whether a variable is declared with `const`, which no later write changes. */
function isConstant(declaration: Node): boolean {
  const list = declaration.parent;
  return isVariableDeclarationList(list) && /^const\b/u.test(list.getText(list.getSourceFile()));
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

/** The greatest array index: a larger integer names an ordinary property, no element. */
const ARRAY_INDEX = { last: 4_294_967_294 } as const;

/** Whether a written key may name the slot: its constants and branches decide, an opaque one may. */
function keyMayBeSlot(key: Expression, index: number | undefined): boolean {
  if (isOmittedExpression(key)) return false;
  const names = framedKeyNames(key);
  return (
    names === undefined || names.length === 0 || names.some((each) => possibleKey(each, index))
  );
}

/** Whether an object field's name may name the slot, a computed one by what its key may be. */
function nameMayBeSlot(name: PropertyName, index: number | undefined): boolean {
  return isComputedPropertyName(name)
    ? keyMayBeSlot(name.expression, index)
    : possibleKey(writtenArrayKey(name), index);
}

/** A key that may name the selected array slot: an unknown one, or a canonical index. */
function possibleKey(key: string | number | undefined, index: number | undefined): boolean {
  if (key === undefined) return true;
  const text = String(key);
  if (!/^(?:0|[1-9]\d*)$/u.test(text) || Number(text) > ARRAY_INDEX.last) return false;
  return index === undefined || Number(text) === index;
}

/** The opaque numeric path a source's selected slot takes, the first for an unknown one. */
function slotKey(index: number | undefined): string {
  return index === undefined ? '0' : String(index);
}

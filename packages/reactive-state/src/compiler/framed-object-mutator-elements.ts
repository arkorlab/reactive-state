import {
  type Block,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isClassDeclaration,
  isClassExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type VariableStatement,
} from 'typescript/ast';

import { answersLater, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import type { WrittenArrayElement } from './framed-array-elements.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedFactoryReturns } from './framed-factory-returns.ts';
import { constantValue } from './numbers.ts';

/** Native object mutators install the values their written numeric keys carry on an array. */

const MUTATORS = new Set(['Object.assign', 'Object.defineProperties', 'Object.defineProperty']);

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
  const [target, first, second] = call.arguments;
  if (target === undefined || isSpreadElement(target)) return undefined;
  if (path === 'Object.assign') {
    const elements = call.arguments.slice(1).flatMap((source) => assignedValues(source, index));
    return { target, elements };
  }
  if (first === undefined) return { target, elements: [] };
  if (path === 'Object.defineProperties') return { target, elements: definedValues(first, index) };
  const key = isSpreadElement(first) ? undefined : constantValue(first);
  return { target, elements: possibleKey(key, index) ? descriptorValues(second) : [] };
}

/** One assign source's values at numeric keys; a getter there answers what it returns. */
function assignedValues(source: Expression, index: number | undefined): WrittenArrayElement[] {
  const slot = slotKey(index);
  if (isSpreadElement(source)) return [{ value: source.expression, keys: ['0', slot] }];
  const value = unwrapped(source);
  if (isArrayLiteralExpression(value)) return [{ value, keys: [], array: true }];
  if (!isObjectLiteralExpression(value)) return opaqueSource(source, index);
  const found: WrittenArrayElement[] = [];
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) found.push(...opaqueSource(property.expression, index));
    else if (!possibleKey(writtenArrayKey(property.name), index)) continue;
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

/** A descriptor map's entries at numeric keys; an opaque map keeps its slot's descriptor. */
function definedValues(descriptors: Expression, index: number | undefined): WrittenArrayElement[] {
  const slot = slotKey(index);
  const value = unwrapped(descriptors);
  if (isSpreadElement(descriptors) || !isObjectLiteralExpression(value))
    return [{ value: descriptors, keys: [slot, 'value'] }];
  const found: WrittenArrayElement[] = [];
  for (const property of value.properties) {
    if (isSpreadAssignment(property))
      found.push({ value: property.expression, keys: [slot, 'value'] });
    else if (isPropertyAssignment(property) && possibleKey(writtenArrayKey(property.name), index))
      found.push(...descriptorValues(property.initializer));
  }
  return found;
}

/** A descriptor's written `value` and what its written `get` returns; an opaque one keeps both. */
function descriptorValues(descriptor: Expression | undefined): WrittenArrayElement[] {
  if (descriptor === undefined) return [];
  const value = unwrapped(descriptor);
  if (!isObjectLiteralExpression(value)) {
    const held = heldValue(value);
    const opaque = [{ value: descriptor, keys: ['value'] }];
    return isObjectLiteralExpression(held)
      ? [...opaque, ...held.properties.flatMap((property) => descriptorEntry(property))]
      : opaque;
  }
  return value.properties.flatMap((property) => descriptorEntry(property));
}

/** One field of a written descriptor: its `value`, what its `get` returns, a spread's both. */
function descriptorEntry(property: ObjectLiteralElementLike): WrittenArrayElement[] {
  if (isSpreadAssignment(property)) return [{ value: property.expression, keys: ['value'] }];
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

/** A descriptor field written as an accessor: its `value`, or the getter its `get` hands over. */
function accessedValues(
  property: ObjectLiteralElementLike & { readonly body?: Block | undefined },
  key: string | undefined,
): WrittenArrayElement[] {
  const returned = returnedValues(property.body);
  const getters = key === 'value' ? [] : returned.flatMap((each) => functionReturns(each.value));
  return key === 'get' ? getters : [...returned, ...getters];
}

/** What a written synchronous function, or a name that holds one, returns as a getter. */
function functionReturns(initializer: Expression): WrittenArrayElement[] {
  const fn = heldValue(initializer);
  if (isFunctionDeclaration(fn)) return answersLater(fn) ? [] : returnedValues(fn.body);
  if ((!isArrowFunction(fn) && !isFunctionExpression(fn)) || answersLater(fn)) return [];
  return isBlock(fn.body) ? returnedValues(fn.body) : [{ value: fn.body, keys: [] }];
}

/** What a name holds: a function it declares, or the initializer of a constant, through aliases. */
function heldValue(expression: Expression): Expression | FunctionDeclaration {
  let value = unwrapped(expression);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = frameDeclarationOf(value);
    if (declared !== undefined && isFunctionDeclaration(declared)) return declared;
    const held =
      declared !== undefined && isVariableDeclaration(declared) && isConstant(declared)
        ? declared.initializer
        : undefined;
    if (held === undefined) return value;
    value = unwrapped(held);
  }
  return value;
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
      if (!isAnswering(child) && !isClassDeclaration(child) && !isClassExpression(child))
        pending.push(child);
    });
  }
  return found;
}

/** A constant declaration, as the object-member readers take it, keeps the body's flow followed. */
function constantStatement(statement: VariableStatement): boolean {
  return /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()));
}

/** The greatest array index: a larger integer names an ordinary property, no element. */
const ARRAY_INDEX = { last: 4_294_967_294 } as const;

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

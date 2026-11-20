import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isClassExpression,
  isComputedPropertyName,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isVoidExpression,
  type Node,
  type ObjectLiteralElementLike,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { arrayLengthValueThrows } from './throw-array-lengths.ts';
import { globalCalleePath } from './throw-callees.ts';
import { writtenOf } from './throw-shapes.ts';

/** What a property definition cannot change on a written non-extensible or non-configurable target. */

type Flag = 'configurable' | 'enumerable' | 'writable';
type ValueField = 'get' | 'set' | 'value';
interface Known {
  readonly value: Node | boolean | number | string | null | undefined;
  readonly source?: Expression;
}
interface Definition {
  readonly fields: ReadonlySet<string>;
  readonly flags: ReadonlyMap<Flag, boolean | undefined>;
  readonly values: ReadonlyMap<ValueField, Known | undefined>;
  readonly kind: 'accessor' | 'data' | undefined;
}
export interface Property {
  readonly kind: 'accessor' | 'data';
  readonly configurable: boolean;
  readonly enumerable: boolean;
  readonly writable: boolean;
  readonly values: ReadonlyMap<ValueField, Known | undefined>;
}
interface Target {
  readonly array: boolean;
  readonly properties: Map<string, Property>;
  readonly extensible: boolean;
}
interface Defining {
  readonly key: string;
  readonly descriptor: Definition;
}

const FLAGS: readonly Flag[] = ['configurable', 'enumerable', 'writable'];
const VALUES: readonly ValueField[] = ['get', 'set', 'value'];
const CREATE = 'Object.create';
const DEFINE = 'Object.defineProperty';
const DEFINES = 'Object.defineProperties';
const FREEZE = 'Object.freeze';
const PREVENT = 'Object.preventExtensions';
const SEAL = 'Object.seal';
const ARITIES = { descriptor: 3, pair: 2, single: 1 } as const;
const OPERATIONS: ReadonlyMap<string, number> = new Map([
  [CREATE, ARITIES.pair],
  [DEFINE, ARITIES.descriptor],
  [DEFINES, ARITIES.pair],
  [FREEZE, ARITIES.single],
  [PREVENT, ARITIES.single],
  [SEAL, ARITIES.single],
]);

/** Literal array definitions followed through unchanged lexical target and descriptor aliases. */
export function arrayDefinitionsThrow(node: Node, resolve: Resolve | undefined): boolean {
  if (
    !isCallExpression(node) ||
    priorDefinitionEffect(node) ||
    node.arguments.some((each) => isSpreadElement(each) || callbackCreationEffect(each))
  ) {
    return false;
  }
  const follow: Resolve = (name) => {
    const held = resolve?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, node) ? undefined : held;
  };
  const path = globalCalleePath(node.expression, follow)?.join('.') ?? '';
  if (path !== DEFINE && path !== DEFINES) {
    return false;
  }
  const [first] = node.arguments;
  return (
    first !== undefined &&
    targetOf(first, follow)?.array === true &&
    definitionsThrow(path, node.arguments, follow)
  );
}

/** Earlier application evaluation can replace Object's selected native definition operation. */
function priorDefinitionEffect(node: Node): boolean {
  if (earlierExpressionEffect(node)) {
    return true;
  }
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** A source-proven own descriptor snapshot, shared by strict property writes. */
export function writtenDescriptors(
  node: Expression,
  resolve: Resolve | undefined,
): Target | undefined {
  return targetOf(node, resolve);
}

/** Whether Object's throwing definition operations contradict a written target's own constraints. */
export function definitionsThrow(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  if (path !== DEFINE && path !== DEFINES) {
    return false;
  }
  const arity = OPERATIONS.get(path) ?? 0;
  if (given.length > arity || given.some((each) => isSpreadElement(each))) {
    return false;
  }
  const [node] = given;
  const target = node === undefined ? undefined : targetOf(node, resolve);
  const definitions = definitionsOf(path, given, resolve);
  if (target === undefined || definitions === undefined) {
    return false;
  }
  const at = node?.parent;
  const lengths = at !== undefined && isCallExpression(at) && !priorDefinitionEffect(at);
  for (const each of definitions) {
    if (incompatible(target, each, resolve, lengths)) {
      return true;
    }
    if (!update(target, each)) {
      return false;
    }
  }
  return false;
}

/** The own descriptors of a literal followed through locking and compatible definition operations. */
function targetOf(
  node: Expression,
  resolve: Resolve | undefined,
  seen: ReadonlySet<Expression> = new Set(),
): Target | undefined {
  const value = writtenOf(node, resolve);
  if (seen.has(value)) {
    return undefined;
  }
  if (isObjectLiteralExpression(value) || isArrayLiteralExpression(value)) {
    return literalTarget(value, resolve);
  }
  if (!isCallExpression(value) || value.arguments.some((each) => isSpreadElement(each))) {
    return undefined;
  }
  const path = globalPath(writtenOf(value.expression, resolve))?.join('.') ?? '';
  const arity = OPERATIONS.get(path);
  const [first] = value.arguments;
  if (arity === undefined || first === undefined || value.arguments.length > arity) {
    return undefined;
  }
  const target =
    path === CREATE
      ? { array: false, extensible: true, properties: new Map<string, Property>() }
      : targetOf(first, resolve, new Set([...seen, value]));
  return target === undefined ? undefined : operated(target, path, value.arguments, resolve);
}

/** What a known locking or defining call leaves of its target's descriptors. */
function operated(
  target: Target,
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): Target | undefined {
  if (path === PREVENT) {
    return { ...target, extensible: false };
  }
  if (path === FREEZE || path === SEAL) {
    for (const [key, property] of target.properties) {
      target.properties.set(key, {
        ...property,
        configurable: false,
        writable: path !== FREEZE && property.writable,
      });
    }
    return { ...target, extensible: false };
  }
  const definitions = definitionsOf(path, given, resolve);
  if (definitions === undefined) {
    return undefined;
  }
  return definitions.every((each) => !incompatible(target, each, resolve) && update(target, each))
    ? target
    : undefined;
}

/** The descriptors a single definition or a plain dictionary supplies, in property-key order. */
function definitionsOf(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): readonly Defining[] | undefined {
  if (path === DEFINE) {
    const [, named, described] = given;
    const key = named === undefined ? undefined : keyOf(named, resolve);
    const descriptor = described === undefined ? undefined : descriptorOf(described, resolve);
    return key === undefined || descriptor === undefined ? undefined : [{ descriptor, key }];
  }
  const [, described] = given;
  if (described === undefined && path === CREATE) {
    return [];
  }
  const fields = described === undefined ? undefined : dataFields(described, resolve);
  if (fields === undefined) {
    return undefined;
  }
  const definitions = new Map<string, Definition>();
  for (const [key, value] of fields) {
    const descriptor = descriptorOf(value, resolve);
    if (descriptor === undefined) {
      return undefined;
    }
    definitions.set(key, descriptor);
  }
  return Object.keys(Object.fromEntries(definitions)).flatMap((key) => {
    const descriptor = definitions.get(key);
    return descriptor === undefined ? [] : [{ descriptor, key }];
  });
}

/** Whether a requested own descriptor is known incompatible with the target's existing one. */
function incompatible(
  target: Target,
  { key, descriptor }: Defining,
  resolve: Resolve | undefined,
  lengths = true,
): boolean {
  const source = descriptor.values.get('value')?.source;
  const invalidLength = source !== undefined && arrayLengthValueThrows(source, resolve);
  const lengthProperty = target.array && key === 'length';
  if (lengthProperty && lengths && invalidLength) {
    return true;
  }
  const current = target.properties.get(key);
  if (current === undefined) {
    return !target.extensible;
  }
  if (current.configurable) {
    return false;
  }
  if (
    descriptor.flags.get('configurable') === true ||
    (descriptor.flags.has('enumerable') &&
      descriptor.flags.get('enumerable') !== undefined &&
      descriptor.flags.get('enumerable') !== current.enumerable) ||
    (descriptor.kind !== undefined && descriptor.kind !== current.kind)
  ) {
    return true;
  }
  if (current.kind === 'accessor') {
    return ['get', 'set'].some((field) => differentValue(current, descriptor, field as ValueField));
  }
  return (
    !current.writable &&
    (descriptor.flags.get('writable') === true || differentValue(current, descriptor, 'value'))
  );
}

/** Whether both written values are known and not SameValue, which distinguishes zero's two signs. */
function differentValue(current: Property, descriptor: Definition, field: ValueField): boolean {
  const before = current.values.get(field);
  const after = descriptor.values.get(field);
  return before !== undefined && after !== undefined && !Object.is(before.value, after.value);
}

/** A compatible descriptor applied where all its flags are known; unknown flags end a snapshot. */
function update(target: Target, { key, descriptor }: Defining): boolean {
  if ([...descriptor.flags.values()].includes(undefined)) {
    return false;
  }
  const before = target.properties.get(key);
  const kind = descriptor.kind ?? before?.kind ?? 'data';
  const same = before?.kind === kind ? before : undefined;
  const values = new Map<ValueField, Known | undefined>(
    same?.values ?? VALUES.map((field) => [field, { value: undefined }]),
  );
  for (const [field, value] of descriptor.values) {
    values.set(field, value);
  }
  target.properties.set(key, {
    configurable: descriptor.flags.get('configurable') ?? before?.configurable ?? false,
    enumerable: descriptor.flags.get('enumerable') ?? before?.enumerable ?? false,
    kind,
    values,
    writable: descriptor.flags.get('writable') ?? same?.writable ?? false,
  });
  return true;
}

/** A descriptor's own data fields, without invoking accessors or reading unknown prototypes. */
function descriptorOf(node: Expression, resolve: Resolve | undefined): Definition | undefined {
  const fields = dataFields(node, resolve);
  if (fields === undefined) {
    return undefined;
  }
  const flags = new Map<Flag, boolean | undefined>();
  const values = new Map<ValueField, Known | undefined>();
  for (const field of FLAGS) {
    const value = fields.get(field);
    if (value !== undefined) {
      const known = knownOf(value, resolve);
      flags.set(field, known === undefined ? undefined : Boolean(known.value));
    }
  }
  for (const field of VALUES) {
    const value = fields.get(field);
    if (value !== undefined) {
      values.set(field, knownOf(value, resolve));
    }
  }
  let kind: Definition['kind'];
  if (fields.has('get') || fields.has('set')) {
    kind = 'accessor';
  } else if (fields.has('value') || fields.has('writable')) {
    kind = 'data';
  }
  return { fields: new Set(fields.keys()), flags, kind, values };
}

/** Plain data fields whose names and evaluation cannot hide descriptor getters or a custom prototype. */
function dataFields(
  node: Expression,
  resolve: Resolve | undefined,
): Map<string, Expression> | undefined {
  const value = writtenOf(node, resolve);
  if (!isObjectLiteralExpression(value)) {
    return undefined;
  }
  const fields = new Map<string, Expression>();
  for (const property of value.properties) {
    const key = propertyKey(property, resolve);
    const data = propertyValue(property);
    if (key === undefined || data === undefined || key === '__proto__') {
      return undefined;
    }
    fields.set(key, data);
  }
  return fields;
}

/** A literal target's own data and accessor descriptors, before any locking operation. */
function literalTarget(value: Expression, resolve: Resolve | undefined): Target | undefined {
  const properties = new Map<string, Property>();
  if (isArrayLiteralExpression(value)) {
    if (value.elements.some((each) => isSpreadElement(each))) {
      return undefined;
    }
    for (const [index, each] of value.elements.entries()) {
      if (!isOmittedExpression(each)) {
        properties.set(String(index), dataProperty(knownOf(each, resolve)));
      }
    }
    properties.set('length', {
      ...dataProperty({ value: value.elements.length }),
      configurable: false,
      enumerable: false,
    });
    return { array: true, extensible: true, properties };
  }
  if (!isObjectLiteralExpression(value)) {
    return undefined;
  }
  for (const property of value.properties) {
    const key = propertyKey(property, resolve);
    if (key === undefined) {
      return undefined;
    }
    if (
      key === '__proto__' &&
      isPropertyAssignment(property) &&
      !isComputedPropertyName(property.name)
    ) {
      continue;
    }
    properties.set(key, literalProperty(property, properties.get(key), resolve));
  }
  return { array: false, extensible: true, properties };
}

/** A literal property's data value or paired accessors, with missing accessors known undefined. */
function literalProperty(
  property: ObjectLiteralElementLike,
  before: Property | undefined,
  resolve: Resolve | undefined,
): Property {
  if (isGetAccessorDeclaration(property) || isSetAccessorDeclaration(property)) {
    const missing = VALUES.map((field) => [field, { value: undefined }] as const);
    const values = new Map<ValueField, Known | undefined>([
      ...(before?.kind === 'accessor' ? before.values : missing),
      [isGetAccessorDeclaration(property) ? 'get' : 'set', { value: property }],
    ]);
    return { ...dataProperty(undefined), kind: 'accessor', values };
  }
  if (isMethodDeclaration(property)) {
    return dataProperty({ value: property });
  }
  const data = propertyValue(property);
  return dataProperty(data === undefined ? undefined : knownOf(data, resolve));
}

/** The ordinary flags of a data property written in a literal. */
function dataProperty(value: Known | undefined): Property {
  return {
    configurable: true,
    enumerable: true,
    kind: 'data',
    values: new Map([['value', value]]),
    writable: true,
  };
}

/** A property name, including a known computed key; no spread or prototype-setting literal entry. */
function propertyKey(
  property: ObjectLiteralElementLike,
  resolve: Resolve | undefined,
): string | undefined {
  if (isSpreadAssignment(property)) {
    return undefined;
  }
  const { name } = property;
  if (isComputedPropertyName(name)) {
    return keyOf(name.expression, resolve);
  }
  return isIdentifier(name) ? name.text : literalKey(name);
}

/** The expression held by an ordinary data property, or its method's function identity. */
function propertyValue(property: ObjectLiteralElementLike): Expression | undefined {
  if (isPropertyAssignment(property)) {
    return property.initializer;
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? property.name
    : undefined;
}

/** A known property key written as text or a number, followed through constants. */
function keyOf(node: Expression, resolve: Resolve | undefined): string | undefined {
  const value = constantValue(node, resolve);
  return value === undefined ? undefined : String(value);
}

/** A known primitive value or object/function identity, without executing conversions or user code. */
function knownOf(node: Expression, resolve: Resolve | undefined): Known | undefined {
  const value = writtenOf(node, resolve);
  const constant = constantValue(value, resolve);
  if (constant !== undefined) {
    return { source: node, value: constant };
  }
  if (value.kind === SyntaxKind.NullKeyword) {
    return { source: node, value: null };
  }
  if (value.kind === SyntaxKind.TrueKeyword || value.kind === SyntaxKind.FalseKeyword) {
    return { source: node, value: value.kind === SyntaxKind.TrueKeyword };
  }
  if (isVoidExpression(value) || (isIdentifier(value) && globalOf(value) === 'undefined')) {
    return { source: node, value: undefined };
  }
  return isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value)
    ? { value }
    : undefined;
}

import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isComputedPropertyName,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedDescriptorChoices, framedDescriptorEntries } from './framed-descriptor-entries.ts';
import { framedHeldValues } from './framed-held-members.ts';
import { framedArgumentPrefix, framedKeyNames } from './framed-keys.ts';
import { framedLiteralAccessor } from './framed-member-accessors.ts';
import { framedHeldVariable } from './framed-member-writes.ts';
import { nestedDescriptorValues, uniqueExpressions } from './multipart-held-paths.ts';
import { type BodyReading, enumerableBodiesOf } from './multipart-readings.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly } from './scope.ts';

/** Property-descriptor body extraction, enumerability proofs, and option literal key helpers. */

export type DescriptorFlagState = 'absent' | 'false' | 'other' | 'true';

export interface BodyDescriptorWrite {
  readonly configurableBody: boolean;
  readonly enumerableBody: boolean;
  readonly enumerableState: DescriptorFlagState;
  readonly exactBody: boolean;
  readonly mayHideBody: boolean;
  readonly preservesConfigurable?: boolean | undefined;
  readonly preservesWritable?: boolean | undefined;
  readonly values: readonly Expression[];
  readonly writableBody: boolean;
}

export interface RecordedDescriptorBodyWrite extends BodyDescriptorWrite {
  readonly node: CallExpression;
}

const BODY_KEY = 'body';
const DEFINE_PROPERTIES = 'Object.defineProperties';
const DEFINE_PROPERTY = 'Object.defineProperty';
const REFLECT_DEFINE_PROPERTY = 'Reflect.defineProperty';
const ACCESSOR_KEYS: ReadonlySet<string> = new Set(['get', 'set']);
const SLOTS = { defineProperty: 3 } as const;
const DESCRIPTOR_WRITES = new WeakMap<
  SourceFile,
  ReadonlyMap<VariableDeclaration, readonly RecordedDescriptorBodyWrite[]>
>();

const UNKNOWN_DESCRIPTOR_WRITE: BodyDescriptorWrite = {
  configurableBody: false,
  enumerableBody: false,
  enumerableState: 'other',
  exactBody: false,
  mayHideBody: true,
  preservesConfigurable: false,
  preservesWritable: false,
  values: [],
  writableBody: false,
};

/** Extracts `body` candidates and enumerability from `defineProperty(target, key, descriptor)`. */
export function singleDescriptorBodyWrite(
  key: Expression | undefined,
  descriptor: Expression | undefined,
  reflective: boolean,
): BodyDescriptorWrite | undefined {
  if (key === undefined) {
    return UNKNOWN_DESCRIPTOR_WRITE;
  }
  const names = framedKeyNames(key);
  if (names !== undefined && !names.includes(BODY_KEY)) {
    return undefined;
  }
  if (descriptor === undefined) {
    return UNKNOWN_DESCRIPTOR_WRITE;
  }
  const slot = descriptorSlotWrite(descriptor, reflective);
  if (names?.length === 1 && names[0] === BODY_KEY) {
    return slot;
  }
  return { ...UNKNOWN_DESCRIPTOR_WRITE, values: slot.values };
}

/** Extracts `body` candidates and enumerability from `defineProperties` or `Object.create` maps. */
export function mapDescriptorBodyWrite(
  descriptors: Expression | undefined,
): BodyDescriptorWrite | undefined {
  if (descriptors === undefined) {
    return UNKNOWN_DESCRIPTOR_WRITE;
  }
  const map = unwrapped(descriptors);
  if (isObjectLiteralExpression(map)) {
    return literalMapDescriptorWrite(map);
  }
  return {
    ...UNKNOWN_DESCRIPTOR_WRITE,
    values: nestedDescriptorValues(map, [BODY_KEY, 'value'], new Set()),
  };
}

/** Applies a descriptor write onto a target `BodyReading`, separating `[[Get]]` from enumerable copies. */
export function applyDescriptorWrite(
  base: BodyReading,
  write: BodyDescriptorWrite | undefined,
): BodyReading {
  if (write === undefined) {
    return base;
  }
  const ambiguous = !write.exactBody && Boolean(base.ambiguous);
  const bodies = uniqueExpressions(
    write.exactBody ? write.values : [...base.bodies, ...write.values],
  );
  const nonEnumerable =
    write.enumerableState === 'false' ||
    (write.enumerableState === 'absent' && base.noEnumerableBody === true);
  if (nonEnumerable) {
    return {
      ambiguous,
      bodies,
      enumerableBodies: [],
      noEnumerableBody: !ambiguous,
      overwrites: false,
    };
  }
  const priorEnumerable =
    write.enumerableState === 'absent' ? enumerableBodiesOf(base) : base.bodies;
  return {
    ambiguous,
    bodies,
    enumerableBodies: write.exactBody
      ? bodies
      : uniqueExpressions([...priorEnumerable, ...write.values]),
    overwrites: write.enumerableBody || (!write.mayHideBody && base.overwrites),
  };
}

/** Collects reachable `defineProperty` / `defineProperties` writes targeting a variable holder. */
export function holderDescriptorBodyWrites(
  holder: VariableDeclaration,
  reaches: (node: Node) => boolean,
): readonly RecordedDescriptorBodyWrite[] {
  const byHolder = moduleDescriptorBodyWrites(holder.getSourceFile());
  return (byHolder.get(holder) ?? []).filter((each) => reaches(each.node));
}

/** Indexes variable-targeted descriptor writes across `file` once per module. */
function moduleDescriptorBodyWrites(
  file: SourceFile,
): ReadonlyMap<VariableDeclaration, readonly RecordedDescriptorBodyWrite[]> {
  const cached = DESCRIPTOR_WRITES.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const byHolder = new Map<VariableDeclaration, RecordedDescriptorBodyWrite[]>();
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    if (isCallExpression(node)) {
      const entry = callDescriptorBodyWrite(node);
      if (entry !== undefined) {
        const list = byHolder.get(entry.holder) ?? [];
        list.push(entry.write);
        byHolder.set(entry.holder, list);
      }
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  DESCRIPTOR_WRITES.set(file, byHolder);
  return byHolder;
}

/** Whether a variable target of `Object.assign` may hold or acquire a non-enumerable `body`. */
export function variableMayHideBody(
  name: Identifier,
  binding: VariableDeclaration,
  reaches: (change: Node, holder: VariableDeclaration) => boolean,
): boolean {
  const whole = framedHeldValues(name, [], name);
  if (whole === undefined) {
    return true;
  }
  const entries = whole.initial === undefined ? whole.held : [whole.initial, ...whole.held];
  if (entries.length === 0 || entries.some((each) => !plainBodyLiteralEntry(each))) {
    return true;
  }
  const holder = framedHeldVariable(binding);
  return holderDescriptorBodyWrites(holder, (change) => reaches(change, holder)).some(
    (each) => each.mayHideBody,
  );
}

/** The value an ordinary option property writes, rather than what an accessor may compute. */
export function optionPropertyValue(property: ObjectLiteralElementLike): Expression | undefined {
  if (isPropertyAssignment(property)) {
    return property.initializer;
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? property.name
    : undefined;
}

/** What an option's property name writes, including a key computed from constants. */
export function optionPropertyKey(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return isComputedPropertyName(name) ? constantKey(name.expression, new Set()) : undefined;
}

/** Whether a literal defines an own non-accessor `'body'` property under a static or constant key. */
export function literalDefinesOwnBody(literal: ObjectLiteralExpression): boolean {
  return literal.properties.some((property) => {
    return (
      !isSpreadAssignment(property) &&
      optionPropertyValue(property) !== undefined &&
      optionPropertyKey(property.name) === BODY_KEY
    );
  });
}

/** Whether `state` neither sets `enumerable: true` nor leaves `enumerable` runtime-unknown. */
export function descriptorPreservesNonEnumerable(state: DescriptorFlagState | undefined): boolean {
  return state === 'false' || state === 'absent';
}

/** Whether a spread-free literal has only statically known non-`'body'` property names. */
export function literalHasNoOwnBody(literal: ObjectLiteralExpression): boolean {
  return literal.properties.every((property) => {
    if (isSpreadAssignment(property)) {
      return false;
    }
    const keys = descriptorPropertyKeys(property.name);
    return keys !== undefined && !keys.includes(BODY_KEY);
  });
}

/** Whether a held entry points directly to a plain object literal without a `body` accessor. */
export function plainBodyLiteralEntry(entry: {
  readonly keys: readonly string[];
  readonly value: Expression;
}): boolean {
  if (entry.keys.length > 0) {
    return false;
  }
  const target = unwrapped(entry.value);
  return isObjectLiteralExpression(target) && !framedLiteralAccessor(target, BODY_KEY);
}

/** Evaluates one descriptor expression positioned at an exact `'body'` key. */
function descriptorSlotWrite(descriptor: Expression, reflective: boolean): BodyDescriptorWrite {
  const values = descriptorValueCandidates(descriptor, new Set());
  const literal = unwrapped(descriptor);
  const closed =
    !reflective && isObjectLiteralExpression(literal) && !hasAccessorDescriptorKey(literal);
  const exactValue = closed ? exactDataDescriptorValue(literal) : undefined;
  const exactBody = exactValue !== undefined;
  const configurable = closed ? descriptorBooleanState(literal, 'configurable') : 'other';
  const enumerable = closed ? descriptorBooleanState(literal, 'enumerable') : 'other';
  const writable = closed ? descriptorBooleanState(literal, 'writable') : 'other';
  const enumerableBody = exactBody && enumerable === 'true';
  return {
    configurableBody: configurable === 'true',
    enumerableBody,
    enumerableState: enumerable,
    exactBody,
    mayHideBody: !enumerableBody,
    preservesConfigurable: configurable === 'true' || configurable === 'absent',
    preservesWritable: writable === 'true' || writable === 'absent',
    values: exactValue === undefined ? values : [exactValue],
    writableBody: writable === 'true',
  };
}

/** Walks a literal property-descriptor map (`{ body: { value, enumerable } }`) in property order. */
function literalMapDescriptorWrite(map: ObjectLiteralExpression): BodyDescriptorWrite | undefined {
  let state: BodyDescriptorWrite | undefined;
  for (const property of map.properties) {
    state = stepMapDescriptorProperty(property, state);
  }
  return state;
}

/** Updates accumulated `'body'` descriptor state across one `defineProperties` map element. */
function stepMapDescriptorProperty(
  property: ObjectLiteralElementLike,
  current: BodyDescriptorWrite | undefined,
): BodyDescriptorWrite | undefined {
  if (isSpreadAssignment(property)) {
    const spreadValues = nestedDescriptorValues(
      property.expression,
      [BODY_KEY, 'value'],
      new Set(),
    );
    return {
      ...UNKNOWN_DESCRIPTOR_WRITE,
      values: uniqueExpressions([...(current?.values ?? []), ...spreadValues]),
    };
  }
  const names = descriptorPropertyKeys(property.name);
  if (names !== undefined && !names.includes(BODY_KEY)) {
    return current;
  }
  const entry = optionPropertyValue(property);
  if (entry !== undefined && names?.length === 1 && names[0] === BODY_KEY) {
    const slot = descriptorSlotWrite(entry, false);
    return { ...slot, values: uniqueExpressions(slot.values) };
  }
  const extra = entry === undefined ? [] : descriptorValueCandidates(entry, new Set());
  return {
    ...UNKNOWN_DESCRIPTOR_WRITE,
    values: uniqueExpressions([...(current?.values ?? []), ...extra]),
  };
}

/** Extracts a descriptor write and its variable holder when `call` is `defineProperty` or `defineProperties`. */
function callDescriptorBodyWrite(
  call: CallExpression,
):
  | { readonly holder: VariableDeclaration; readonly write: RecordedDescriptorBodyWrite }
  | undefined {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  if (path === DEFINE_PROPERTY || path === REFLECT_DEFINE_PROPERTY) {
    const [target, key, descriptor] = framedArgumentPrefix(
      call,
      call.arguments,
      SLOTS.defineProperty,
    ).values;
    const holder = target === undefined ? undefined : variableHolderOf(target);
    if (holder === undefined) {
      return undefined;
    }
    const write = singleDescriptorBodyWrite(key, descriptor, path === REFLECT_DEFINE_PROPERTY);
    return write === undefined ? undefined : { holder, write: { ...write, node: call } };
  }
  if (path !== DEFINE_PROPERTIES) {
    return undefined;
  }
  const [target, descriptors] = framedArgumentPrefix(call, call.arguments).values;
  const holder = target === undefined ? undefined : variableHolderOf(target);
  if (holder === undefined) {
    return undefined;
  }
  const write = mapDescriptorBodyWrite(descriptors);
  return write === undefined ? undefined : { holder, write: { ...write, node: call } };
}

/** Resolves the underlying `VariableDeclaration` holder when `target` is a direct variable or `const` alias. */
function variableHolderOf(target: Expression): VariableDeclaration | undefined {
  const value = unwrapped(target);
  if (!isIdentifier(value)) {
    return undefined;
  }
  const selected = frameBindingOf(value);
  return selected?.keys.length === 0 && isVariableDeclaration(selected.binding)
    ? framedHeldVariable(selected.binding)
    : undefined;
}

/** Single data `value` expression of a closed descriptor literal with a definite `'value'` key. */
function exactDataDescriptorValue(literal: ObjectLiteralExpression): Expression | undefined {
  const choice = framedDescriptorChoices(literal, 'value');
  return choice !== undefined && !choice.absent && choice.values.length === 1
    ? choice.values[0]
    : undefined;
}

/** Classifies a descriptor boolean flag as `'true'`, `'false'`, `'absent'`, or `'other'`. */
function descriptorBooleanState(
  literal: ObjectLiteralExpression,
  field: string,
): DescriptorFlagState {
  const choice = framedDescriptorChoices(literal, field);
  if (choice === undefined) {
    return 'other';
  }
  if (!choice.absent && choice.values.length === 1) {
    const only = choice.values[0];
    const kind = only === undefined ? undefined : unwrapped(only).kind;
    if (kind === SyntaxKind.TrueKeyword) {
      return 'true';
    }
    return kind === SyntaxKind.FalseKeyword ? 'false' : 'other';
  }
  return choice.absent && choice.values.length === 0 ? 'absent' : 'other';
}

/** Rejects descriptor literals with spreads, non-data entries, unknown keys, or `get`/`set` fields. */
function hasAccessorDescriptorKey(literal: ObjectLiteralExpression): boolean {
  for (const property of literal.properties) {
    if (isSpreadAssignment(property) || optionPropertyValue(property) === undefined) {
      return true;
    }
    const keys = descriptorPropertyKeys(property.name);
    if (keys === undefined || keys.some((key) => ACCESSOR_KEYS.has(key))) {
      return true;
    }
  }
  return false;
}

/** Candidate `value` expressions carried by a literal, aliased, or branched descriptor. */
function descriptorValueCandidates(
  descriptor: Expression,
  seen: Set<Expression>,
): readonly Expression[] {
  const entries = framedDescriptorEntries(descriptor, ['value']);
  if (entries !== undefined) {
    return entries;
  }
  return nestedDescriptorValues(descriptor, ['value'], seen);
}

/** Written key names of an object literal element, or undefined when computed dynamically. */
function descriptorPropertyKeys(name: PropertyName): readonly string[] | undefined {
  if (isComputedPropertyName(name)) {
    return framedKeyNames(name.expression);
  }
  return isIdentifier(name) ||
    isStringLiteral(name) ||
    isNumericLiteral(name) ||
    isNoSubstitutionTemplateLiteral(name)
    ? [name.text]
    : undefined;
}

/** The text of a constant key, including additions of text through single-valued bindings. */
function constantKey(node: Expression, seen: ReadonlySet<Expression>): string | undefined {
  const constant = constantValue(node, singleIdentifierValue);
  if (constant !== undefined) {
    return String(constant);
  }
  const value = singleExpressionOf(node, seen);
  if (
    seen.has(value) ||
    !isBinaryExpression(value) ||
    value.operatorToken.kind !== SyntaxKind.PlusToken
  ) {
    return undefined;
  }
  const following = new Set([...seen, value]);
  const left = constantKey(value.left, following);
  const right = constantKey(value.right, following);
  return left === undefined || right === undefined ? undefined : left + right;
}

/** Follows single-valued identifier bindings without treating multi-branch writes as constants. */
function singleExpressionOf(node: Expression, seen: ReadonlySet<Expression>): Expression {
  let value = unwrapped(node);
  const local = new Set(seen);
  while (isIdentifier(value) && !local.has(value)) {
    const single = singleIdentifierValue(value);
    if (single === undefined) {
      break;
    }
    local.add(value);
    value = unwrapped(single);
  }
  return value;
}

/** The unique expression a variable holds at `name`, or undefined when multiple values reach it. */
function singleIdentifierValue(name: Identifier): Expression | undefined {
  const held = framedHeldValues(name, [], name);
  if (held === undefined) {
    return undefined;
  }
  const entries = held.initial === undefined ? held.held : [held.initial, ...held.held];
  const only = entries.length === 1 ? entries[0] : undefined;
  return only?.keys.length === 0 ? only.value : undefined;
}

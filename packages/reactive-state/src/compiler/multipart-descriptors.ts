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
import { framedObjectSources } from './framed-object-members.ts';
import { type BodyReading, selectedValues, uniqueExpressions } from './multipart-readings.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly } from './scope.ts';

/** Property-descriptor body extraction, enumerability proofs, and option literal key helpers. */

export interface BodyDescriptorWrite {
  readonly configurableBody: boolean;
  readonly enumerableBody: boolean;
  readonly exactBody: boolean;
  readonly mayHideBody: boolean;
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

/** Extracts `body` candidates and enumerability from `defineProperty(target, key, descriptor)`. */
export function singleDescriptorBodyWrite(
  key: Expression | undefined,
  descriptor: Expression | undefined,
  reflective: boolean,
): BodyDescriptorWrite | undefined {
  if (key === undefined) {
    return {
      configurableBody: false,
      enumerableBody: false,
      exactBody: false,
      mayHideBody: true,
      values: [],
      writableBody: false,
    };
  }
  const names = framedKeyNames(key);
  if (names !== undefined && !names.includes(BODY_KEY)) {
    return undefined;
  }
  if (descriptor === undefined) {
    return {
      configurableBody: false,
      enumerableBody: false,
      exactBody: false,
      mayHideBody: true,
      values: [],
      writableBody: false,
    };
  }
  const slot = descriptorSlotWrite(descriptor, reflective);
  if (names?.length === 1 && names[0] === BODY_KEY) {
    return slot;
  }
  return {
    configurableBody: false,
    enumerableBody: false,
    exactBody: false,
    mayHideBody: true,
    values: slot.values,
    writableBody: false,
  };
}

/** Extracts `body` candidates and enumerability from `defineProperties` or `Object.create` maps. */
export function mapDescriptorBodyWrite(
  descriptors: Expression | undefined,
): BodyDescriptorWrite | undefined {
  if (descriptors === undefined) {
    return {
      configurableBody: false,
      enumerableBody: false,
      exactBody: false,
      mayHideBody: true,
      values: [],
      writableBody: false,
    };
  }
  const map = unwrapped(descriptors);
  if (isObjectLiteralExpression(map)) {
    return literalMapDescriptorWrite(map);
  }
  return {
    configurableBody: false,
    enumerableBody: false,
    exactBody: false,
    mayHideBody: true,
    values: nestedDescriptorValues(map, [BODY_KEY, 'value'], new Set()),
    writableBody: false,
  };
}

/** Applies a descriptor write onto a target `BodyReading`, preserving enumerability requirements. */
export function applyDescriptorWrite(
  base: BodyReading,
  write: BodyDescriptorWrite | undefined,
): BodyReading {
  if (write === undefined) {
    return base;
  }
  return {
    ambiguous: !write.exactBody && Boolean(base.ambiguous),
    bodies: uniqueExpressions(write.exactBody ? write.values : [...base.bodies, ...write.values]),
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
  const exactValue = exactDataDescriptorValue(descriptor);
  const exactBody = !reflective && exactValue !== undefined;
  const configurableBody = exactBody && descriptorBooleanTrue(descriptor, 'configurable');
  const enumerableBody = exactBody && descriptorBooleanTrue(descriptor, 'enumerable');
  const writableBody = exactBody && descriptorBooleanTrue(descriptor, 'writable');
  return {
    configurableBody,
    enumerableBody,
    exactBody,
    mayHideBody: !enumerableBody,
    values: exactValue === undefined ? values : [exactValue],
    writableBody,
  };
}

/** Walks a literal property-descriptor map (`{ body: { value, enumerable } }`) in property order. */
function literalMapDescriptorWrite(map: ObjectLiteralExpression): BodyDescriptorWrite | undefined {
  let affected = false;
  let configurableBody = false;
  let exactBody = false;
  let enumerableBody = false;
  let mayHideBody = false;
  let writableBody = false;
  let values: Expression[] = [];
  for (const property of map.properties) {
    if (isSpreadAssignment(property)) {
      affected = true;
      configurableBody = false;
      exactBody = false;
      enumerableBody = false;
      mayHideBody = true;
      writableBody = false;
      values.push(...nestedDescriptorValues(property.expression, [BODY_KEY, 'value'], new Set()));
      continue;
    }
    const names = descriptorPropertyKeys(property.name);
    if (names !== undefined && !names.includes(BODY_KEY)) {
      continue;
    }
    affected = true;
    const entry = optionPropertyValue(property);
    if (entry !== undefined && names?.length === 1 && names[0] === BODY_KEY) {
      const slot = descriptorSlotWrite(entry, false);
      values = [...slot.values];
      configurableBody = slot.configurableBody;
      exactBody = slot.exactBody;
      enumerableBody = slot.enumerableBody;
      mayHideBody = slot.mayHideBody;
      writableBody = slot.writableBody;
      continue;
    }
    configurableBody = false;
    exactBody = false;
    enumerableBody = false;
    mayHideBody = true;
    writableBody = false;
    if (entry !== undefined) {
      values.push(...descriptorValueCandidates(entry, new Set()));
    }
  }
  return affected
    ? {
        configurableBody,
        enumerableBody,
        exactBody,
        mayHideBody,
        values: uniqueExpressions(values),
        writableBody,
      }
    : undefined;
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
function exactDataDescriptorValue(descriptor: Expression): Expression | undefined {
  const literal = unwrapped(descriptor);
  if (!isObjectLiteralExpression(literal) || hasAccessorDescriptorKey(literal)) {
    return undefined;
  }
  const choice = framedDescriptorChoices(literal, 'value');
  return choice !== undefined && !choice.absent && choice.values.length === 1
    ? choice.values[0]
    : undefined;
}

/** Whether a closed descriptor literal proves a definitely present `field: true` entry. */
function descriptorBooleanTrue(descriptor: Expression, field: string): boolean {
  const choice = framedDescriptorChoices(descriptor, field);
  const only =
    choice !== undefined && !choice.absent && choice.values.length === 1
      ? choice.values[0]
      : undefined;
  return only !== undefined && unwrapped(only).kind === SyntaxKind.TrueKeyword;
}

/** Rejects descriptors that also write `get` or `set` (which throw `TypeError` with `value`). */
function hasAccessorDescriptorKey(literal: ObjectLiteralExpression): boolean {
  for (const property of literal.properties) {
    if (isSpreadAssignment(property)) {
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

const NESTED_DESCRIPTOR_PROJECTIONS = new WeakMap<SourceFile, Map<string, readonly Expression[]>>();

function descriptorProjectionCache(file: SourceFile): Map<string, readonly Expression[]> {
  let cache = NESTED_DESCRIPTOR_PROJECTIONS.get(file);
  if (cache === undefined) {
    cache = new Map();
    NESTED_DESCRIPTOR_PROJECTIONS.set(file, cache);
  }
  return cache;
}

/** Follows identifiers, branches, and literal member paths to extract nested descriptor values. */
function nestedDescriptorValues(
  node: Expression,
  keys: readonly string[],
  seen: ReadonlySet<Expression>,
): readonly Expression[] {
  return resolveNestedDescriptorValues(
    node,
    keys,
    seen,
    descriptorProjectionCache(node.getSourceFile()),
  ).values;
}

function resolveNestedDescriptorValues(
  node: Expression,
  keys: readonly string[],
  seen: ReadonlySet<Expression>,
  memo: Map<string, readonly Expression[]>,
): { readonly cycled: boolean; readonly values: readonly Expression[] } {
  const value = unwrapped(node);
  if (keys.length === 0) {
    return { cycled: false, values: [value] };
  }
  if (seen.has(value)) {
    return { cycled: true, values: [] };
  }
  const cacheKey = `${value.pos}:${value.end}:${keys.length}:${keys.join('\0')}`;
  const cached = memo.get(cacheKey);
  if (cached !== undefined) {
    return { cycled: false, values: cached };
  }
  const nextSeen = new Set([...seen, value]);
  const entries = nestedProjectionEntries(value, keys);
  let cycled = false;
  const collected: Expression[] = [];
  for (const entry of entries) {
    const sub = resolveNestedDescriptorValues(entry.value, entry.keys, nextSeen, memo);
    if (sub.cycled) cycled = true;
    collected.push(...sub.values);
  }
  const values = uniqueExpressions(collected);
  if (!cycled) {
    memo.set(cacheKey, values);
  }
  return { cycled, values };
}

function nestedProjectionEntries(
  value: Expression,
  keys: readonly string[],
): readonly { readonly keys: readonly string[]; readonly value: Expression }[] {
  const alternatives = selectedValues(value);
  if (alternatives !== undefined) {
    return alternatives.map((each) => ({ keys, value: each }));
  }
  if (isIdentifier(value)) {
    const held = framedHeldValues(value, keys, value);
    if (held === undefined) return [];
    return held.initial === undefined ? held.held : [held.initial, ...held.held];
  }
  const sources = framedObjectSources(value, keys);
  if (sources === undefined) return [];
  return sources.filter((each) => each.value !== value || each.keys.length !== keys.length);
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

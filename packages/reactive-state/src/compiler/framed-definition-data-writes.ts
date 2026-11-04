import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedDescriptorChoices, framedDescriptorEntries } from './framed-descriptor-entries.ts';
import { framedKeyNames } from './framed-keys.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';

/** Closed own-data writes preserve known data without pretending that a target replacement succeeded. */

interface Definition {
  readonly call: CallExpression;
  readonly keys: readonly string[];
}

interface DataSlot {
  readonly value: Expression;
  readonly fixed: boolean;
}

/** Primitive field writes, disjoint own data and failed readonly writes cannot install an Error receiver. */
export function framedDefinitionDataWrite(
  name: Identifier,
  projection: { readonly keys: readonly string[] },
  definition: Definition,
): boolean {
  const write = ownAssignment(name);
  if (write === undefined || !quietRight(write.right)) return false;
  const count = definition.keys.length - projection.keys.length;
  if (count < 0) return false;
  const keys = [...definition.keys.slice(0, count), ...write.keys];
  const slot = definedSlot(definition.call, keys);
  return (
    slot !== undefined &&
    (slot.fixed || disjoint(keys, definition.keys) || framedQuietPrimitive(write.right))
  );
}

/** A direct assignment traverses only literal own data slots, never optional or coercing keys. */
function ownAssignment(
  name: Identifier,
): { readonly keys: readonly string[]; readonly right: Expression } | undefined {
  const keys: string[] = [];
  let value: Expression = name;
  let use = useOf(value);
  while (
    (isPropertyAccessExpression(use.parent) || isElementAccessExpression(use.parent)) &&
    use.parent.expression === use.at
  ) {
    const member = use.parent;
    if (
      member.questionDotToken !== undefined ||
      (isElementAccessExpression(member) && !framedQuietPrimitive(member.argumentExpression))
    )
      return undefined;
    const key = frameMemberName(member);
    if (key === undefined) return undefined;
    keys.push(key);
    value = member;
    use = useOf(value);
  }
  const parent = use.parent;
  return keys.length > 0 &&
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === use.at
    ? { keys, right: parent.right }
    : undefined;
}

/** Local binding and literal primitive reads do not invoke an RHS getter or application callback. */
function quietRight(expression: Expression): boolean {
  const value = unwrapped(expression);
  return (
    framedQuietPrimitive(value) || (isIdentifier(value) && frameBindingOf(value)?.keys.length === 0)
  );
}

/** Only the definition's exact installed slot and nested literal own data establish a closed write. */
function definedSlot(call: CallExpression, keys: readonly string[]): DataSlot | undefined {
  const first = keys[0];
  if (first === undefined) return undefined;
  let slot = installedSlot(call, first);
  for (const key of keys.slice(1)) {
    if (slot === undefined) return undefined;
    slot = literalSlot(slot.value, key);
  }
  return slot;
}

/** A definite native descriptor overrides the target; unrelated definitions retain its own literal slot. */
function installedSlot(call: CallExpression, key: string): DataSlot | undefined {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  const [target, named, descriptor] = call.arguments;
  if (target === undefined || named === undefined) return undefined;
  if (path === 'Object.defineProperty') return singularSlot(target, named, descriptor, key);
  return path === 'Object.defineProperties' ? pluralSlot(target, named, key) : undefined;
}

/** An exact singular key installs one data descriptor; an unrelated key retains the own target field. */
function singularSlot(
  target: Expression,
  named: Expression,
  descriptor: Expression | undefined,
  key: string,
): DataSlot | undefined {
  const names = framedKeyNames(named);
  if (names?.length !== 1) return undefined;
  if (names[0] !== key) return literalSlot(target, key);
  return descriptor === undefined ? undefined : descriptorSlot(descriptor);
}

/** A definite plural entry has one installed data value, without guessing possible computed keys. */
function pluralSlot(target: Expression, named: Expression, key: string): DataSlot | undefined {
  const selected = framedDescriptorChoices(named, key);
  if (selected === undefined) return undefined;
  if (selected.values.length === 0) return literalSlot(target, key);
  if (selected.absent || selected.values.length !== 1) return undefined;
  const descriptor = selected.values[0];
  return descriptor === undefined ? undefined : descriptorSlot(descriptor);
}

/** A definite literal value and explicit readonly flag preserve their native descriptor meaning. */
function descriptorSlot(descriptor: Expression): DataSlot | undefined {
  const values = framedDescriptorChoices(descriptor, 'value');
  if (values === undefined || values.absent || values.values.length !== 1) return undefined;
  const value = values.values[0];
  const writable = framedDescriptorEntries(descriptor, ['writable']);
  return value === undefined
    ? undefined
    : {
        value,
        fixed:
          writable?.length === 1 &&
          writable[0] !== undefined &&
          framedQuietSource(writable[0])?.kind === SyntaxKind.FalseKeyword,
      };
}

/** Source-known own data cannot invoke a setter, including when another key has an accessor. */
function literalSlot(expression: Expression, key: string): DataSlot | undefined {
  const value = unwrapped(expression);
  if (key === '__proto__' || !isObjectLiteralExpression(value)) return undefined;
  const selected = framedDescriptorChoices(value, key);
  if (selected === undefined || selected.absent || selected.values.length !== 1) return undefined;
  const entry = selected.values[0];
  return entry === undefined ? undefined : { value: entry, fixed: false };
}

/** Changing a separate own data path cannot replace the selected receiver or an enclosing container. */
function disjoint(written: readonly string[], selected: readonly string[]): boolean {
  return written.some((key, index) => index < selected.length && key !== selected[index]);
}

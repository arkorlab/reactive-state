import {
  type Expression,
  type Identifier,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type ObjectLiteralExpression,
  type PropertyName,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import {
  framedAccessorName,
  framedAccessorFieldValue,
  framedAccessorQuietValue,
  type AccessorDescriptor,
} from './framed-accessor-descriptors.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';

type AccessorSlot =
  | {
      readonly kind: 'data';
      readonly value: Expression | undefined;
      readonly writable: boolean;
      readonly configurable: boolean;
    }
  | {
      readonly kind: 'accessor';
      readonly getter: Expression | undefined;
      readonly setter: boolean;
      readonly configurable: boolean;
    };

/** Each tracked fresh target has one selected own descriptor and an optional written prototype. */
export interface AccessorTarget {
  readonly declaration: VariableDeclaration;
  readonly literal: ObjectLiteralExpression;
  readonly prototype: AccessorTarget | undefined;
  slot: AccessorSlot | undefined;
  accessorDefined: boolean;
}

interface AccessorContext {
  readonly key: string;
  readonly consumer: Expression;
  readonly targets: Map<VariableDeclaration, AccessorTarget>;
}

/** Whole immutable aliases retain original lexical binding and construction positions. */
export function framedAccessorTarget(
  node: Expression,
  context: AccessorContext,
  seen = new Set<VariableDeclaration>(),
): AccessorTarget | undefined {
  let source = unwrapped(node);
  while (isIdentifier(source)) {
    const declaration = constantDeclaration(source, context.consumer);
    if (declaration === undefined || seen.has(declaration)) return undefined;
    const known = context.targets.get(declaration);
    if (known !== undefined) return known;
    seen.add(declaration);
    const initializer = declaration.initializer;
    if (initializer === undefined) return undefined;
    source = unwrapped(initializer);
    if (isObjectLiteralExpression(source)) return literalTarget(declaration, source, context, seen);
  }
  return undefined;
}

/** A written prototype is resolved separately; a whole alias does not create another object. */
function literalTarget(
  declaration: VariableDeclaration,
  literal: ObjectLiteralExpression,
  context: AccessorContext,
  seen: Set<VariableDeclaration>,
): AccessorTarget | undefined {
  const initial = literalSlot(literal, context.key);
  if (initial === undefined) return undefined;
  const prototype =
    initial.prototype === undefined
      ? undefined
      : framedAccessorTarget(initial.prototype, context, seen);
  if (prototype === undefined && initial.prototype !== undefined) return undefined;
  const target = {
    declaration,
    literal,
    prototype,
    slot: initial.slot,
    accessorDefined: false,
  };
  context.targets.set(declaration, target);
  return target;
}

/** An absent own slot reads the current written prototype, without inventing a data value. */
export function framedAccessorSlot(target: AccessorTarget): AccessorSlot | undefined {
  return (
    target.slot ??
    (target.prototype === undefined ? undefined : framedAccessorSlot(target.prototype))
  );
}

/** A selected descriptor update preserves omitted attributes and distinguishes data from accessors. */
export function framedAccessorDefine(
  target: AccessorTarget,
  descriptor: AccessorDescriptor,
): boolean {
  const old = target.slot;
  if (old !== undefined && !old.configurable) return false;
  const kind = descriptor.kind === 'generic' ? (old?.kind ?? 'data') : descriptor.kind;
  if (kind === 'accessor') {
    target.slot = accessorSlot(descriptor, old);
    target.accessorDefined = true;
  } else {
    target.slot = dataSlot(descriptor, old);
  }
  return true;
}

/** Accessor updates preserve only the old accessor attributes, never a former data value. */
function accessorSlot(descriptor: AccessorDescriptor, old: AccessorSlot | undefined): AccessorSlot {
  const prior = old?.kind === 'accessor' ? old : undefined;
  return {
    kind: 'accessor',
    getter: descriptor.hasGet ? descriptor.getter : prior?.getter,
    setter: descriptor.hasSet ? descriptor.setter : (prior?.setter ?? false),
    configurable: descriptor.configurable ?? old?.configurable ?? false,
  };
}

/** Data conversion clears an earlier getter/setter pair and applies native writable defaults. */
function dataSlot(descriptor: AccessorDescriptor, old: AccessorSlot | undefined): AccessorSlot {
  const prior = old?.kind === 'data' ? old : undefined;
  return {
    kind: 'data',
    value: descriptor.hasValue ? descriptor.value : prior?.value,
    writable: descriptor.writable ?? prior?.writable ?? false,
    configurable: descriptor.configurable ?? old?.configurable ?? false,
  };
}

/** Empty setters consume assignments; ordinary writable data creates or replaces an own slot. */
export function framedAccessorAssign(target: AccessorTarget, value: Expression): boolean {
  const old = framedAccessorSlot(target);
  if (old?.kind === 'accessor') return old.setter;
  if (old !== undefined && !old.writable) return false;
  target.slot = {
    kind: 'data',
    value,
    writable: true,
    configurable: target.slot?.configurable ?? true,
  };
  return true;
}

/** Only same-owner complete whole const declarations retain an unexposed fresh target identity. */
function constantDeclaration(
  name: Identifier,
  consumer: Expression,
): VariableDeclaration | undefined {
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  return binding !== undefined &&
    selected?.keys.length === 0 &&
    isVariableDeclaration(binding) &&
    isIdentifier(binding.name) &&
    isVariableDeclarationList(binding.parent) &&
    /^const\s/u.test(binding.parent.getText(binding.getSourceFile())) &&
    binding.end < name.pos &&
    framedPrefixSameOwner(binding, consumer)
    ? binding
    : undefined;
}

/** Initial targets have plain own data and at most one source-known literal prototype. */
function literalSlot(
  literal: ObjectLiteralExpression,
  key: string,
):
  | {
      readonly slot: AccessorSlot | undefined;
      readonly prototype: Expression | undefined;
    }
  | undefined {
  let slot: AccessorSlot | undefined;
  let prototype: Expression | undefined;
  for (const field of literal.properties) {
    if (isSpreadAssignment(field)) return undefined;
    const name = framedAccessorName(field.name);
    const value = framedAccessorFieldValue(field);
    if (value === undefined) return undefined;
    if (name === undefined || !framedAccessorQuietValue(value)) return undefined;
    if (isPropertyAssignment(field) && literalPrototypeName(field.name)) {
      if (prototype !== undefined) return undefined;
      prototype = value;
    } else if (name === key) slot = { kind: 'data', value, writable: true, configurable: true };
  }
  return { slot, prototype };
}

/** Computed and shorthand __proto__ fields are own data, never a literal prototype setter. */
function literalPrototypeName(name: PropertyName): boolean {
  return (isIdentifier(name) || isStringLiteral(name)) && name.text === '__proto__';
}

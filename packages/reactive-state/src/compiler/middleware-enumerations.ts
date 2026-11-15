import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { targetsOf } from './kept.ts';
import {
  middlewareArrayCopiedOrigins,
  middlewareArraySlice,
  middlewareCopyAt,
} from './middleware-array-elements.ts';
import { middlewareArrayIteratorOrigin } from './middleware-array-iterators.ts';
import { isTypeOnly } from './scope.ts';
import { writtenBy } from './written.ts';

/** Native value enumeration copies wrappers while retaining explicitly selected own data payloads. */

const OBJECTS: ReadonlySet<string> = new Set(['Object']);
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['global', 'globalThis', 'self', 'window']);

interface AliasCapture {
  readonly reference: Identifier;
  readonly aliases: ReadonlySet<FrameBinding>;
  readonly keys: readonly string[];
}

interface Entry {
  readonly name: string;
  readonly value: Expression;
}

interface Projection {
  readonly slot?: string;
  readonly of: Expression;
  readonly keys: readonly string[];
  readonly tail: readonly string[];
}

interface CopyReading {
  readonly value: CallExpression;
  readonly keys: readonly string[];
  readonly captures: readonly AliasCapture[];
  readonly relative: boolean;
}

/** A fixed native values slot or entries payload retains its source collection, never its wrapper. */
export function middlewareEnumeration(
  expression: Expression,
):
  | { readonly of: Expression; readonly keys: readonly string[]; readonly quiet: boolean }
  | undefined {
  const reading = copiedReading(expression);
  if (reading === undefined) return undefined;
  const { value, keys, captures, relative } = reading;
  const projected = relative
    ? middlewareArraySlice(value, keys, true)
    : (enumerationProjection(value, keys) ?? middlewareArraySlice(value, keys));
  return projected === undefined || !projectionUnchanged(captures, projected, relative)
    ? undefined
    : { of: projected.of, keys: projected.keys, quiet: false };
}

/** Every retained native-copy origin passes the same original wrapper capture and write boundary. */
export function middlewareCopiedCollections(
  expression: Expression,
): readonly (
  | ReturnType<typeof middlewareArrayCopiedOrigins>[number]
  | NonNullable<ReturnType<typeof middlewareArrayIteratorOrigin>>
)[] {
  const reading = copiedReading(expression);
  if (reading === undefined) return [];
  const { value, keys, captures, relative } = reading;
  const iterator = relative ? undefined : middlewareArrayIteratorOrigin(value, keys);
  const origins = [
    ...middlewareArrayCopiedOrigins(value, keys, relative),
    ...(iterator === undefined ? [] : [iterator]),
  ];
  return origins.filter((projected) => projectionUnchanged(captures, projected, relative));
}

/** Copy aliases and native at reads keep their original positions before either projection is selected. */
function copiedReading(expression: Expression): CopyReading | undefined {
  const keys: string[] = [];
  const captures: AliasCapture[] = [];
  const seen = new Set<Node>();
  let value = unwrapped(expression);
  let relative = false;
  for (;;) {
    const source = copiedSource(value, keys, captures, seen);
    if (source !== undefined) {
      value = source;
      continue;
    }
    if (!isCallExpression(value)) return undefined;
    const selected = relative ? undefined : middlewareCopyAt(value);
    if (selected !== undefined) {
      keys.unshift(selected.key);
      value = unwrapped(selected.of);
      relative = true;
      continue;
    }
    return { value, keys, captures, relative };
  }
}

/** Written member and alias steps retain each original wrapper capture position. */
function copiedSource(
  value: Expression,
  keys: string[],
  captures: AliasCapture[],
  seen: Set<Node>,
): Expression | undefined {
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = quietMemberName(value);
    if (key === undefined) return undefined;
    keys.unshift(key);
    return unwrapped(value.expression);
  }
  if (isIdentifier(value)) {
    const source = constantAliasSource(value, seen);
    if (source === undefined) return undefined;
    captures.push({ reference: value, aliases: source.aliases, keys: [...keys] });
    return source.value;
  }
  return undefined;
}

/** Whole constant alias groups retain the original position of each member capture. */
function constantAliasSource(
  reference: Identifier,
  seen: Set<Node>,
): { readonly aliases: ReadonlySet<FrameBinding>; readonly value: Expression } | undefined {
  const aliases = new Set<FrameBinding>();
  let value: Expression = reference;
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      binding === undefined ||
      selected?.keys.length !== 0 ||
      seen.has(binding) ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    seen.add(binding);
    aliases.add(binding);
    value = unwrapped(binding.initializer);
  }
  return { aliases, value };
}

/** Only direct native calls with one finite own-data source establish a selected payload. */
function enumerationProjection(
  call: CallExpression,
  keys: readonly string[],
): Projection | undefined {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  if (path !== 'Object.values' && path !== 'Object.entries') return undefined;
  if (call.arguments.length !== 1 || nativeMethodChanged(call, path)) return undefined;
  const argument = call.arguments[0];
  if (argument === undefined || isSpreadElement(argument)) return undefined;
  const source = literalSource(argument);
  const entries = literalEntries(source);
  if (source === undefined || entries === undefined || !quietValues([source])) return undefined;
  const index = keys[0];
  if (index === undefined || String(Number(index)) !== index) return undefined;
  const selected = entries[Number(index)];
  if (selected === undefined) return undefined;
  const consumed = path === 'Object.entries' ? 2 : 1;
  if (consumed === 2 && keys[1] !== '1') return undefined;
  const tail = keys.slice(consumed);
  return { of: argument, keys: [selected.name, ...tail], tail };
}

/** Source-written writes to the constructor or selected method preserve the prior native boundary. */
function nativeMethodChanged(call: CallExpression, path: string): boolean {
  const pending: Node[] = [call.getSourceFile()];
  const method = path === 'Object.values' ? 'values' : 'entries';
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const write = writtenBy(node);
    if (
      write !== undefined &&
      targetsOf(write).some((target) => nativeEnumerationTarget(target, method)) &&
      possiblePriorWrite(node, call)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Completed same-owner writes and possible captured writes can precede a native method read. */
function possiblePriorWrite(operation: Node, call: CallExpression): boolean {
  if (!framedPossibleBranch(operation)) return false;
  const reader = executionOwner(call);
  const writer = executionOwner(operation);
  if (writer !== reader) return !unreferencedLocalFunction(writer, reader);
  if (operation.end <= call.pos && !destructuredFirst(call, operation)) return true;
  return repeatedFrameRead(operation, call, call.getSourceFile(), reader);
}

/** Direct global writes and whole native Object aliases can replace its own static method. */
function nativeEnumerationTarget(target: Node, method: string): boolean {
  if (!isExpression(target)) return false;
  const value = unwrapped(target);
  const path = globalPathOf(value)?.join('.');
  if (path === 'Object' || path === `Object.${method}` || GLOBAL_OBJECTS.has(path ?? ''))
    return true;
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    return (
      (key === undefined || key === method) && framedNativeConstructor(value.expression, OBJECTS)
    );
  }
  return framedNativeConstructor(value, OBJECTS);
}

/** Original literal data and quiet own members resolve without treating a getter or call as data. */
function literalSource(expression: Expression): Expression | undefined {
  const seen = new Set<Expression>();
  const keys: string[] = [];
  let value: Expression | undefined = expression;
  while (value !== undefined && !seen.has(value)) {
    seen.add(value);
    value = framedQuietSource(value);
    if (value === undefined) return undefined;
    if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
      const key = quietMemberName(value);
      if (key === undefined) return undefined;
      keys.unshift(key);
      value = value.expression;
      continue;
    }
    const key = keys.shift();
    if (key === undefined) return value;
    value = literalEntries(value)?.find((entry) => entry.name === key)?.value;
  }
  return undefined;
}

/** Identifier-named data fields and dense array slots have an exact native enumeration order. */
function literalEntries(expression: Expression | undefined): readonly Entry[] | undefined {
  if (expression === undefined) return undefined;
  if (isArrayLiteralExpression(expression)) {
    if (expression.elements.some((entry) => isOmittedExpression(entry) || isSpreadElement(entry)))
      return undefined;
    return expression.elements.map((value, index) => ({ name: String(index), value }));
  }
  if (!isObjectLiteralExpression(expression)) return undefined;
  const entries = new Map<string, Expression>();
  for (const field of expression.properties) {
    if (
      (!isPropertyAssignment(field) && !isShorthandPropertyAssignment(field)) ||
      !isIdentifier(field.name)
    )
      return undefined;
    if (isPropertyAssignment(field) && field.name.text === '__proto__') continue;
    entries.set(field.name.text, isPropertyAssignment(field) ? field.initializer : field.name);
  }
  return [...entries].map(([name, value]) => ({ name, value }));
}

/** Constructing the finite data source cannot run an ignored initializer that changes the payload. */
function quietValues(expressions: readonly Expression[]): boolean {
  const pending = [...expressions];
  const seen = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = literalSource(next);
    if (value === undefined) return false;
    if (seen.has(value)) continue;
    seen.add(value);
    if (framedQuietPrimitive(value)) continue;
    const operands = constructionValues(value);
    if (operands === undefined) return false;
    pending.push(...operands);
  }
  return true;
}

/** All literal operands evaluate, including prototype setter values and overwritten data entries. */
function constructionValues(expression: Expression): readonly Expression[] | undefined {
  if (!isObjectLiteralExpression(expression))
    return literalEntries(expression)?.map((entry) => entry.value);
  const values: Expression[] = [];
  for (const field of expression.properties) {
    if (isPropertyAssignment(field)) values.push(field.initializer);
    else if (isShorthandPropertyAssignment(field) && isIdentifier(field.name))
      values.push(field.name);
    else return undefined;
  }
  return values;
}

/** Fixed computed slots add no application work while the selected wrapper index is read. */
function quietMemberName(expression: Expression): string | undefined {
  if (isElementAccessExpression(expression) && !framedQuietPrimitive(expression.argumentExpression))
    return undefined;
  return frameMemberName(expression);
}

/** Unresolved negative selection retains a possible payload across opaque wrapper updates. */
function projectionUnchanged(
  captures: readonly AliasCapture[],
  projected: Projection,
  relative: boolean,
): boolean {
  return (
    (relative && projected.slot === undefined) ||
    unchangedWrappers(captures, projected.tail, projected.slot)
  );
}

/** A payload captured before a later wrapper replacement keeps its earlier original identity. */
function unchangedWrappers(
  captures: readonly AliasCapture[],
  tail: readonly string[],
  slot?: string,
): boolean {
  for (const capture of captures) {
    const wrapperKeys = capture.keys.length - tail.length;
    if (wrapperKeys <= 0) continue;
    const keys = capture.keys.slice(0, wrapperKeys);
    if (slot !== undefined) keys[0] = slot;
    if (
      argumentArrayExposed(capture.reference, capture.aliases, (reference) =>
        wrapperRead(reference, keys),
      )
    )
      return false;
  }
  return true;
}

/** Other fresh slots are independent; replacing the selected slot or array length loses its proof. */
function wrapperRead(reference: Identifier, keys: readonly string[]): boolean {
  let current: Expression = reference;
  for (const expected of keys) {
    const parent = useOf(current).parent;
    if (
      (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
      unwrapped(parent.expression) !== unwrapped(current)
    )
      return false;
    const key = quietMemberName(parent);
    if (key === undefined) return false;
    if (key !== expected) {
      if (isCallExpression(useOf(parent).parent)) return false;
      return key !== 'length' || !replacesValue(parent);
    }
    current = parent;
  }
  return !replacesValue(current);
}

/** A direct assignment, count or deletion changes a selected fresh wrapper value. */
function replacesValue(expression: Expression): boolean {
  const write = writtenBy(useOf(expression).parent);
  return (
    write !== undefined &&
    targetsOf(write).some((target) => unwrapped(target as Expression) === unwrapped(expression))
  );
}

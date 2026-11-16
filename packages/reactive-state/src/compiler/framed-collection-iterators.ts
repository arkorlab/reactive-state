import {
  type CallExpression,
  type Expression,
  type Node,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isNewExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSourceFile,
  isStatement,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { argumentArrayExposed, selectedError } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { finiteSetSelection } from './framed-finite-set-results.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { framedIteratorFromResult } from './framed-iterator-from.ts';
import {
  DEFAULT_ITERATOR,
  iteratorBoundaryQuiet,
  iteratorMemberName,
  iteratorPrefixQuiet,
  iteratorQuietValues,
} from './framed-iterator-guards.ts';
import { framedDefaultMapSlots } from './framed-iterator-map-slots.ts';
import { framedIteratorRestored } from './framed-iterator-restorations.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { setCarriedUnexposed } from './framed-set-carried.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { constantValue } from './numbers.ts';

/** Immediate native collection iterator results retain their first yielded source value. */

const SETS = new Set(['Set']);
const MAPS = new Set(['Map']);
const METHODS = new Set(['entries', 'keys', 'values']);

type ErrorValue = (value: Expression, made: boolean, keys: readonly string[]) => boolean;

interface IteratorRead {
  readonly made: boolean;
  readonly keys: readonly string[];
}

interface IteratorCapture extends IteratorRead {
  readonly capture: CallExpression;
  readonly consumer: Expression;
}

interface ConstantSource {
  readonly value: Expression;
  readonly bindings: ReadonlySet<FrameBinding>;
}

/** Only an immediate native next result contributes a value, never an iterator object itself. */
export function framedIteratorResult(
  node: Expression,
  read: IteratorRead,
  error: ErrorValue,
): boolean | undefined {
  const path = [...read.keys];
  let value = unwrapped(node);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return undefined;
    path.unshift(key);
    value = unwrapped(value.expression);
  }
  if (path.shift() !== 'value' || !isCallExpression(value)) return undefined;
  const member = unwrapped(value.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'next'
  )
    return undefined;
  const iterator = constantSource(member.expression);
  if (
    iterator === undefined ||
    (ownMethod(iterator.bindings, 'next', value) &&
      !framedIteratorRestored(iterator.value, iterator.bindings, value))
  )
    return undefined;
  return iteratorValue(
    iterator.value,
    { made: read.made, keys: path, capture: value, consumer: node },
    error,
  );
}

/** Lexical whole const aliases retain the original native iterator or collection expression. */
function constantSource(node: Expression): ConstantSource | undefined {
  let value = unwrapped(node);
  const bindings = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || bindings.has(selected.binding))
      return undefined;
    const binding = selected.binding;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    bindings.add(binding);
    value = unwrapped(binding.initializer);
  }
  return { value, bindings };
}

/** Source-known native values, keys and entry tuples retain only their selected yielded path. */
function iteratorValue(
  node: Expression,
  read: IteratorCapture,
  error: ErrorValue,
): boolean | undefined {
  if (!isCallExpression(node)) return undefined;
  return (
    framedIteratorFromResult(node, read, error, {
      source: constantSource,
      own: ownMethod,
      native: (call, selected) => nativeIteratorValue(call, read, selected),
    }) ?? nativeIteratorValue(node, read, error)
  );
}

/** Existing native acquisitions keep their prior selected collection proof. */
function nativeIteratorValue(
  node: Expression,
  read: IteratorCapture,
  error: ErrorValue,
): boolean | undefined {
  if (!isCallExpression(node)) return undefined;
  const member = unwrapped(node.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const method = iteratorMemberName(member);
  if (method === undefined || (method !== DEFAULT_ITERATOR && !METHODS.has(method)))
    return undefined;
  const source = constantSource(member.expression);
  if (source === undefined || ownMethod(source.bindings, method, node)) return undefined;
  const collection = source.value;
  if (isArrayLiteralExpression(collection))
    return arrayIteratorValue({ source, receiver: member.expression, method, node }, read, error);
  if (isCallExpression(collection))
    return addedSetValue({ receiver: member.expression, method, node }, read, error);
  if (!isNewExpression(collection)) return undefined;
  const entries = collection.arguments?.[0];
  if (entries === undefined) return undefined;
  const set = framedNativeConstructor(collection.expression, SETS);
  if (!set && !framedNativeConstructor(collection.expression, MAPS)) return undefined;
  if (method === DEFAULT_ITERATOR)
    return defaultIteratorValue({ source, node, entries, set }, read, error);
  if (set) return setValue(entries, method, read, error);
  const selected = mapValues(entries, method, read.keys);
  return selected?.values.some((each) => error(each, read.made, selected.keys)) === true
    ? true
    : undefined;
}

/** A quiet native add chain retains its Set receiver and first yielded insertion. */
function addedSetValue(
  at: { readonly receiver: Expression; readonly method: string; readonly node: CallExpression },
  read: IteratorCapture,
  error: ErrorValue,
): boolean | undefined {
  const keys = at.method === 'entries' ? entryPath(read.keys) : read.keys;
  if (
    keys === undefined ||
    !iteratorQuietValues(at.node.arguments) ||
    !iteratorQuietValues(read.capture.arguments) ||
    !iteratorPrefixQuiet(at.node, read.capture)
  )
    return undefined;
  const selected = finiteSetSelection(at.receiver, {
    capture: at.node,
    consumer: read.consumer,
    index: 0,
  });
  return selected !== undefined &&
    setCarriedUnexposed(
      selected.roots,
      selected.values.map((value) => ({ value })),
      read.capture,
    ) &&
    selected.values.some((value) => error(value, read.made, keys))
    ? true
    : undefined;
}

/** An unchanged finite literal array contributes its first yielded element, never its numeric key. */
interface ArrayIterator {
  readonly source: ConstantSource;
  readonly receiver: Expression;
  readonly method: string;
  readonly node: CallExpression;
}

function arrayIteratorValue(
  at: ArrayIterator,
  read: IteratorCapture,
  error: ErrorValue,
): boolean | undefined {
  const { source, receiver, method, node } = at;
  if (
    method === 'keys' ||
    !addedIteratorBoundary(source.value, read) ||
    argumentArrayExposed(receiver, source.bindings) ||
    !iteratorBoundaryQuiet({ source, acquisition: node, next: read.capture, method })
  )
    return undefined;
  const keys = method === 'entries' ? arrayEntryPath(read.keys) : read.keys;
  if (keys === undefined) return undefined;
  return selectedError(
    receiver,
    0,
    {
      error: (each, path = []) => {
        return (
          framedOriginCoowned(each, read.capture) &&
          iteratorCarriedUnexposed([source.value], [{ value: each }], read.capture) &&
          error(each, read.made, [...path, ...keys])
        );
      },
      typed: () => false,
    },
    read.capture,
  )
    ? true
    : undefined;
}

/** Only immediate member consumption adds an origin after quiet same-owner source creation. */
function addedIteratorBoundary(source: Expression, read: IteratorCapture): boolean {
  if (!framedOriginPrefix(source)) return false;
  const { at, parent } = useOf(read.consumer);
  if (isPropertyAccessExpression(parent) && parent.expression === at) return true;
  return (
    isElementAccessExpression(parent) &&
    parent.expression === at &&
    framedMapKey(parent.argumentExpression) !== undefined
  );
}

/** Array entries expose their value only in slot one; their key slot is an ordinary index. */
function arrayEntryPath(keys: readonly string[]): readonly string[] | undefined {
  return keys[0] === '1' ? keys.slice(1) : undefined;
}

interface DefaultIterator {
  readonly source: ConstantSource;
  readonly node: CallExpression;
  readonly entries: Expression;
  readonly set: boolean;
}

/** Native Set defaults to values and native Map defaults to entries, retaining their selected path. */
function defaultIteratorValue(
  at: DefaultIterator,
  read: IteratorCapture,
  error: ErrorValue,
): boolean | undefined {
  const input = constantSource(at.entries);
  if (
    input === undefined ||
    !addedIteratorBoundary(at.source.value, read) ||
    !isArrayLiteralExpression(input.value) ||
    argumentArrayExposed(at.entries, input.bindings) ||
    !iteratorQuietValues([input.value]) ||
    !iteratorPrefixQuiet(input.value, at.source.value) ||
    !iteratorBoundaryQuiet({
      source: at.source,
      acquisition: at.node,
      next: read.capture,
      method: DEFAULT_ITERATOR,
      written: input.value,
    })
  )
    return undefined;
  const carried: ErrorValue = (value, made, keys) => {
    return (
      framedOriginCoowned(value, read.capture) &&
      iteratorCarriedUnexposed([input.value], [{ value }], read.capture) &&
      error(value, made, keys)
    );
  };
  if (at.set) return setValue(at.entries, 'values', read, carried);
  const selected = framedDefaultMapSlots(input.value, read.keys);
  return selected?.values.some((value) => carried(value, read.made, selected.keys)) === true
    ? true
    : undefined;
}

/** A Set yields its first element, or the same element in each entry tuple slot. */
function setValue(
  entries: Expression,
  method: string,
  read: IteratorRead,
  error: ErrorValue,
): boolean | undefined {
  const keys = method === 'entries' ? entryPath(read.keys) : read.keys;
  if (keys === undefined) return undefined;
  return selectedError(
    entries,
    0,
    {
      error: (each, path = []) => error(each, read.made, [...path, ...keys]),
      typed: () => false,
    },
    entries,
  )
    ? true
    : undefined;
}

/** Both slots of a Set entry contain the same value; an unselected tuple remains an array. */
function entryPath(keys: readonly string[]): readonly string[] | undefined {
  return keys[0] === '0' || keys[0] === '1' ? keys.slice(1) : undefined;
}

interface MapValues {
  readonly values: readonly Expression[];
  readonly keys: readonly string[];
}

/** Later writes of the first Map key replace its value without moving its iteration position. */
function mapValues(
  input: Expression,
  method: string,
  path: readonly string[],
): MapValues | undefined {
  const source = constantSource(input);
  if (
    source === undefined ||
    !isArrayLiteralExpression(source.value) ||
    argumentArrayExposed(input, source.bindings)
  )
    return undefined;
  const entries: (readonly Expression[])[] = [];
  for (const element of source.value.elements) {
    const pair = unwrapped(element);
    if (
      !isArrayLiteralExpression(pair) ||
      pair.elements.some((each) => isSpreadElement(each) || isOmittedExpression(each))
    )
      return undefined;
    entries.push(pair.elements);
  }
  const firstKey = entries[0]?.[0];
  if (firstKey === undefined) return undefined;
  const keySlot = method === 'keys' || (method === 'entries' && path[0] === '0');
  const keys = method === 'entries' ? entryPath(path) : path;
  if (keys === undefined) return undefined;
  if (keySlot) return { values: [firstKey], keys };
  return { values: firstMapValues(entries, firstKey), keys };
}

/** A known repeated key wins; a possibly equal key preserves both possible first-entry values. */
function firstMapValues(entries: readonly (readonly Expression[])[], firstKey: Expression) {
  const wanted = mapEntryKey(firstKey);
  let values: Expression[] = [];
  for (const pair of entries) {
    const [key, value] = pair;
    const known = mapEntryKey(key);
    if (key === firstKey || (wanted !== undefined && known === wanted))
      values = value === undefined ? [] : [value];
    else if (value !== undefined && (wanted === undefined || known === undefined))
      values.push(value);
  }
  return values;
}

/** A missing entry key is native undefined; prior computed constants keep their same key. */
function mapEntryKey(key: Expression | undefined): string | undefined {
  if (key === undefined) return 'undefined';
  const value = constantValue(unwrapped(key));
  if (value === undefined) return framedMapKey(key);
  return typeof value === 'string' ? `text:${value}` : `number:${value}`;
}

/** An immediately preceding source-written own callable replaces this one native method. */
function ownMethod(bindings: ReadonlySet<FrameBinding>, method: string, read: Node): boolean {
  if (bindings.size === 0) return false;
  let statement = read;
  while (!isSourceFile(statement.parent) && !isBlock(statement.parent))
    statement = statement.parent;
  const statements = statement.parent.statements;
  if (!isStatement(statement)) return false;
  const index = statements.indexOf(statement);
  const previous = statements[index - 1];
  if (previous === undefined || !isExpressionStatement(previous)) return false;
  const assignment = unwrapped(previous.expression);
  if (!isBinaryExpression(assignment) || assignment.operatorToken.kind !== SyntaxKind.EqualsToken)
    return false;
  const target = unwrapped(assignment.left);
  if (
    (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) ||
    iteratorMemberName(target) !== method
  )
    return false;
  const receiver = unwrapped(target.expression);
  if (!isIdentifier(receiver)) return false;
  const selected = frameBindingOf(receiver);
  return (
    selected?.keys.length === 0 &&
    bindings.has(selected.binding) &&
    sourceArrayFunction(assignment.right)
  );
}

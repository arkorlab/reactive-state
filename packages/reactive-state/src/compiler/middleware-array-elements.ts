import {
  type ArrayLiteralExpression,
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
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { memberPath } from './exported-values.ts';
import { framedAccessorQuietValue } from './framed-accessor-descriptors.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { unchangedNativeBind } from './framed-native-bind.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { targetsOf } from './kept.ts';
import {
  middlewareDefaultArrayMutation,
  quietDefinitionPrefix,
} from './middleware-array-conversions.ts';
import { middlewareCopyOrigins } from './middleware-array-copy-origins.ts';
import {
  middlewarePossibleSelectorCollection,
  middlewareReplacedReceiverSelector,
  middlewareStableSelectorCall,
} from './middleware-array-selector-guards.ts';
import {
  middlewareArraySplice,
  middlewareCopySlotIndex,
  middlewareSliceProjection,
} from './middleware-array-splices.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly } from './scope.ts';
import { writtenBy } from './written.ts';

/** Native array selection retains a literal element's identity across copied middleware parts. */

interface SelectionCall {
  readonly method: string;
  readonly receiver: Expression;
  readonly given: readonly Expression[] | undefined;
  readonly applied?: Expression | undefined;
  readonly borrowed: boolean;
}

interface SliceProjection {
  readonly of: Expression;
  readonly keys: readonly string[];
  readonly tail: readonly string[];
  readonly slot?: string;
}

interface SliceSource {
  readonly selected: SelectionCall;
  readonly source: ArrayLiteralExpression;
}

interface Selection {
  readonly of: Expression;
  readonly keys: readonly string[];
  readonly quiet: boolean;
}

const ARRAY_TARGETS: ReadonlySet<string> = new Set(['Array', 'Array.prototype']);
const DEFINERS = new Set(['Object.defineProperty', 'Reflect.defineProperty']);
const DEFINER_GLOBALS = new Set(['Array', 'Object', 'Reflect']);
const DEFINITION = { slots: 3 } as const;
const ARRAY_COPIES = new Set(['slice', 'toReversed', 'toSorted', 'toSpliced']);
const RETAINED_COPIES = new Set([
  'concat',
  'filter',
  'flat',
  'flatMap',
  'map',
  'toSpliced',
  'with',
]);
const ARRAY_SELECTORS: ReadonlySet<string> = new Set([
  'at',
  'find',
  'findLast',
  ...ARRAY_COPIES,
  ...RETAINED_COPIES,
]);
const NATIVE_ARRAY_SELECTORS: ReadonlySet<string> = new Set([
  'Array.prototype.at',
  'Array.prototype.concat',
  'Array.prototype.filter',
  'Array.prototype.find',
  'Array.prototype.findLast',
  'Array.prototype.flat',
  'Array.prototype.flatMap',
  'Array.prototype.map',
  'Array.prototype.slice',
  'Array.prototype.toReversed',
  'Array.prototype.toSorted',
  'Array.prototype.toSpliced',
  'Array.prototype.with',
]);

/** Fixed positions select one payload; opaque bounds keep the original literal container possible. */
export function middlewareArrayElement(expression: Expression): Selection | undefined {
  const keys: string[] = [];
  let call = unwrapped(expression);
  while (isPropertyAccessExpression(call) || isElementAccessExpression(call)) {
    const key = frameMemberName(call);
    if (key === undefined) return undefined;
    keys.unshift(key);
    call = unwrapped(call.expression);
  }
  if (!isCallExpression(call)) return undefined;
  const selected = nativeSelectionCall(call);
  return selected === undefined ||
    ARRAY_COPIES.has(selected.method) ||
    RETAINED_COPIES.has(selected.method) ||
    replacedSelection(call, selected)
    ? undefined
    : elementProjection(call, selected, keys);
}

/** Existing native copy views retain every possible original runtime payload beside fresh wrappers. */
export function middlewareArrayCopiedOrigins(
  call: CallExpression,
  keys: readonly string[],
  relative: boolean,
): ReturnType<typeof middlewareArraySplice> {
  const selected = nativeSelectionCall(call);
  if (
    selected === undefined ||
    !RETAINED_COPIES.has(selected.method) ||
    replacedSelection(call, selected)
  )
    return [];
  const source = literalSource(selected.receiver);
  if (
    source === undefined ||
    !isArrayLiteralExpression(source) ||
    source.elements.some((element) => isSpreadElement(element))
  )
    return [];
  return selected.method === 'toSpliced'
    ? middlewareArraySplice(
        { call, keys, ...selected, length: source.elements.length, relative },
        { start: sliceBound, count: nativeIndex },
      )
    : middlewareCopyOrigins(call, keys, selected, relative);
}

/** A selected shallow-copy payload retains its original collection, never the fresh wrapper. */
export function middlewareArraySlice(
  call: CallExpression,
  keys: readonly string[],
  relative = false,
): SliceProjection | undefined {
  const index = middlewareCopySlotIndex(keys[0], relative);
  if (index === undefined) return undefined;
  const original = sliceSource(call);
  if (original === undefined) return undefined;
  return middlewareSliceProjection(
    { call, keys, ...original.selected, source: original.source, index, relative },
    { start: sliceBound, count: nativeIndex },
  );
}

/** A quiet native at selects one copied slot without changing the wrapper before that read. */
export function middlewareCopyAt(
  call: CallExpression,
): { readonly of: Expression; readonly key: string } | undefined {
  const selected = nativeSelectionCall(call);
  if (selected?.method !== 'at' || replacedSelection(call, selected)) return undefined;
  const prefix =
    selected.given === undefined ? undefined : framedArgumentPrefix(call, selected.given, Infinity);
  if (
    prefix === undefined ||
    prefix.unknown ||
    prefix.alternatives !== undefined ||
    prefix.values.some((value) => !framedQuietPrimitive(value))
  )
    return undefined;
  const index = nativeIndex(prefix.values[0]);
  return index !== undefined && Number.isFinite(index)
    ? { of: selected.receiver, key: String(index) }
    : undefined;
}

/** An opaque default comparison may run an original payload's conversion hooks. */
export function middlewareArrayComparison(call: CallExpression): Expression | undefined {
  const selected = nativeSelectionCall(call);
  if (selected?.method !== 'toSorted' || replacedSelection(call, selected)) return undefined;
  const source = literalSource(selected.receiver);
  return middlewareDefaultArrayMutation(call, selected.receiver, selected.given, source)
    ? selected.receiver
    : undefined;
}

/** Only a native slice on an original finite literal supplies a copied payload projection. */
function sliceSource(call: CallExpression): SliceSource | undefined {
  const selected = nativeSelectionCall(call);
  if (
    selected === undefined ||
    !ARRAY_COPIES.has(selected.method) ||
    replacedSelection(call, selected)
  )
    return undefined;
  const source = literalSource(selected.receiver);
  if (
    source === undefined ||
    !isArrayLiteralExpression(source) ||
    source.elements.some((element) => isSpreadElement(element))
  )
    return undefined;
  return { selected, source };
}

/** Omission and native undefined keep their slot default; other primitives use native integer bounds. */
function sliceBound(
  expression: Expression | undefined,
  length: number,
  fallback: number,
): number | undefined {
  if (expression === undefined) return fallback;
  const seen = new Set<Expression>();
  let value = unwrapped(expression);
  while (isIdentifier(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (globalPathOf(value)?.join('.') === 'undefined') return fallback;
    const next = constantInitializer(value);
    if (next === undefined) break;
    value = unwrapped(next);
  }
  const index = nativeIndex(value);
  if (index === undefined) return undefined;
  const position = index < 0 ? length + index : index;
  return Math.min(Math.max(position, 0), length);
}

/** A native receiver retains one exact dense slot or a possible collection under opaque bounds. */
function elementProjection(
  call: CallExpression,
  selected: SelectionCall,
  keys: readonly string[],
): Selection | undefined {
  const source = literalSource(selected.receiver);
  if (source === undefined || !isArrayLiteralExpression(source)) return undefined;
  if (source.elements.some((element) => isSpreadElement(element))) return undefined;
  const stable = middlewareStableSelectorCall(call, selected.receiver, {
    memberOf: literalMember,
    replacedGlobal: replacedNativeSelection,
    selectors: ARRAY_SELECTORS,
    sourceOf: literalSource,
  });
  if (selected.method !== 'at')
    return !stable || middlewarePossibleSelectorCollection(source.elements, [])
      ? { of: selected.receiver, keys: [], quiet: false }
      : undefined;
  const args =
    selected.given === undefined ? undefined : framedArgumentPrefix(call, selected.given, 1);
  const index =
    args === undefined || args.unknown || args.alternatives !== undefined
      ? undefined
      : nativeIndex(args.values[0]);
  if (index !== undefined && !Number.isFinite(index)) return undefined;
  if (!stable) return { of: selected.receiver, keys: [], quiet: false };
  if (index === undefined)
    return middlewarePossibleSelectorCollection(source.elements, keys)
      ? { of: selected.receiver, keys: [], quiet: false }
      : undefined;
  const position = index < 0 ? source.elements.length + index : index;
  if (position < 0 || position >= source.elements.length) return undefined;
  return { of: selected.receiver, keys: [String(position), ...keys], quiet: false };
}

/** Explicit native borrowing bypasses receiver-owned methods; ordinary own methods stay opaque. */
function nativeSelectionCall(call: CallExpression): SelectionCall | undefined {
  const borrowed = borrowedTextCall(call);
  const method = borrowed?.path.at(-1);
  if (
    borrowed !== undefined &&
    method !== undefined &&
    NATIVE_ARRAY_SELECTORS.has(borrowed.path.join('.')) &&
    ARRAY_SELECTORS.has(method)
  ) {
    const reflected = globalPathOf(unwrapped(call.expression))?.join('.') === 'Reflect.apply';
    const applied = borrowed.applied === undefined ? undefined : unwrapped(borrowed.applied);
    if (
      reflected &&
      (applied === undefined ||
        applied.kind === SyntaxKind.NullKeyword ||
        globalPathOf(applied)?.join('.') === 'undefined')
    )
      return undefined;
    const given =
      borrowed.applied === undefined
        ? borrowed.given
        : framedAppliedArguments(call, borrowed.applied);
    return { method, receiver: borrowed.receiver, given, applied, borrowed: true };
  }
  const member = unwrapped(call.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    !ARRAY_SELECTORS.has(frameMemberName(member) ?? '')
  )
    return undefined;
  return {
    method: frameMemberName(member) ?? '',
    receiver: member.expression,
    given: call.arguments,
    borrowed: false,
  };
}

/** Native ToIntegerOrInfinity keeps omission, primitive constants and original constant aliases. */
function nativeIndex(expression: Expression | undefined): number | undefined {
  if (expression === undefined) return 0;
  const value = unwrapped(expression);
  if (
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    globalPathOf(value)?.join('.') === 'undefined'
  )
    return 0;
  if (value.kind === SyntaxKind.TrueKeyword) return 1;
  const known = constantValue(value, constantInitializer);
  return known === undefined ? undefined : Math.trunc(Number(known)) || 0;
}

/** Whole constant bindings retain their original values without assuming mutable reassignments. */
function constantInitializer(name: Identifier): Expression | undefined {
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  if (
    binding === undefined ||
    selected?.keys.length !== 0 ||
    !isVariableDeclaration(binding) ||
    !isVariableDeclarationList(binding.parent) ||
    !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
    binding.initializer === undefined
  )
    return undefined;
  return binding.initializer;
}

/** Original literals and constant own data members resolve; calls, getters and unresolved fields do not. */
function literalSource(expression: Expression): Expression | undefined {
  let value = unwrapped(expression);
  const keys: string[] = [];
  const seen = new Set<Expression>();
  for (;;) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const path = memberPath(value);
    keys.unshift(...path.keys);
    value = path.root;
    if (isIdentifier(value)) {
      const initializer = constantInitializer(value);
      if (initializer === undefined) return undefined;
      value = unwrapped(initializer);
      continue;
    }
    const key = keys.shift();
    if (key === undefined) return value;
    const selected = literalMember(value, key);
    if (selected === undefined) return undefined;
    value = unwrapped(selected);
  }
}

/** Dense array slots and identifier-named own data fields retain their written value. */
function literalMember(value: Expression, name: string): Expression | undefined {
  if (isObjectLiteralExpression(value)) return objectMember(value, name);
  if (!isArrayLiteralExpression(value) || value.elements.some((each) => isSpreadElement(each)))
    return undefined;
  const index = Number(name);
  const element = value.elements[index];
  return element !== undefined && String(index) === name && !isOmittedExpression(element)
    ? element
    : undefined;
}

/** Only surviving identifier-named data fields participate in the original literal shape. */
function objectMember(value: ObjectLiteralExpression, name: string): Expression | undefined {
  for (const field of value.properties.toReversed()) {
    if (
      (!isPropertyAssignment(field) && !isShorthandPropertyAssignment(field)) ||
      !isIdentifier(field.name)
    )
      return undefined;
    if (field.name.text === name)
      return isPropertyAssignment(field) ? field.initializer : field.name;
  }
  return undefined;
}

/** Checks global Array/prototype writes and, on non-borrowed calls, receiver-owned replacements. */
function replacedSelection(call: CallExpression, selected: SelectionCall): boolean {
  if (replacedNativeSelection(call, selected.method)) return true;
  return (
    !selected.borrowed &&
    middlewareReplacedReceiverSelector(call, selected.receiver, selected.method, literalSource)
  );
}

/** A source-written native Array or prototype replacement adds no selector identity proof. */
function replacedNativeSelection(call: CallExpression, method: string): boolean {
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const write = writtenBy(node);
    if (
      write !== undefined &&
      targetsOf(write).some((target) => nativeArrayTarget(target, method)) &&
      !definesOtherSelector(node, method)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** A quiet direct native definition of another selector leaves the selected native member alone. */
function definesOtherSelector(node: Node, method: string): boolean {
  if (!isCallExpression(node) || node.arguments.length !== DEFINITION.slots) return false;
  if (!DEFINERS.has(globalPathOf(unwrapped(node.expression))?.join('.') ?? '')) return false;
  const [target, property, descriptor] = node.arguments;
  if (target === undefined || property === undefined || descriptor === undefined) return false;
  const key = unwrapped(property);
  const data = unwrapped(descriptor);
  return (
    ARRAY_TARGETS.has(globalPathOf(unwrapped(target))?.join('.') ?? '') &&
    isStringLiteral(key) &&
    key.text !== method &&
    ARRAY_SELECTORS.has(key.text) &&
    isObjectLiteralExpression(data) &&
    framedAccessorQuietValue(data) &&
    unchangedNativeBind(node.expression, node, DEFINER_GLOBALS) &&
    quietDefinitionPrefix(node)
  );
}

/** Whole native Array and prototype aliases retain their identity through the selected links. */
function nativeArrayTarget(target: Node, method: string): boolean {
  if (!isExpression(target)) return false;
  let value = unwrapped(target);
  for (;;) {
    if (framedNativeConstructor(value, ARRAY_TARGETS)) return true;
    if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return false;
    const key = frameMemberName(value);
    if (key !== undefined && key !== method && key !== 'prototype') return false;
    value = unwrapped(value.expression);
  }
}

export { literalSource as middlewareArraySource };

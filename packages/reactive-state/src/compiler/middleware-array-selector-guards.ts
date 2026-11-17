import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isIdentifier,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { memberPath } from './exported-values.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { unchangedNativeBind } from './framed-native-bind.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { middlewareWrapperTail } from './middleware-array-copy-arguments.ts';
import {
  middlewareExpressionReplaced,
  middlewareReplacedReceiverSelector,
} from './middleware-array-selector-writes.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Receiver stability, opaque element retention, and own-method guards for array selectors. */

interface ReceiverTrace {
  readonly aliases: ReadonlySet<FrameBinding>;
  readonly directAliases: ReadonlySet<FrameBinding>;
  readonly chainNodes: ReadonlySet<Expression>;
}

interface ScalarStep {
  readonly scalar: boolean;
  readonly next?: Expression | undefined;
}

interface SelectorGuardContext {
  readonly selectors: ReadonlySet<string>;
  readonly replacedGlobal: (at: Node, method: string) => boolean;
  readonly sourceOf: (expression: Expression) => Expression | undefined;
  readonly memberOf: (value: Expression, name: string) => Expression | undefined;
}

const BORROWED_GLOBALS = new Set(['Array', 'Reflect']);
const BORROWED_PATH = { length: 3 } as const;
const INDEX = { limit: 4_294_967_295 } as const;
const OBJECT_PROTOTYPE_KEYS = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);
const PURE_ARRAY_READS = new Set([
  'at',
  'concat',
  'entries',
  'flat',
  'includes',
  'indexOf',
  'join',
  'keys',
  'lastIndexOf',
  'slice',
  'toReversed',
  'toSpliced',
  'values',
  'with',
]);

/** Canonical ECMA-262 array indices range below `2 ** 32 - 1` and format without extra characters. */
export function canonicalArrayIndex(key: string): number | undefined {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < INDEX.limit && String(index) === key
    ? index
    : undefined;
}

/** Unknown positions retain the receiver unless every candidate payload is proven scalar. */
export function middlewarePossibleSelectorCollection(
  elements: readonly Expression[],
  keys: readonly string[],
): boolean {
  return elements.some((element) => !provenScalarSelection(element, keys));
}

/** Initializer length and slots hold only when neither earlier uses nor call arguments mutate the array. */
export function middlewareStableSelectorCall(
  call: CallExpression,
  receiver: Expression,
  context: SelectorGuardContext,
): boolean {
  const trace = receiverLiteralTrace(receiver, context.memberOf);
  if (trace === undefined) return false;
  if (trace.aliases.size === 0) return true;
  const harmless = (name: Identifier): boolean => {
    return (
      trace.chainNodes.has(unwrapped(name)) ||
      harmlessSelectorArrayUse(name, trace.directAliases, context)
    );
  };
  if (argumentArrayExposed(memberPath(receiver).root, trace.aliases, harmless, true)) return false;
  return !callTouchesAliases(call, trace.aliases, harmless);
}

/** Checks whether a variable declaration belongs to a lexical `const` declaration list. */
function isConstDeclaration(binding: Node): boolean {
  return (
    isVariableDeclaration(binding) &&
    isVariableDeclarationList(binding.parent) &&
    /^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
  );
}

/** Whole constant bindings retain their original values without assuming mutable reassignments. */
function constantInitializer(name: Identifier): Expression | undefined {
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  if (
    binding === undefined ||
    selected?.keys.length !== 0 ||
    !isConstDeclaration(binding) ||
    binding.initializer === undefined
  )
    return undefined;
  return binding.initializer;
}

/** Proves that reading `keys` from `element` can only produce a primitive or undefined scalar. */
function provenScalarSelection(element: Expression, keys: readonly string[]): boolean {
  if (isOmittedExpression(element) || provenScalarExpression(element)) return true;
  if (keys.length === 0) return false;
  let current: Expression = element;
  for (const key of keys) {
    const stepped = stepScalarContainer(current, key);
    if (stepped.scalar) return true;
    if (stepped.next === undefined) return false;
    current = stepped.next;
  }
  return provenScalarExpression(current);
}

/** Steps one member lookup on an unexposed literal container while proving missing slots scalar. */
function stepScalarContainer(current: Expression, key: string): ScalarStep {
  if (provenScalarExpression(current)) return { scalar: true };
  const value = framedQuietSource(current);
  if (value === undefined) return { scalar: false };
  if (isArrayLiteralExpression(value)) return stepArrayScalarSlot(value, key);
  if (isObjectLiteralExpression(value)) return stepObjectScalarField(value, key);
  return { scalar: provenScalarExpression(value) };
}

/** Spread-free literal arrays yield scalar undefined on holes and out-of-range array indices. */
function stepArrayScalarSlot(
  value: Expression & { readonly elements: readonly Expression[] },
  key: string,
): ScalarStep {
  if (value.elements.some((each) => isSpreadElement(each))) return { scalar: false };
  const index = canonicalArrayIndex(key);
  if (index === undefined) return { scalar: false };
  const slot = value.elements[index];
  return slot === undefined || isOmittedExpression(slot)
    ? { scalar: true }
    : { scalar: false, next: slot };
}

/** Closed plain object literals without `__proto__` yield undefined for absent non-Object keys. */
function stepObjectScalarField(value: ObjectLiteralExpression, key: string): ScalarStep {
  let matched: Expression | undefined;
  for (const field of value.properties) {
    if (
      (!isPropertyAssignment(field) && !isShorthandPropertyAssignment(field)) ||
      !isIdentifier(field.name) ||
      field.name.text === '__proto__'
    )
      return { scalar: false };
    if (field.name.text === key)
      matched = isPropertyAssignment(field) ? field.initializer : field.name;
  }
  if (matched !== undefined) return { scalar: false, next: matched };
  return { scalar: !OBJECT_PROTOTYPE_KEYS.has(key) };
}

/** Expressions guaranteed by syntax and `const` bindings to evaluate to primitive scalar values. */
function provenScalarExpression(expression: Expression): boolean {
  const value = wholeConstValue(expression);
  if (value === undefined) return false;
  if (
    framedQuietPrimitive(value) ||
    value.kind === SyntaxKind.BigIntLiteral ||
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isTemplateExpression(value) ||
    isTypeOfExpression(value) ||
    isVoidExpression(value)
  )
    return true;
  return (
    isPrefixUnaryExpression(value) &&
    (value.operator === SyntaxKind.PlusToken ||
      value.operator === SyntaxKind.MinusToken ||
      value.operator === SyntaxKind.TildeToken ||
      value.operator === SyntaxKind.ExclamationToken)
  );
}

/** Resolves a chain of whole `const` bindings without rejecting repeated reads of scalar constants. */
function wholeConstValue(expression: Expression): Expression | undefined {
  let value = unwrapped(expression);
  const seen = new Set<Expression>();
  while (isIdentifier(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const initializer = constantInitializer(value);
    if (initializer === undefined) break;
    value = unwrapped(initializer);
  }
  return value;
}

/** Records every binding and syntax step along `receiver`'s constant literal resolution path. */
function receiverLiteralTrace(
  receiver: Expression,
  memberOf: (value: Expression, name: string) => Expression | undefined,
): ReceiverTrace | undefined {
  let value = unwrapped(receiver);
  const keys: string[] = [];
  const seen = new Set<Expression>();
  const aliases = new Set<FrameBinding>();
  const directAliases = new Set<FrameBinding>();
  const chainNodes = new Set<Expression>();
  for (;;) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    recordMemberNodes(value, chainNodes);
    const path = memberPath(value);
    keys.unshift(...path.keys);
    const next = isIdentifier(path.root)
      ? stepTraceIdentifier(path.root, keys.length === 0, aliases, directAliases)
      : stepTraceLiteral(path.root, keys, memberOf);
    if (next === undefined)
      return !isIdentifier(path.root) && keys.length === 0 && isArrayLiteralExpression(path.root)
        ? { aliases, directAliases, chainNodes }
        : undefined;
    value = unwrapped(next);
  }
}

/** Follows one constant identifier step along a receiver trace and records its lexical binding. */
function stepTraceIdentifier(
  name: Identifier,
  direct: boolean,
  aliases: Set<FrameBinding>,
  directAliases: Set<FrameBinding>,
): Expression | undefined {
  const selected = frameBindingOf(name);
  const initializer = constantInitializer(name);
  if (selected === undefined || initializer === undefined) return undefined;
  aliases.add(selected.binding);
  if (direct) directAliases.add(selected.binding);
  return initializer;
}

/** Consumes one pending member key from a non-identifier container expression along a trace. */
function stepTraceLiteral(
  value: Expression,
  keys: string[],
  memberOf: (target: Expression, name: string) => Expression | undefined,
): Expression | undefined {
  const key = keys.shift();
  return key === undefined ? undefined : memberOf(value, key);
}

/** Marks every unwrapped member expression along a static property chain as part of the receiver. */
function recordMemberNodes(expression: Expression, nodes: Set<Expression>): void {
  let current = unwrapped(expression);
  for (;;) {
    nodes.add(current);
    if (!isPropertyAccessExpression(current) && !isElementAccessExpression(current)) return;
    current = unwrapped(current.expression);
  }
}

/** Quiet element reads, unoverridden pure reads, and own selector writes preserve slots and length. */
function harmlessSelectorArrayUse(
  reference: Identifier,
  directAliases: ReadonlySet<FrameBinding>,
  context: SelectorGuardContext,
): boolean {
  const selected = frameBindingOf(reference);
  if (selected === undefined || !directAliases.has(selected.binding)) return false;
  if (harmlessBorrowedPureRead(reference, context)) return true;
  const parent = useOf(reference).parent;
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    unwrapped(parent.expression) !== unwrapped(reference)
  )
    return false;
  const key = quietMemberKey(parent);
  if (key === undefined) return false;
  const grand = useOf(parent).parent;
  if (isCallExpression(grand) && unwrapped(grand.expression) === unwrapped(parent))
    return harmlessDirectPureCall(grand, parent.expression, key, context);
  if (!middlewareExpressionReplaced(parent))
    return !context.selectors.has(key) || !context.replacedGlobal(parent, key);
  return (
    !isDeleteExpression(grand) && context.selectors.has(key) && !context.replacedGlobal(parent, key)
  );
}

/** Non-borrowed pure reads stay harmless only while neither Array.prototype nor `receiver` overrides `key`. */
function harmlessDirectPureCall(
  call: CallExpression,
  receiver: Expression,
  key: string,
  context: SelectorGuardContext,
): boolean {
  return (
    PURE_ARRAY_READS.has(key) &&
    !context.replacedGlobal(call, key) &&
    !middlewareReplacedReceiverSelector(call, receiver, key, context.sourceOf) &&
    call.arguments.every((argument) => framedQuietPrimitive(argument))
  );
}

/** Borrowed `Array.prototype` pure reads ignore receiver-owned overrides while arguments stay quiet. */
function harmlessBorrowedPureRead(reference: Identifier, context: SelectorGuardContext): boolean {
  const { at, parent } = useOf(reference);
  if (!isCallExpression(parent)) return false;
  const borrowed = borrowedTextCall(parent);
  const method = borrowed?.path[2];
  if (
    borrowed === undefined ||
    method === undefined ||
    borrowed.path.length !== BORROWED_PATH.length ||
    borrowed.path[0] !== 'Array' ||
    borrowed.path[1] !== 'prototype' ||
    borrowed.receiver !== at ||
    !PURE_ARRAY_READS.has(method)
  )
    return false;
  return (
    !context.replacedGlobal(parent, method) &&
    unchangedNativeBind(parent.expression, parent, BORROWED_GLOBALS) &&
    quietBorrowedPureArguments(parent, borrowed.given, borrowed.applied)
  );
}

/** Validates quiet primitive argument lists across borrowed `.call`, `.apply`, and `Reflect.apply`. */
function quietBorrowedPureArguments(
  call: CallExpression,
  given: readonly Expression[],
  applied: Expression | undefined,
): boolean {
  const reflected = globalPathOf(unwrapped(call.expression))?.join('.') === 'Reflect.apply';
  if (reflected && (applied === undefined || nullishArgumentList(applied))) return false;
  const values =
    applied === undefined || (!reflected && nullishArgumentList(applied))
      ? given
      : framedAppliedArguments(call, applied);
  if (values === undefined) return false;
  const prefix = framedArgumentPrefix(call, values, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return false;
  return [...prefix.values, ...middlewareWrapperTail(call)].every((value) =>
    framedQuietPrimitive(value),
  );
}

/** Checks whether an `.apply` list expression is literal `null` or global `undefined`. */
function nullishArgumentList(expression: Expression): boolean {
  const value = unwrapped(expression);
  return value.kind === SyntaxKind.NullKeyword || globalPathOf(value)?.join('.') === 'undefined';
}

/** Scans a call for any non-harmless alias reference evaluated in its callee or argument list. */
function callTouchesAliases(
  call: CallExpression,
  aliases: ReadonlySet<FrameBinding>,
  harmless: (name: Identifier) => boolean,
): boolean {
  const pending: Node[] = [call];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && readsAliasBinding(node, aliases) && !harmless(node)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Checks whether an identifier refers to one of the tracked lexical bindings rather than declaring it. */
function readsAliasBinding(name: Identifier, aliases: ReadonlySet<FrameBinding>): boolean {
  if (!readsBinding(name)) return false;
  const selected = frameBindingOf(name);
  return selected !== undefined && name !== selected.binding.name && aliases.has(selected.binding);
}

/** Fixed computed member keys evaluate no custom index coercions while reading the array. */
function quietMemberKey(expression: Expression): string | undefined {
  if (isElementAccessExpression(expression) && !framedQuietPrimitive(expression.argumentExpression))
    return undefined;
  return frameMemberName(expression);
}

export { middlewareReplacedReceiverSelector } from './middleware-array-selector-writes.ts';

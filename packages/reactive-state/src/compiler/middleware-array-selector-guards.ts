import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpression,
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
import { destructuredFirst } from './destructuring-order.ts';
import { memberPath } from './exported-values.ts';
import { framedAccessorQuietValue } from './framed-accessor-descriptors.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { unchangedNativeBind } from './framed-native-bind.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { declarationOf, initializerOf } from './framed.ts';
import { targetsOf } from './kept.ts';
import { quietDefinitionPrefix } from './middleware-array-conversions.ts';
import { isTypeOnly, readsBinding } from './scope.ts';
import { writtenBy } from './written.ts';

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
  readonly replacedGlobal: (call: CallExpression, method: string) => boolean;
  readonly sourceOf: (expression: Expression) => Expression | undefined;
  readonly memberOf: (value: Expression, name: string) => Expression | undefined;
}

const DEFINERS = new Set(['Object.defineProperty', 'Reflect.defineProperty']);
const DEFINER_GLOBALS = new Set(['Array', 'Object', 'Reflect']);
const DEFINITION = { slots: 3 } as const;
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
const SELECTOR_MUTATOR_GLOBALS = new Set([
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.setPrototypeOf',
  'Reflect.defineProperty',
  'Reflect.set',
  'Reflect.setPrototypeOf',
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

/** Rejects shown receiver-owned selector replacements on non-borrowed native selector calls. */
export function middlewareReplacedReceiverSelector(
  call: CallExpression,
  receiver: Expression,
  method: string,
  sourceOf: (expression: Expression) => Expression | undefined,
): boolean {
  if (sourceArrayFunction(call.expression)) return true;
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      writesReceiverSelector(node, receiver, method, sourceOf) &&
      possiblePriorSelectorWrite(node, call)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
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

/** Quiet element reads and own selector writes preserve the array's length and element slots. */
function harmlessSelectorArrayUse(
  reference: Identifier,
  directAliases: ReadonlySet<FrameBinding>,
  context: SelectorGuardContext,
): boolean {
  const selected = frameBindingOf(reference);
  if (selected === undefined || !directAliases.has(selected.binding)) return false;
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
    return (
      PURE_ARRAY_READS.has(key) &&
      !context.replacedGlobal(grand, key) &&
      grand.arguments.every((argument) => framedQuietPrimitive(argument))
    );
  if (!replacesExpression(parent)) return true;
  return !isDeleteExpression(grand) && context.selectors.has(key);
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

/** Direct assignments, counts, loops or deletions targeting `expression` replace its current value. */
function replacesExpression(expression: Expression): boolean {
  const write = writtenBy(useOf(expression).parent);
  return (
    write !== undefined &&
    targetsOf(write).some(
      (target) => isExpression(target) && unwrapped(target) === unwrapped(expression),
    )
  );
}

/** Completed writes before method lookup, loop writes, and referenced closures can install own methods. */
function possiblePriorSelectorWrite(operation: Node, call: CallExpression): boolean {
  if (!framedPossibleBranch(operation)) return false;
  const reader = executionOwner(call);
  const writer = executionOwner(operation);
  if (writer !== reader) return !unreferencedLocalFunction(writer, reader);
  if (operation.end <= call.expression.end && !destructuredFirst(call.expression, operation))
    return true;
  return repeatedFrameRead(operation, call.expression, call.getSourceFile(), reader);
}

/** Detects assignments or Object/Reflect definitions that can install `method` or a prototype on `receiver`. */
function writesReceiverSelector(
  node: Node,
  receiver: Expression,
  method: string,
  sourceOf: (expression: Expression) => Expression | undefined,
): boolean {
  if (isDeleteExpression(node)) return false;
  const write = writtenBy(node);
  if (write === undefined) return false;
  if (!isCallExpression(node))
    return targetsOf(write).some((target) =>
      directSelectorWrite(target, receiver, method, sourceOf),
    );
  const mutator = calledSelectorMutator(node);
  return (
    mutator !== undefined &&
    isExpression(write) &&
    sameSelectorReceiver(write, receiver, sourceOf) &&
    !definesUnrelatedReceiverProperty(node, mutator, method)
  );
}

/** Direct property or `__proto__` assignment onto the same array receiver installs a non-native lookup. */
function directSelectorWrite(
  target: Node,
  receiver: Expression,
  method: string,
  sourceOf: (expression: Expression) => Expression | undefined,
): boolean {
  if (!isExpression(target)) return false;
  const value = unwrapped(target);
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return false;
  const key = frameMemberName(value);
  return (
    (key === method || key === '__proto__') &&
    sameSelectorReceiver(value.expression, receiver, sourceOf)
  );
}

/** Extracts the global Object/Reflect mutator path across direct, borrowed, and bound invocations. */
function calledSelectorMutator(call: CallExpression): string | undefined {
  const direct = globalPathOf(unwrapped(call.expression))?.join('.');
  if (direct !== undefined && SELECTOR_MUTATOR_GLOBALS.has(direct)) return direct;
  const borrowed = borrowedTextCall(call)?.path.join('.');
  if (borrowed !== undefined && SELECTOR_MUTATOR_GLOBALS.has(borrowed)) return borrowed;
  const callee = unwrapped(call.expression);
  const bound = isIdentifier(callee) ? initializerOf(callee) : undefined;
  const boundCall = bound === undefined ? undefined : unwrapped(bound);
  if (boundCall === undefined || !isCallExpression(boundCall)) return undefined;
  const binder = unwrapped(boundCall.expression);
  if (
    (!isPropertyAccessExpression(binder) && !isElementAccessExpression(binder)) ||
    frameMemberName(binder) !== 'bind'
  )
    return undefined;
  const target = globalPathOf(unwrapped(binder.expression))?.join('.');
  return target !== undefined && SELECTOR_MUTATOR_GLOBALS.has(target) ? target : undefined;
}

/** Quiet single-property definitions naming a different non-prototype key leave `method` untouched. */
function definesUnrelatedReceiverProperty(
  call: CallExpression,
  mutator: string,
  method: string,
): boolean {
  if (!DEFINERS.has(mutator) || call.arguments.length !== DEFINITION.slots) return false;
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  if (path !== mutator) return false;
  const [, property, descriptor] = call.arguments;
  if (property === undefined || descriptor === undefined) return false;
  const key = unwrapped(property);
  const data = unwrapped(descriptor);
  return (
    isStringLiteral(key) &&
    key.text !== method &&
    key.text !== '__proto__' &&
    isObjectLiteralExpression(data) &&
    framedAccessorQuietValue(data) &&
    unchangedNativeBind(call.expression, call, DEFINER_GLOBALS) &&
    quietDefinitionPrefix(call)
  );
}

/** Matches two receiver expressions through syntax identity, shared literal source, or shared bindings. */
function sameSelectorReceiver(
  left: Expression,
  right: Expression,
  sourceOf: (expression: Expression) => Expression | undefined,
): boolean {
  const first = unwrapped(left);
  const second = unwrapped(right);
  if (first === second) return true;
  const firstSource = sourceOf(first);
  const secondSource = sourceOf(second);
  if (firstSource !== undefined && firstSource === secondSource) return true;
  const firstKeys = receiverIdentities(first);
  if (firstKeys.size === 0) return false;
  for (const key of receiverIdentities(second)) {
    if (firstKeys.has(key)) return true;
  }
  return false;
}

/** Collects `(declarationPos:memberPath)` keys across `const` alias steps for receiver matching. */
function receiverIdentities(expression: Expression): ReadonlySet<string> {
  const found = new Set<string>();
  const initial = memberPath(expression);
  let keys = [...initial.keys];
  let root = initial.root;
  const seen = new Set<Node>();
  while (isIdentifier(root)) {
    const binding = frameBindingOf(root);
    const declared = binding?.binding ?? declarationOf(root);
    if (declared === undefined || seen.has(declared)) break;
    seen.add(declared);
    const prefix = binding === undefined ? [] : binding.keys;
    found.add(`${String(declared.pos)}:${[...prefix, ...keys].join('.')}`);
    if (
      binding === undefined ||
      binding.keys.length > 0 ||
      !isConstDeclaration(binding.binding) ||
      binding.binding.initializer === undefined
    )
      break;
    const next = memberPath(binding.binding.initializer);
    keys = [...next.keys, ...keys];
    root = next.root;
  }
  return found;
}

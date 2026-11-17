import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { memberPath } from './exported-values.ts';
import { framedAccessorQuietValue } from './framed-accessor-descriptors.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { unchangedNativeBind } from './framed-native-bind.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { declarationOf, initializerOf } from './framed.ts';
import { targetsOf } from './kept.ts';
import { quietDefinitionPrefix } from './middleware-array-conversions.ts';
import { isTypeOnly } from './scope.ts';
import { writtenBy } from './written.ts';

/** Receiver-owned selector override and member-write target checks for native array guards. */

const DEFINERS = new Set(['Object.defineProperty', 'Reflect.defineProperty']);
const DEFINER_GLOBALS = new Set(['Array', 'Object', 'Reflect']);
const DEFINITION = { slots: 3 } as const;
const SELECTOR_MUTATOR_GLOBALS = new Set([
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.setPrototypeOf',
  'Reflect.defineProperty',
  'Reflect.set',
  'Reflect.setPrototypeOf',
]);

/** Direct assignments, counts, loops or deletions targeting `expression` replace its current value. */
export function middlewareExpressionReplaced(expression: Expression): boolean {
  const write = writtenBy(useOf(expression).parent);
  return (
    write !== undefined &&
    targetsOf(write).some(
      (target) => isExpression(target) && unwrapped(target) === unwrapped(expression),
    )
  );
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

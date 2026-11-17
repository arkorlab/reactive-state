import {
  type CallExpression,
  type Expression,
  type Identifier,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isLiteralTypeNode,
  isNonNullExpression,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isParenthesizedTypeNode,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isTypeAssertion,
  isUnionTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { framedAccessorQuietValue } from './framed-accessor-descriptors.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedAppliedArguments, framedArgumentPrefix, framedMemberNames } from './framed-keys.ts';
import { unchangedNativeBind } from './framed-native-bind.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { quietDefinitionPrefix } from './middleware-array-conversions.ts';
import { middlewareWriteTargets } from './middleware-assignment-targets.ts';
import {
  type ReceiverResolutionContext,
  sameSelectorReceiver,
} from './middleware-receiver-identities.ts';
import { isTypeOnly } from './scope.ts';
import { writtenBy } from './written.ts';

/** Receiver-owned selector override and member-write target checks for native array guards. */

export type { ReceiverResolutionContext } from './middleware-receiver-identities.ts';

interface InvokedSelectorMutator {
  readonly mutator: string;
  readonly candidates: readonly Expression[];
  readonly applied?: Expression | undefined;
  readonly direct: boolean;
}

const DEFINERS = new Set(['Object.defineProperty', 'Reflect.defineProperty']);
const DEFINER_GLOBALS = new Set(['Array', 'Object', 'Reflect']);
const DEFINITION = { slots: 3 } as const;
const NUMERIC_ARITHMETIC = new Set([
  SyntaxKind.AsteriskAsteriskToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.MinusToken,
  SyntaxKind.PercentToken,
  SyntaxKind.SlashToken,
]);
const NUMERIC_UNARY = new Set([
  SyntaxKind.MinusMinusToken,
  SyntaxKind.MinusToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.PlusToken,
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

/** Rejects shown receiver-owned selector replacements on non-borrowed native selector calls. */
export function middlewareReplacedReceiverSelector(
  call: CallExpression,
  receiver: Expression,
  method: string,
  context: ReceiverResolutionContext,
): boolean {
  if (sourceArrayFunction(call.expression)) return true;
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      writesReceiverSelector(node, receiver, method, context) &&
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
  context: ReceiverResolutionContext,
): boolean {
  if (isDeleteExpression(node)) return false;
  if (isCallExpression(node)) return mutatorCallReplacesSelector(node, receiver, method, context);
  const write = writtenBy(node);
  return (
    write !== undefined &&
    middlewareWriteTargets(write).some((target) =>
      directSelectorWrite(target, receiver, method, context),
    )
  );
}

/** Direct or computed writes on the same receiver fail closed unless the key excludes `method` and `__proto__`. */
function directSelectorWrite(
  target: Node,
  receiver: Expression,
  method: string,
  context: ReceiverResolutionContext,
): boolean {
  if (!isExpression(target)) return false;
  const value = unwrapped(target);
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return false;
  if (!sameSelectorReceiver(value.expression, receiver, context)) return false;
  const names = framedMemberNames(value);
  if (names !== undefined) return names.includes(method) || names.includes('__proto__');
  return !isElementAccessExpression(value) || !provenNumericKey(value.argumentExpression);
}

/** Checks Object/Reflect mutators across direct, `const`-aliased, borrowed, bound, and spread calls. */
function mutatorCallReplacesSelector(
  call: CallExpression,
  receiver: Expression,
  method: string,
  context: ReceiverResolutionContext,
): boolean {
  const invoked = invokedSelectorMutator(call);
  if (invoked === undefined) return false;
  const matched =
    invoked.candidates.some((target) => sameSelectorReceiver(target, receiver, context)) ||
    (invoked.applied !== undefined && mentionsReceiver(invoked.applied, receiver, context));
  if (!matched) return false;
  return !invoked.direct || !definesUnrelatedReceiverProperty(call, invoked.mutator, method);
}

/** Resolves the invoked Object/Reflect mutator and its candidate receiver arguments. */
function invokedSelectorMutator(call: CallExpression): InvokedSelectorMutator | undefined {
  const directPath = resolvedGlobalPath(call.expression)?.join('.');
  if (directPath !== undefined && SELECTOR_MUTATOR_GLOBALS.has(directPath))
    return {
      candidates: targetArgumentCandidates(call, call.arguments),
      direct: globalPathOf(unwrapped(call.expression))?.join('.') === directPath,
      mutator: directPath,
    };
  const borrowed = borrowedTextCall(call);
  const borrowedPath = borrowed?.path.join('.');
  if (
    borrowed !== undefined &&
    borrowedPath !== undefined &&
    SELECTOR_MUTATOR_GLOBALS.has(borrowedPath)
  )
    return borrowedMutatorTargets(call, borrowedPath, borrowed.given, borrowed.applied);
  return boundMutatorTargets(call);
}

/** Extracts target candidates from borrowed `.call`, `.apply`, and `Reflect.apply` mutator calls. */
function borrowedMutatorTargets(
  call: CallExpression,
  mutator: string,
  given: readonly Expression[],
  applied: Expression | undefined,
): InvokedSelectorMutator {
  if (applied === undefined)
    return { candidates: targetArgumentCandidates(call, given), direct: false, mutator };
  const tuple = framedAppliedArguments(call, applied);
  return tuple === undefined
    ? { applied, candidates: [], direct: false, mutator }
    : { candidates: targetArgumentCandidates(call, tuple), direct: false, mutator };
}

/** Extracts target candidates from `.bind(...)` wrappers of Object/Reflect mutator globals. */
function boundMutatorTargets(call: CallExpression): InvokedSelectorMutator | undefined {
  const callee = unwrapped(call.expression);
  const bound = isIdentifier(callee) ? constantExpression(callee) : undefined;
  if (bound === undefined || !isCallExpression(bound)) return undefined;
  const binder = unwrapped(bound.expression);
  if (
    (!isPropertyAccessExpression(binder) && !isElementAccessExpression(binder)) ||
    frameMemberName(binder) !== 'bind'
  )
    return undefined;
  const mutator = resolvedGlobalPath(binder.expression)?.join('.');
  if (mutator === undefined || !SELECTOR_MUTATOR_GLOBALS.has(mutator)) return undefined;
  const combined = [...bound.arguments.slice(1), ...call.arguments];
  return { candidates: targetArgumentCandidates(call, combined), direct: false, mutator };
}

/** Collects first-parameter argument candidates across direct arguments and spread prefixes. */
function targetArgumentCandidates(
  call: CallExpression,
  given: readonly Expression[],
): readonly Expression[] {
  const prefix = framedArgumentPrefix(call, given, 1);
  return [...prefix.values, ...(prefix.alternatives ?? [])];
}

/** Follows whole `const` lexical aliases to a global path such as `Reflect.set`. */
function resolvedGlobalPath(expression: Expression): readonly string[] | undefined {
  let value = unwrapped(expression);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const next = constantExpression(value);
    if (next === undefined) break;
    value = next;
  }
  return globalPathOf(value);
}

/** Resolves one whole `const` variable identifier to its unwrapped initializer expression. */
function constantExpression(name: Identifier): Expression | undefined {
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  if (
    binding === undefined ||
    selected?.keys.length !== 0 ||
    !isConstDeclaration(binding) ||
    binding.initializer === undefined
  )
    return undefined;
  return unwrapped(binding.initializer);
}

/** Checks whether an unresolved `.apply` argument list mentions the tracked array receiver. */
function mentionsReceiver(
  expression: Expression,
  receiver: Expression,
  context: ReceiverResolutionContext,
): boolean {
  const pending: Node[] = [expression];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && sameSelectorReceiver(node, receiver, context)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Quiet single-property definitions naming a different non-prototype key leave `method` untouched. */
function definesUnrelatedReceiverProperty(
  call: CallExpression,
  mutator: string,
  method: string,
): boolean {
  if (!DEFINERS.has(mutator) || call.arguments.length !== DEFINITION.slots) return false;
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

/** Proves a computed key evaluates only to numbers or bigints without type-assertion escapes. */
function provenNumericKey(expression: Expression): boolean {
  const pending: Expression[] = [expression];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const value = stripParentheses(current);
    if (isNumericLiteral(value) || value.kind === SyntaxKind.BigIntLiteral) continue;
    if (
      (isPrefixUnaryExpression(value) || isPostfixUnaryExpression(value)) &&
      NUMERIC_UNARY.has(value.operator)
    )
      continue;
    if (isBinaryExpression(value) && stepNumericBinary(value, pending)) continue;
    if (isIdentifier(value) && unmutatedNumericBinding(value)) continue;
    return false;
  }
  return true;
}

/** Strips parentheses without erasing type assertions that could disguise string keys as numbers. */
function stripParentheses(expression: Expression): Expression {
  let current = expression;
  while (isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** Validates arithmetic binary operators, queuing `+` operands to exclude string concatenation. */
function stepNumericBinary(expression: Expression, pending: Expression[]): boolean {
  if (!isBinaryExpression(expression)) return false;
  const { kind } = expression.operatorToken;
  if (NUMERIC_ARITHMETIC.has(kind)) return true;
  if (kind !== SyntaxKind.PlusToken) return false;
  pending.push(expression.left, expression.right);
  return true;
}

/** Checks that an identifier resolves to an unmutated `number` or `bigint` binding without casts. */
function unmutatedNumericBinding(name: Identifier): boolean {
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  if (binding === undefined || selected?.keys.length !== 0 || !numericTypeAnnotation(binding.type))
    return false;
  if (isParameterDeclaration(binding)) {
    if (binding.questionToken !== undefined || binding.dotDotDotToken !== undefined) return false;
  } else if (binding.initializer === undefined) {
    return false;
  }
  if (binding.initializer !== undefined && hasTypeCastWrapper(binding.initializer)) return false;
  return isConstDeclaration(binding) || !bindingReassigned(binding);
}

/** Recognizes `number`, `bigint`, numeric literal, and union type annotations made solely of them. */
function numericTypeAnnotation(type: TypeNode | undefined): boolean {
  if (type === undefined) return false;
  const pending: TypeNode[] = [type];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (isParenthesizedTypeNode(current)) pending.push(current.type);
    else if (isUnionTypeNode(current)) pending.push(...current.types);
    else if (!isNumericAtomicType(current)) return false;
  }
  return true;
}

/** Checks whether an atomic type node denotes a number or bigint value. */
function isNumericAtomicType(type: TypeNode): boolean {
  if (type.kind === SyntaxKind.NumberKeyword || type.kind === SyntaxKind.BigIntKeyword) return true;
  if (!isLiteralTypeNode(type)) return false;
  const { literal } = type;
  return (
    isNumericLiteral(literal) ||
    literal.kind === SyntaxKind.BigIntLiteral ||
    (isPrefixUnaryExpression(literal) && literal.operator === SyntaxKind.MinusToken)
  );
}

/** Detects outer type assertions or non-null casts on an initializer expression. */
function hasTypeCastWrapper(expression: Expression): boolean {
  const current = stripParentheses(expression);
  return (
    isAsExpression(current) ||
    isTypeAssertion(current) ||
    isSatisfiesExpression(current) ||
    isNonNullExpression(current)
  );
}

/** Checks whether any assignment, update, or loop header in the file writes to `binding`. */
function bindingReassigned(binding: FrameBinding): boolean {
  const pending: Node[] = [binding.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const write = writtenBy(node);
    if (
      write !== undefined &&
      middlewareWriteTargets(write).some((target) => writesBinding(target, binding))
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Checks whether a write target identifier resolves directly to `binding`. */
function writesBinding(target: Node, binding: FrameBinding): boolean {
  if (!isExpression(target)) return false;
  const value = unwrapped(target);
  return isIdentifier(value) && frameBindingOf(value)?.binding === binding;
}

export { middlewareExpressionReplaced } from './middleware-assignment-targets.ts';

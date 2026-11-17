import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isDoStatement,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isVariableDeclaration,
  isWhileStatement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import {
  type AliasFrame,
  aliasStep,
  anyAliasRead,
  handedTo,
  handsToMutator,
  isConstIdentifier,
  isWrapping,
  memberChain,
  pathsOverlap,
  ASSIGNING,
  COMPUTING,
  type Target,
  writesDirectlyTo,
  writtenAt,
} from './local-write-paths.ts';
import { assignedValue, CHANGED, checkedSlotOf, NONE, type Writes } from './local-write-targets.ts';
import { constantValue, setsTime } from './numbers.ts';

/**
 * Compound arithmetic (`+=`, `-=`, `*=`, `/=`, `%=`, `**=`), bitwise compound assignments, and
 * prefix/postfix update (`++`, `--`) checks on local constants (`local-writes.ts`).
 */

/** 32-bit integer compound assignments, whose results on JSON numbers are always finite integers. */
const BITWISE_ASSIGNING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
]);

/** Arithmetic compound assignments, which may overflow to `Infinity` or produce `NaN`. */
const ARITHMETIC_ASSIGNING: ReadonlyMap<SyntaxKind, (left: number, right: number) => number> =
  new Map([
    [SyntaxKind.AsteriskAsteriskEqualsToken, (left, right) => left ** right],
    [SyntaxKind.AsteriskEqualsToken, (left, right) => left * right],
    [SyntaxKind.MinusEqualsToken, (left, right) => left - right],
    [SyntaxKind.PercentEqualsToken, (left, right) => left % right],
    [SyntaxKind.PlusEqualsToken, (left, right) => left + right],
    [SyntaxKind.SlashEqualsToken, (left, right) => left / right],
  ]);

const CONTAINER_MUTATING_METHODS: ReadonlySet<string> = new Set([
  'clear',
  'copyWithin',
  'delete',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

/** Whether `node` sits inside a loop or nested function/class within `owner`. */
function standsInRepeatableScope(node: Node, owner: Node): boolean {
  let current: Node = node;
  while (current !== owner && !isSourceFile(current)) {
    const isLoop =
      isForStatement(current) ||
      isForInStatement(current) ||
      isForOfStatement(current) ||
      isWhileStatement(current) ||
      isDoStatement(current);
    const isInnerCallable =
      isArrowFunction(current) ||
      isFunctionExpression(current) ||
      isFunctionDeclaration(current) ||
      isMethodDeclaration(current) ||
      isGetAccessorDeclaration(current) ||
      isSetAccessorDeclaration(current) ||
      isClassExpression(current) ||
      isClassDeclaration(current);
    if (isLoop || isInnerCallable) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/** Whether `top` wraps a holder inside an object/array literal whose members may be written later. */
function escapesThroughLiteral(top: Expression): boolean {
  let at: Node = top;
  while (
    (isPropertyAssignment(at.parent) && at.parent.initializer === at) ||
    isShorthandPropertyAssignment(at.parent) ||
    isArrayLiteralExpression(at.parent) ||
    isObjectLiteralExpression(at.parent) ||
    isWrapping(at.parent, at)
  ) {
    at = at.parent;
  }
  if (at === top) {
    return false;
  }
  const { parent } = at;
  return (
    isVariableDeclaration(parent) ||
    isPropertyAccessExpression(parent) ||
    isElementAccessExpression(parent)
  );
}

/** Whether `readTop` invokes a mutating method on an overlapping container path. */
function callsMutatingMethod(
  readTop: Expression,
  keys: readonly (string | undefined)[],
  suffixLength: number,
): boolean {
  if (
    keys.length > suffixLength + 1 ||
    !isCallExpression(readTop.parent) ||
    readTop.parent.expression !== readTop
  ) {
    return false;
  }
  const method = keys.at(-1);
  return method === undefined || CONTAINER_MUTATING_METHODS.has(method) || setsTime(method);
}

/** Checks whether another read of `holder` may mutate `suffix` beside `soleTop`. */
function checkCompetingWrite(
  soleTop: Expression,
  node: Identifier,
  suffix: readonly (string | undefined)[],
  { queue, target }: { readonly queue: AliasFrame[]; readonly target: Target },
): boolean {
  const { keys, top } = memberChain(node, target.resolve);
  if (top === soleTop || !pathsOverlap(keys, suffix)) {
    return false;
  }
  if (writesDirectlyTo(top) || callsMutatingMethod(top, keys, suffix.length)) {
    return true;
  }
  if (keys.length > suffix.length) {
    return false;
  }
  const step = aliasStep(top, suffix.slice(keys.length));
  if (step.kind === 'escaped') {
    return true;
  }
  if (step.frame !== undefined) {
    queue.push(step.frame);
    return false;
  }
  const call = handedTo(top);
  return (call !== undefined && handsToMutator(call, top, target)) || escapesThroughLiteral(top);
}

/** Whether `soleTop` is the single non-loop write touching `target.keys` in `target.owner`. */
function isSoleSlotWrite(soleTop: Expression, target: Target): boolean {
  if (
    !isConstIdentifier(target.declared) ||
    target.keys.length === 0 ||
    target.keys.includes(undefined) ||
    standsInRepeatableScope(soleTop, target.owner)
  ) {
    return false;
  }
  return !anyAliasRead(target, target.keys, (node, suffix, current, queue) =>
    checkCompetingWrite(soleTop, node, suffix, { queue, target: current }),
  );
}

/** Evaluates a compound write (`BITWISE_ASSIGNING` or `ARITHMETIC_ASSIGNING`). */
export function computedWrite(
  operator: SyntaxKind,
  top: Expression,
  value: Expression,
  target: Target,
): Writes {
  if (BITWISE_ASSIGNING.has(operator)) {
    return { changes: false, values: [{ entry: false, inside: target.inside, value }] };
  }
  const compute = ARITHMETIC_ASSIGNING.get(operator);
  if (compute === undefined || !isSoleSlotWrite(top, target)) {
    return CHANGED;
  }
  const initial = writtenAt(target.initializer, target.keys, target.resolve);
  const left = initial === undefined ? undefined : constantValue(initial, target.resolve);
  if (typeof left === 'string' && operator === SyntaxKind.PlusEqualsToken) {
    return { changes: false, values: [{ entry: false, inside: target.inside, value }] };
  }
  const right = constantValue(value, target.resolve);
  const isFiniteResult =
    typeof left === 'number' && typeof right === 'number' && Number.isFinite(compute(left, right));
  return isFiniteResult
    ? { changes: false, values: [{ entry: false, inside: target.inside, value }] }
    : CHANGED;
}

/** Evaluates `++target.member` / `target.member++` / `--target.member` / `target.member--`. */
export function updatedAt(operator: SyntaxKind, top: Expression, target: Target): Writes {
  if (target.keys.length === 0) {
    return NONE;
  }
  if (checkedSlotOf(target) === 'changed') {
    return CHANGED;
  }
  if (!isSoleSlotWrite(top, target)) {
    return CHANGED;
  }
  const initial = writtenAt(target.initializer, target.keys, target.resolve);
  const left = initial === undefined ? undefined : constantValue(initial, target.resolve);
  const delta = operator === SyntaxKind.PlusPlusToken ? 1 : -1;
  return initial !== undefined && typeof left === 'number' && Number.isFinite(left + delta)
    ? { changes: false, values: [{ entry: false, inside: target.inside, value: initial }] }
    : CHANGED;
}

/** Evaluates any binary assignment (`=`, logical, bitwise, or compound arithmetic) onto `target`. */
export function assignedBinary(
  operator: SyntaxKind,
  top: Expression,
  value: Expression,
  target: Target,
): Writes {
  if (ASSIGNING.has(operator)) {
    return assignedValue(value, target);
  }
  if (!COMPUTING.has(operator) || target.keys.length === 0) {
    return NONE;
  }
  if (checkedSlotOf(target) === 'changed') {
    return CHANGED;
  }
  return computedWrite(operator, top, value, target);
}

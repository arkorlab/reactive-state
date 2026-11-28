import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
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
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isTemplateExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isWhileStatement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPath } from './global-answers.ts';
import {
  type AliasFrame,
  aliasStep,
  anyAliasRead,
  handedTo,
  handsToMutator,
  holdsInitializer,
  isConstList,
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
import { bindingIdentifiers } from './scope.ts';

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

/** The operators of `ARITHMETIC_ASSIGNING` that make no finite number of a zero on their right. */
const BY_ZERO: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.SlashEqualsToken,
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
export function standsInRepeatableScope(node: Node, owner: Node): boolean {
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

/**
 * Whether `node`, a read of the parameter `target.declared`, is the write that gives it the object
 * `target.initializer` is (`Target.isHeld`): the definite replacement of the parameter, which the
 * object the sum is written into comes from, so no write beside the sum.
 */
function isReplacement(node: Identifier, target: Target): boolean {
  const { keys, top } = memberChain(node, target.resolve);
  const { parent } = top;
  return (
    target.isHeld === true &&
    keys.length === 0 &&
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === top &&
    parent.right === target.initializer
  );
}

/**
 * Whether `soleTop` is the single non-loop write touching `target.keys` in `target.owner`, but for
 * the replacement of a parameter that gives it the object it writes into.
 */
function isSoleSlotWrite(soleTop: Expression, target: Target): boolean {
  if (
    !holdsInitializer(target) ||
    target.keys.length === 0 ||
    target.keys.includes(undefined) ||
    standsInRepeatableScope(soleTop, target.owner)
  ) {
    return false;
  }
  return !anyAliasRead(target, target.keys, (node, suffix, current, queue) => {
    return (
      !isReplacement(node, current) &&
      checkCompetingWrite(soleTop, node, suffix, { queue, target: current })
    );
  });
}

/** The names a loop over `top` binds in its head, where it declares them of `const`. */
function loopNamesOf(top: Expression): readonly Identifier[] {
  const loop: Node = top.parent;
  if (!isForOfStatement(loop) || loop.expression !== top) {
    return [];
  }
  const { initializer } = loop;
  return isVariableDeclarationList(initializer) && isConstList(initializer)
    ? initializer.declarations.flatMap((each) => bindingIdentifiers(each.name))
    : [];
}

/**
 * Whether nothing but `reader`, a read that takes the container at `target.keys` apart — a loop
 * over it, a pattern — writes into it or adds to it in `target.owner`: not an element or a member
 * of one, nor a method that changes it, nor a name it is handed to. Another loop over it is no
 * write itself, but what its variables write is: they are read as the container's elements, and
 * a loop that writes through its variable makes the others' elements unknown.
 */
export function isUnchangedBut(reader: Expression, target: Target): boolean {
  return !anyAliasRead(target, target.keys, (node, suffix, current, queue) => {
    const { keys, top } = memberChain(node, current.resolve);
    const names = loopNamesOf(top);
    if (keys.length === suffix.length && names.length > 0) {
      if (top !== reader) {
        queue.push(...names.map((holder) => ({ holder, suffix: [] })));
      }
      return false;
    }
    return checkCompetingWrite(reader, node, suffix, { queue, target: current });
  });
}

/** What a compound or an update write puts of `value` into the slot, which it does not change. */
function putOf(value: Expression, target: Target): Writes {
  return { changes: false, values: [{ entry: false, inside: target.inside, value }] };
}

/** Whether the operator on the right of which `right` stands makes no finite number of anything. */
function isByZero(operator: SyntaxKind, right: number | string | undefined): boolean {
  return right === 0 && BY_ZERO.has(operator);
}

/** Whether `value` is the global `undefined`, which a `+`, a `-`, `++` and `--` make `NaN` of. */
function isUndefinedValue(value: Expression): boolean {
  return globalPath(unwrapped(value))?.join('.') === 'undefined';
}

/**
 * Whether the slot `initial` initializes shows it holds no number: text, an object, an array, a
 * function, a class, a pattern, a construction, or `undefined`, which a `-`, `++` or `--` makes
 * `NaN` of. What the code does not show — a call, a name, a page's value — is left to the
 * authority.
 */
function holdsNoNumber(initial: Expression, left: number | string | undefined): boolean {
  const value = unwrapped(initial);
  return (
    typeof left === 'string' ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value) ||
    isRegularExpressionLiteral(value) ||
    isNewExpression(value) ||
    isTemplateExpression(value) ||
    isUndefinedValue(value)
  );
}

/** Whether a write that is the only one of its slot leaves a finite number, as far as it shows. */
function showsFinite(
  compute: (left: number, right: number) => number,
  { isAdditive, left, right }: { isAdditive: boolean; left: unknown; right: unknown },
): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    return Number.isFinite(compute(left, right));
  }
  return isAdditive && typeof left !== 'string';
}

/**
 * What a compound arithmetic write (`ARITHMETIC_ASSIGNING`) shows of its result. Of a number the
 * code shows, it is refused where it is not finite: the slot's initial value and the operand are
 * folded, where this write is the only one of the slot (`isSoleSlotWrite`). A slot that nothing
 * initializes, or that holds text a `-` reads, is `NaN` there. Division by zero and the remainder
 * of it are not finite whatever they divide. A sum or a count that a loop, a callback or another
 * write repeats, or that adds a page's value, is left to the authority, which refuses a number
 * that is not finite where it meets it: `+=` and `-=` of finite numbers reach no infinity but by a
 * loop of 1e308 steps. A product, a power or a quotient it repeats, or of an operand it cannot
 * read, is refused: a few steps overflow. Of a parameter read as holding an object (`Target.isHeld`)
 * a sum is taken as the only write of its slot alone: the writes beside it are read of the whole
 * function, the ones before a replacement too, but for the replacement itself, which gives the
 * object the sum is written into: a sum that is not alone is not shown to be the repeated one,
 * and is refused.
 */
function arithmeticWrite(
  operator: SyntaxKind,
  top: Expression,
  value: Expression,
  target: Target,
): Writes {
  const compute = ARITHMETIC_ASSIGNING.get(operator);
  const right = constantValue(value, target.resolve);
  const initial = writtenAt(target.initializer, target.keys, target.resolve);
  if (compute === undefined || initial === undefined || isByZero(operator, right)) {
    return CHANGED;
  }
  const left = constantValue(initial, target.resolve);
  const isPlus = operator === SyntaxKind.PlusEqualsToken;
  const isAdditive = isPlus || operator === SyntaxKind.MinusEqualsToken;
  const put = putOf(value, target);
  if (typeof left === 'string' && isPlus) {
    return put;
  }
  if (isAdditive && !isPlus && holdsNoNumber(initial, left)) {
    return CHANGED;
  }
  if (isPlus && typeof right !== 'string' && isUndefinedValue(initial)) {
    return CHANGED;
  }
  if (!isSoleSlotWrite(top, target)) {
    return isAdditive && target.isHeld !== true ? put : CHANGED;
  }
  const operand = typeof right === 'string' && !isPlus ? Number(right) : right;
  return showsFinite(compute, { isAdditive, left, right: operand }) ? put : CHANGED;
}

/** Evaluates a compound write (`BITWISE_ASSIGNING` or `ARITHMETIC_ASSIGNING`). */
export function computedWrite(
  operator: SyntaxKind,
  top: Expression,
  value: Expression,
  target: Target,
): Writes {
  return BITWISE_ASSIGNING.has(operator)
    ? putOf(value, target)
    : arithmeticWrite(operator, top, value, target);
}

/**
 * Evaluates `++target.member` / `target.member++` / `--target.member` / `target.member--`: a
 * counter reaches no infinity but by 1e308 steps, so it is refused only where the code shows it
 * does not stay a finite number — a slot nothing initializes, text, a number at the edge — as
 * `arithmeticWrite` reads a sum.
 */
export function updatedAt(operator: SyntaxKind, top: Expression, target: Target): Writes {
  if (target.keys.length === 0) {
    return NONE;
  }
  if (checkedSlotOf(target) === 'changed') {
    return CHANGED;
  }
  const initial = writtenAt(target.initializer, target.keys, target.resolve);
  if (initial === undefined) {
    return CHANGED;
  }
  const left = constantValue(initial, target.resolve);
  if (holdsNoNumber(initial, left)) {
    return CHANGED;
  }
  if (!isSoleSlotWrite(top, target)) {
    return NONE;
  }
  const delta = operator === SyntaxKind.PlusPlusToken ? 1 : -1;
  if (typeof left === 'number') {
    return Number.isFinite(left + delta) ? putOf(initial, target) : CHANGED;
  }
  return NONE;
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

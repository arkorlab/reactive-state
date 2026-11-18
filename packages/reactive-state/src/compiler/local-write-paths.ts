import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import { readsOf } from './local-module-reads.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * Member chains, literal container lookup, prefix-replacement checks, and array-shrinking checks
 * for constants inspected by `local-writes.ts`.
 */

/** Where a member of a constant is written: the constant's binding, initializer, owner, and keys. */
export interface Target {
  readonly declared: Identifier;
  readonly initializer: Expression | undefined;
  readonly inside?: Expression | undefined;
  readonly keys: readonly (string | undefined)[];
  readonly owner: Node;
  readonly resolve?: Resolve | undefined;
  readonly callsLocal?: ((callee: Expression) => boolean) | undefined;
}

/** Maximum exclusive array index (`2 ** 32 - 1`); `4294967295` is an ordinary property beside elements. */
const MAX_ARRAY_LENGTH = 4_294_967_295;

const SHRINKING_METHODS: ReadonlySet<string> = new Set(['pop', 'shift', 'splice']);

const MUTATING_GLOBALS: ReadonlySet<string> = new Set([
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.setPrototypeOf',
  'Reflect.apply',
  'Reflect.construct',
  'Reflect.defineProperty',
  'Reflect.deleteProperty',
  'Reflect.set',
  'Reflect.setPrototypeOf',
]);

const CALLING_METHODS: ReadonlySet<string> = new Set(['apply', 'bind', 'call']);

/** The operators that assign what stands on their right. */
export const ASSIGNING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** The operators that assign what they compute of what stands on either side. */
export const COMPUTING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.SlashEqualsToken,
]);

export const UPDATING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.MinusMinusToken,
  SyntaxKind.PlusPlusToken,
]);

/** Whether `list` declares `const` bindings. */
export function isConstList(list: Node): boolean {
  return isVariableDeclarationList(list) && /^const\s/u.test(list.getText());
}

/** Whether `declared` is bound by a `const` variable declaration, or by a pattern of one. */
export function isConstIdentifier(declared: Identifier): boolean {
  let at: Node = declared.parent;
  while (isBindingElement(at) || isObjectBindingPattern(at) || isArrayBindingPattern(at)) {
    at = at.parent;
  }
  return (
    isVariableDeclaration(at) &&
    isConstList(at.parent) &&
    bindingIdentifiers(at.name).includes(declared)
  );
}

/** Whether `parent` wraps `node` as what answers of it alike: parentheses, a cast, a `!`. */
export function isWrapping(parent: Node, node: Node): boolean {
  return (
    (isParenthesizedExpression(parent) ||
      isAsExpression(parent) ||
      isSatisfiesExpression(parent) ||
      isNonNullExpression(parent)) &&
    parent.expression === node
  );
}

/** Resolves a bracket key from a literal or folded constant text/number (`-0` becomes `'0'`). */
export function memberKey(node: Expression, resolve: Resolve | undefined): string | undefined {
  const direct = literalKey(node);
  if (direct !== undefined) {
    return direct;
  }
  const folded = constantValue(node, resolve);
  if (typeof folded === 'string') {
    return folded;
  }
  if (typeof folded === 'number') {
    return Object.is(folded, -0) ? '0' : String(folded);
  }
  return undefined;
}

/** The member a read of `name` reads and its keys in turn (`undefined` where unread). */
export function memberChain(
  name: Identifier,
  resolve?: Resolve,
): {
  readonly keys: readonly (string | undefined)[];
  readonly top: Expression;
} {
  const keys: (string | undefined)[] = [];
  let top: Expression = name;
  for (;;) {
    const { parent } = top;
    if (
      (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
      parent.expression === top
    ) {
      keys.push(
        isPropertyAccessExpression(parent)
          ? parent.name.text
          : memberKey(unwrapped(parent.argumentExpression), resolve),
      );
    } else if (!isWrapping(parent, top)) {
      return { keys, top };
    }
    top = parent as Expression;
  }
}

/** Whether `node` is assigned what a pattern takes apart or what a loop iterates. */
export function isPatternTarget(node: Expression): boolean {
  let at: Node = node;
  let isWithin = false;
  for (;;) {
    const { parent } = at;
    if ((isForOfStatement(parent) || isForInStatement(parent)) && parent.initializer === at) {
      return true;
    }
    if (isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.EqualsToken) {
      const isDefault =
        isArrayLiteralExpression(parent.parent) || isPropertyAssignment(parent.parent);
      if (parent.left !== at || !(isWithin || isDefault)) {
        return false;
      }
      if (isWithin) {
        return true;
      }
    } else if (!isPatternPart(parent, at)) {
      return false;
    }
    isWithin ||= isArrayLiteralExpression(parent) || isObjectLiteralExpression(parent);
    at = parent;
  }
}

/** Whether `parent` holds `node` as a part of a pattern: an element, an entry's value, a spread. */
function isPatternPart(parent: Node, node: Node): boolean {
  return (
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    isShorthandPropertyAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === node) ||
    isWrapping(parent, node)
  );
}

/** The container a member is read from, through any casts around the whole member. */
export function receiverOf(node: Expression): Expression | undefined {
  const value = unwrapped(node);
  return isPropertyAccessExpression(value) || isElementAccessExpression(value)
    ? value.expression
    : undefined;
}

/** The call or the `new` that `node` is given to, an argument or what a spread there spreads. */
export function handedTo(node: Expression): CallExpression | NewExpression | undefined {
  const at = isSpreadElement(node.parent) ? node.parent : node;
  const { parent } = at;
  return (isCallExpression(parent) || isNewExpression(parent)) &&
    parent.arguments?.includes(at) === true
    ? parent
    : undefined;
}

/** Whether `key` is the index of an array's element (`0 <= index < 2 ** 32 - 1`). */
export function isIndex(key: string): boolean {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) && index >= 0 && index < MAX_ARRAY_LENGTH && String(index) === key
  );
}

/** Reads the property name of an object-literal element, folding constant computed keys. */
function objectElementKey(name: Node, resolve: Resolve | undefined): string | undefined {
  if (isComputedPropertyName(name)) {
    return memberKey(unwrapped(name.expression), resolve);
  }
  return isIdentifier(name) ? name.text : literalKey(name);
}

/** Plain property value at `key` in `node`, stopping at any later spread or unreadable computed key. */
function objectEntryOf(
  node: Expression,
  key: string,
  resolve: Resolve | undefined,
): Expression | undefined {
  if (!isObjectLiteralExpression(node)) {
    return undefined;
  }
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    const property = node.properties[index];
    if (property === undefined || isSpreadAssignment(property)) {
      return undefined;
    }
    const named = objectElementKey(property.name, resolve);
    if (named === undefined) {
      return undefined;
    }
    if (named === key) {
      return isPropertyAssignment(property) ? unwrapped(property.initializer) : undefined;
    }
  }
  return undefined;
}

/** What an object or an array the code writes holds at `key`, where it writes it plainly; none else. */
function entryOf(
  node: Expression,
  key: string,
  resolve: Resolve | undefined,
): Expression | undefined {
  if (isArrayLiteralExpression(node)) {
    const hasPriorSpread = node.elements
      .slice(0, isIndex(key) ? Number(key) : 0)
      .some((each) => isSpreadElement(each));
    const element = !hasPriorSpread && isIndex(key) ? node.elements[Number(key)] : undefined;
    return element === undefined || isOmittedExpression(element) || isSpreadElement(element)
      ? undefined
      : unwrapped(element);
  }
  return objectEntryOf(node, key, resolve);
}

/** What an object or an array `initializer` writes there holds at `keys` in turn; none else. */
export function writtenAt(
  initializer: Expression | undefined,
  keys: readonly (string | undefined)[],
  resolve?: Resolve,
): Expression | undefined {
  let at = initializer === undefined ? undefined : unwrapped(initializer);
  for (const key of keys) {
    at = key === undefined || at === undefined ? undefined : entryOf(at, key, resolve);
  }
  return at;
}

/** Whether two key paths can refer to the same member along their shared prefix. */
export function pathsOverlap(
  left: readonly (string | undefined)[],
  right: readonly (string | undefined)[],
): boolean {
  const shared = Math.min(left.length, right.length);
  return left.slice(0, shared).every((each, index) => {
    const other = right[index];
    return each === undefined || other === undefined || each === other;
  });
}

/** Whether `top` writes directly into the member expression itself (`=`, `+=`, `++`, `delete`, pattern). */
export function writesDirectlyTo(top: Expression): boolean {
  if (isPatternTarget(top)) {
    return true;
  }
  const { parent } = top;
  if (isDeleteExpression(parent) && parent.expression === top) {
    return true;
  }
  if (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    parent.operand === top
  ) {
    return UPDATING.has(parent.operator);
  }
  return (
    isBinaryExpression(parent) &&
    parent.left === top &&
    (ASSIGNING.has(parent.operatorToken.kind) || COMPUTING.has(parent.operatorToken.kind))
  );
}

/** Whether handing `top` to `call` may mutate or invoke it locally. */
export function handsToMutator(
  call: CallExpression | NewExpression,
  top: Expression,
  target: Target,
): boolean {
  const callee = unwrapped(call.expression);
  const path = globalPath(callee);
  const global = path?.join('.');
  const method = path?.at(-1) ?? (isPropertyAccessExpression(callee) ? callee.name.text : '');
  if (CALLING_METHODS.has(method)) {
    return true;
  }
  if (global !== undefined) {
    const given = call.arguments ?? [];
    return given[0] === top && MUTATING_GLOBALS.has(global);
  }
  return isCallExpression(call) && target.callsLocal?.(callee) === true;
}

export interface AliasFrame {
  readonly holder: Identifier;
  readonly suffix: readonly (string | undefined)[];
}

interface AliasTransition {
  readonly kind: 'alias' | 'escaped' | 'none';
  readonly frame?: AliasFrame | undefined;
}

/** Next `const` alias frame if `top` binds a plain `const` identifier, or `'escaped'` if non-const aliased. */
export function aliasStep(
  top: Expression,
  suffix: readonly (string | undefined)[],
): AliasTransition {
  const { parent } = top;
  if (isVariableDeclaration(parent) && parent.initializer === top) {
    if (!isConstList(parent.parent) || !isIdentifier(parent.name)) {
      return { kind: 'escaped' };
    }
    return { frame: { holder: parent.name, suffix }, kind: 'alias' };
  }
  if (isForOfStatement(parent) && parent.expression === top) {
    return { kind: 'escaped' };
  }
  return { kind: 'none' };
}

/** Whether a single read of `holder` may overwrite `suffix` or enqueue another alias frame. */
export function checkPrefixRead(
  node: Identifier,
  suffix: readonly (string | undefined)[],
  target: Target,
  queue: AliasFrame[],
): boolean {
  const { keys, top } = memberChain(node, target.resolve);
  if (keys.length > suffix.length || !pathsOverlap(keys, suffix)) {
    return false;
  }
  if (writesDirectlyTo(top)) {
    return true;
  }
  if (keys.length === suffix.length) {
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
  return call !== undefined && handsToMutator(call, top, target);
}

/** Walks `target.declared` and its `const` aliases, stopping when `checkRead` reports a hazard. */
export function anyAliasRead(
  target: Target,
  containerKeys: readonly (string | undefined)[],
  checkRead: (
    node: Identifier,
    suffix: readonly (string | undefined)[],
    target: Target,
    queue: AliasFrame[],
  ) => boolean,
): boolean {
  const queue: AliasFrame[] = [{ holder: target.declared, suffix: containerKeys }];
  const seen = new Set<Identifier>();
  for (let frame = queue.pop(); frame !== undefined; frame = queue.pop()) {
    if (seen.has(frame.holder)) {
      continue;
    }
    seen.add(frame.holder);
    const isRead = readsOf(frame.holder, target.owner);
    const state = { matched: false };
    const visit = (node: Node): void => {
      if (state.matched) {
        return;
      }
      if (isRead(node) && checkRead(node, frame.suffix, target, queue)) {
        state.matched = true;
        return;
      }
      node.forEachChild(visit);
    };
    target.owner.forEachChild(visit);
    if (state.matched) {
      return true;
    }
  }
  return false;
}

/** Container expression at `containerKeys` when no write in `target.owner` replaces any prefix of it. */
export function unreplacedAt(
  target: Target,
  containerKeys: readonly (string | undefined)[],
): Expression | undefined {
  const found = writtenAt(target.initializer, containerKeys, target.resolve);
  if (found === undefined || !isConstIdentifier(target.declared)) {
    return undefined;
  }
  if (containerKeys.length > 0 && anyAliasRead(target, containerKeys, checkPrefixRead)) {
    return undefined;
  }
  return found;
}

/** Whether a single read of `holder` may shrink the array at `suffix` or enqueue an alias frame. */
function checkShrinkRead(
  node: Identifier,
  suffix: readonly (string | undefined)[],
  target: Target,
  queue: AliasFrame[],
): boolean {
  const { keys, top } = memberChain(node, target.resolve);
  if (!pathsOverlap(keys, suffix)) {
    return false;
  }
  if (
    keys.length === suffix.length + 1 &&
    isCallExpression(top.parent) &&
    top.parent.expression === top
  ) {
    const method = keys.at(-1);
    return method === undefined || SHRINKING_METHODS.has(method);
  }
  if (keys.length > suffix.length) {
    return keys[suffix.length] === 'length' && writesDirectlyTo(top);
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
  return call !== undefined && handsToMutator(call, top, target);
}

/** Whether the array at `containerKeys` may have its `.length` shrunk in `target.owner`. */
export function isShrunkAt(
  target: Target,
  containerKeys: readonly (string | undefined)[],
): boolean {
  return anyAliasRead(target, containerKeys, checkShrinkRead);
}

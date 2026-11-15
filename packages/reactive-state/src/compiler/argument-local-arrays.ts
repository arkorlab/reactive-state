import {
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNonNullExpression,
  isNumericLiteral,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { rootOf, targetsOf } from './kept.ts';
import { bindingIdentifiers, isBlockScoped, readsBinding } from './scope.ts';
import { writtenArgumentBy, writtenBy } from './written.ts';

/** Local-binding and cached fresh-local-array write exemptions for argument-effect checks. */

interface CompromisedLocalArrays {
  readonly declarations: ReadonlySet<Node>;
  readonly varCounts: ReadonlyMap<string, number>;
}

const LOCAL_ARRAY_CALLS: ReadonlySet<string> = new Set(['pop', 'push', 'shift', 'unshift']);
const COMPROMISED_ARRAYS = new WeakMap<Node, CompromisedLocalArrays>();

/** Every binding, member or argument target `node` mutates. */
export function allWrittenTargets(node: Node): readonly Node[] {
  const written = writtenBy(node);
  const primary = written === undefined ? [] : writeTargets(node, written);
  return [...primary, ...writtenArgumentBy(node).flatMap((each) => targetsOf(each))];
}

/** Rebinding a local or changing a fresh, un-reassigned local array's own storage stays local. */
export function localWrite(target: Node, operation: Node, fn: Node | undefined): boolean {
  if (fn === undefined) {
    return false;
  }
  const binding = directIdentifier(target);
  if (binding !== undefined && !isCallExpression(operation)) {
    const declared = frameDeclarationOf(binding);
    return declared !== undefined && within(declared, fn);
  }
  const arrayRoot = isCallExpression(operation) ? binding : arrayStorageRoot(target);
  const declared = arrayRoot === undefined ? undefined : frameDeclarationOf(arrayRoot);
  return declared !== undefined && within(declared, fn) && freshLocalArray(declared, fn);
}

/** Array insertion/removal has no callback when called on an uncompromised fresh local array. */
export function localArrayCall(node: Node, target: Node, fn: Node | undefined): boolean {
  if (!isCallExpression(node) || !localWrite(target, node, fn)) {
    return false;
  }
  const member = unwrapped(node.expression);
  return isPropertyAccessExpression(member) && LOCAL_ARRAY_CALLS.has(member.name.text);
}

/** Each binding or member target an assignment, loop or in-place write mutates. */
function writeTargets(node: Node, written: Node): readonly Node[] {
  const patterned =
    (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) ||
    isForOfStatement(node) ||
    isForInStatement(node);
  return patterned ? targetsOf(written) : [written];
}

/** A local variable initialized to an array literal that is never rebound or given own methods. */
function freshLocalArray(declared: Node, fn: Node): boolean {
  if (
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    declared.initializer === undefined ||
    !isArrayLiteralExpression(unwrapped(declared.initializer))
  ) {
    return false;
  }
  const indexed = compromisedArraysIn(fn);
  if (indexed.declarations.has(declared)) {
    return false;
  }
  const varCount = indexed.varCounts.get(declared.name.text) ?? 0;
  return isBlockScoped(declared.parent) ? varCount === 0 : varCount <= 1;
}

/** Indexes compromised array declarations and non-block `var` counts once per function `fn`. */
function compromisedArraysIn(fn: Node): CompromisedLocalArrays {
  const cached = COMPROMISED_ARRAYS.get(fn);
  if (cached !== undefined) {
    return cached;
  }
  const declarations = new Set<Node>();
  const varCounts = new Map<string, number>();
  const pending: Node[] = [fn];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    recordVarDeclaration(current, varCounts);
    for (const target of allWrittenTargets(current)) {
      const compromised = compromisedTargetDeclaration(current, target);
      if (compromised !== undefined) {
        declarations.add(compromised);
      }
    }
    current.forEachChild((child) => {
      pending.push(child);
    });
  }
  const indexed: CompromisedLocalArrays = { declarations, varCounts };
  COMPROMISED_ARRAYS.set(fn, indexed);
  return indexed;
}

/** Counts each non-block-scoped `var` binding name declared inside `fn`. */
function recordVarDeclaration(node: Node, varCounts: Map<string, number>): void {
  if (!isVariableDeclaration(node) || isBlockScoped(node.parent)) {
    return;
  }
  const names = new Set(bindingIdentifiers(node.name).map((bound) => bound.text));
  for (const name of names) {
    varCounts.set(name, (varCounts.get(name) ?? 0) + 1);
  }
}

/** The declaration compromised when `(node, target)` rebinds, customizes or escapes an array. */
function compromisedTargetDeclaration(node: Node, target: Node): Node | undefined {
  const root = rootOf(target);
  const declared = root === undefined ? undefined : frameDeclarationOf(root);
  if (declared === undefined) {
    return undefined;
  }
  if (isCallExpression(node)) {
    const member = unwrapped(node.expression);
    const receiver = isPropertyAccessExpression(member)
      ? directIdentifier(member.expression)
      : undefined;
    return receiver !== undefined && frameDeclarationOf(receiver) === declared
      ? undefined
      : declared;
  }
  return arrayStorageRoot(target) === undefined ? declared : undefined;
}

/** The direct local array binding when `node` names its `length` or a literal integer slot. */
function arrayStorageRoot(node: Node): Identifier | undefined {
  const plain = plainTarget(node);
  if (isPropertyAccessExpression(plain)) {
    return plain.name.text === 'length' ? directIdentifier(plain.expression) : undefined;
  }
  if (!isElementAccessExpression(plain)) {
    return undefined;
  }
  const key = unwrapped(plain.argumentExpression);
  const integerSlot =
    (isNumericLiteral(key) || isStringLiteral(key)) &&
    /^(?:0|[1-9]\d*)$/u.test(key.text) &&
    Number.isSafeInteger(Number(key.text));
  return integerSlot ? directIdentifier(plain.expression) : undefined;
}

/** A direct binding read rather than a member or nested element access. */
function directIdentifier(node: Node): Identifier | undefined {
  const plain = plainTarget(node);
  return isIdentifier(plain) && readsBinding(plain) ? plain : undefined;
}

/** A write target peeled of parentheses, casts and non-null assertions. */
function plainTarget(node: Node): Node {
  let each = node;
  while (
    isParenthesizedExpression(each) ||
    isAsExpression(each) ||
    isSatisfiesExpression(each) ||
    isNonNullExpression(each)
  ) {
    each = each.expression;
  }
  return each;
}

/** A declaration owned by this invocation rather than captured from a caller. */
function within(node: Node, owner: Node): boolean {
  for (let at: Node = node; at.kind !== SyntaxKind.SourceFile; at = at.parent) {
    if (at === owner) {
      return true;
    }
  }
  return false;
}

import {
  type BinaryExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { ownerKeyFirst } from './class-key-order.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { constantInitializer } from './framed-array-functions.ts';
import { executionOwner, exportedDeclaration, repeatsAround } from './framed-array-mutations.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedCondition } from './framed-sources.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** The assignments that test the slot, and so can skip their right side: no other assignment does. */
const LOGICAL_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** A logical element assignment can skip its RHS only while its initial stored slot stays known. */
export function framedLogicalElementSkipped(
  node: BinaryExpression,
  root: FrameBinding,
  sameArray: (value: Expression) => boolean,
): boolean {
  if (!LOGICAL_ASSIGNMENTS.has(node.operatorToken.kind)) return false;
  const slot = initialSlot(node, root);
  if (slot === undefined || exportedBefore(node, root) || !unchangedBefore(node, root, sameArray))
    return false;
  const value = slot.value === undefined ? undefined : logicalInitialValue(slot.value);
  const nullish =
    value === undefined ||
    value.kind === SyntaxKind.NullKeyword ||
    isVoidExpression(value) ||
    globalPathOf(value)?.join('.') === 'undefined';
  if (node.operatorToken.kind === SyntaxKind.QuestionQuestionEqualsToken)
    return !nullish && knownPresent(value);
  const truth = nullish ? false : knownTruth(value);
  const skipWhenTruthy = node.operatorToken.kind === SyntaxKind.BarBarEqualsToken;
  return truth === skipWhenTruthy;
}

/**
 * A fixed index in a literal that a `const` variable is written with keeps a missing entry distinct
 * from an opaque value. No other binding is trusted with its initializer: a parameter's is the
 * default a call that passes nothing gives, a `var` can be declared again with another one, a `let`
 * can be written again, and a name in a pattern takes a part of its source.
 */
function initialSlot(
  node: BinaryExpression,
  root: FrameBinding,
): { readonly value: Expression | undefined } | undefined {
  const target = unwrapped(node.left);
  const initializer = isIdentifier(root.name) ? constantInitializer(root) : undefined;
  if (initializer === undefined || !isElementAccessExpression(target)) return undefined;
  const key = constantValue(unwrapped(target.argumentExpression));
  const index = typeof key === 'string' && /^(?:0|[1-9]\d*)$/u.test(key) ? Number(key) : key;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return undefined;
  const array = unwrapped(initializer);
  if (!isArrayLiteralExpression(array) || array.elements.some((each) => isSpreadElement(each)))
    return undefined;
  const value = array.elements[index];
  return { value: value === undefined || isOmittedExpression(value) ? undefined : value };
}

/**
 * Whether an importing module can write to the array `root` before the assignment runs: the module
 * exports it where it is declared, and the assignment is in a body that runs later.
 */
function exportedBefore(node: BinaryExpression, root: FrameBinding): boolean {
  return exportedDeclaration(root) && executionOwner(node) !== executionOwner(root);
}

/** Prior uses or referenced deferred uses lose the initial slot; whole const aliases retain it. */
function unchangedBefore(
  read: BinaryExpression,
  root: FrameBinding,
  sameArray: (value: Expression) => boolean,
): boolean {
  const pending: Node[] = [read.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isIdentifier(node) &&
      (!isVariableDeclaration(node.parent) || node.parent.name !== node) &&
      readsBinding(node) &&
      sameArray(node) &&
      canPrecede(node, read, root) &&
      !wholeAlias(node)
    )
      return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/**
 * The right side and the test are skipped as a unit; the target, whose receiver and key are
 * evaluated before the slot is tested, is not. Later iterations and referenced owners remain
 * possible, and so does a computed key of a class, written after the assignment in one of its
 * static initializers, which runs before it.
 */
function canPrecede(node: Node, read: BinaryExpression, root: FrameBinding): boolean {
  const target = inTarget(node, read);
  if (!target && node.pos >= read.pos && node.end <= read.end) return false;
  if (!framedPossibleBranch(node)) return false;
  const owner = executionOwner(read);
  const writer = executionOwner(node);
  return writer === owner
    ? target ||
        node.pos < read.pos ||
        destructuredFirst(node, read) ||
        ownerKeyFirst(node, read) ||
        repeatedFrameRead(node, read, root, owner) ||
        repeatsAround(owner, root)
    : !unreferencedLocalFunction(writer, owner);
}

/**
 * Whether `node` is in what the assignment evaluates of its target before it tests the slot — the
 * receiver and the key — but not the receiver's own name, which hands the array to nothing.
 */
function inTarget(node: Node, read: BinaryExpression): boolean {
  const { left } = read;
  if (node.pos < left.pos || node.end > left.end) return false;
  const target = unwrapped(left);
  if (!isElementAccessExpression(target)) return false;
  let receiver: Expression = unwrapped(target.expression);
  for (let next = commaResult(receiver); next !== undefined; next = commaResult(receiver))
    receiver = next;
  return node !== receiver;
}

/** What a comma expression comes to: its last operand. */
function commaResult(value: Expression): Expression | undefined {
  return isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.CommaToken
    ? unwrapped(value.right)
    : undefined;
}

/** A whole constant alias does not read or replace any stored array entry. */
function wholeAlias(node: Expression): boolean {
  const { parent } = useOf(node);
  return (
    isVariableDeclaration(parent) &&
    isIdentifier(parent.name) &&
    isVariableDeclarationList(parent.parent) &&
    /^const\s/u.test(parent.parent.getText(parent.getSourceFile())) &&
    parent.initializer !== undefined &&
    unwrapped(parent.initializer) === node
  );
}

/** Direct object-producing syntax and primitive literals are present, without inferring an input's shape. */
function knownPresent(value: Expression | undefined): boolean {
  return value !== undefined && (knownObject(value) || knownTruth(value) !== undefined);
}

/** Written primitives and object-producing syntax have fixed truthiness. */
function knownTruth(value: Expression | undefined): boolean | undefined {
  if (value === undefined) return false;
  return knownObject(value) ? true : framedCondition(value);
}

/** A source-written object-producing expression cannot be nullish or falsy. */
function knownObject(value: Expression): boolean {
  return (
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isNewExpression(value)
  );
}

/** Whole constant slot aliases retain their actual nullish value; opaque or cyclic names stay unknown. */
function logicalInitialValue(expression: Expression): Expression {
  let value = unwrapped(expression);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) break;
    const { binding } = selected;
    if (
      seen.has(binding) ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      binding.initializer === undefined ||
      !/^const\s/u.test(binding.parent.getText(binding.getSourceFile()))
    )
      break;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return value;
}

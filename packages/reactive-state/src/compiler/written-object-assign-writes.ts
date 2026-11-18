import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { readsBinding } from './scope.ts';
import { type GlobalWriteContext } from './written-apply-slots.ts';
import { asCallArguments, branchOperands, globalCallOf } from './written-arguments.ts';
import {
  type ArrayHolder,
  arrayHolderOf,
  classifyPropertyName,
  type HolderArrayWrites,
  isPrototypeSetterProperty,
  markHoldersShortened,
  recordOwnersWrite,
} from './written-array-aliases.ts';
import { projectMemberKeys, selectedInitialExpressions } from './written-slot-pushes.ts';

/**
 * Own enumerable object-property projection, array-source copying, and branch/binding leaf
 * expansion for `Object.assign` and descriptor-object writers.
 */

export const OBJECT_ASSIGN_PATH = 'Object.assign';

/** Projects own enumerable properties or iterable spreads copied by `Object.assign` from `root`. */
export function recordAssignSource(
  rootSource: Expression,
  owners: readonly ArrayHolder[],
  ctx: GlobalWriteContext,
): boolean {
  const pending: Expression[] = [rootSource];
  const seen = new Set<Expression>();
  let changed = false;
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const plain = unwrapped(current);
    const holder = isIdentifier(plain) && readsBinding(plain) ? arrayHolderOf(plain) : undefined;
    if (holder !== undefined && ctx.byHolder.has(holder)) {
      const didMutArr = recordOwnersWrite(
        owners,
        { index: undefined, spread: true, value: plain },
        ctx.byHolder,
      );
      changed ||= didMutArr;
    }
    for (const leaf of expandObjectLeaves(plain, seen)) {
      const didLeaf = recordAssignLeaf(leaf, owners, pending, ctx.byHolder);
      changed ||= didLeaf;
    }
  }
  return changed;
}

/** Expands `root` through branches, local variable bindings and nested `Object.assign` calls. */
export function expandObjectLeaves(root: Expression, seen: Set<Expression>): readonly Expression[] {
  const leaves: Expression[] = [];
  const pending: Expression[] = [root];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const plain = unwrapped(current);
    if (seen.has(plain)) {
      continue;
    }
    seen.add(plain);
    if (!stepExpandedObjectNode(plain, pending)) {
      leaves.push(plain);
    }
  }
  return leaves;
}

/** Value expressions read by `Get` from an own object-literal property. */
export function propertyValueExpressions(prop: ObjectLiteralElementLike): readonly Expression[] {
  if (isPropertyAssignment(prop)) {
    return [prop.initializer];
  }
  if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name)) {
    return [prop.name];
  }
  if (isGetAccessorDeclaration(prop) && prop.body !== undefined) {
    return returnedBy(prop);
  }
  return [];
}

/** Whether `leaf` is a primitive literal or unshadowed `undefined` with no object properties. */
export function isPrimitiveNonObjectLeaf(leaf: Expression): boolean {
  return (
    leaf.kind === SyntaxKind.NullKeyword ||
    leaf.kind === SyntaxKind.TrueKeyword ||
    leaf.kind === SyntaxKind.FalseKeyword ||
    isNumericLiteral(leaf) ||
    isStringLiteral(leaf) ||
    isNoSubstitutionTemplateLiteral(leaf) ||
    globalPathOf(leaf)?.join('.') === 'undefined'
  );
}

/** Applies a single expanded `Object.assign` source `leaf` (object literal, array literal, opaque). */
function recordAssignLeaf(
  leaf: Expression,
  owners: readonly ArrayHolder[],
  pending: Expression[],
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): boolean {
  if (isPrimitiveNonObjectLeaf(leaf)) {
    return false;
  }
  if (isObjectLiteralExpression(leaf)) {
    return recordAssignObjectLiteral(leaf, owners, pending, byHolder);
  }
  if (isArrayLiteralExpression(leaf)) {
    return recordAssignArrayLiteral(leaf, owners, byHolder);
  }
  const didShorten = markHoldersShortened(owners, byHolder);
  const didWrite = recordOwnersWrite(
    owners,
    { index: undefined, spread: true, value: leaf },
    byHolder,
  );
  return didShorten || didWrite;
}

/** Projects own enumerable properties of an `ObjectLiteralExpression` copied by `Object.assign`. */
function recordAssignObjectLiteral(
  literal: ObjectLiteralExpression,
  owners: readonly ArrayHolder[],
  pending: Expression[],
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): boolean {
  let changed = false;
  for (const prop of literal.properties) {
    if (isSpreadAssignment(prop)) {
      pending.push(prop.expression);
      continue;
    }
    if (isPrototypeSetterProperty(prop)) {
      continue;
    }
    const keyInfo = classifyPropertyName(prop.name);
    if (keyInfo.mayBeLength) {
      const didShorten = markHoldersShortened(owners, byHolder);
      changed ||= didShorten;
    }
    if (keyInfo.mayBeIndex) {
      for (const valExpr of propertyValueExpressions(prop)) {
        const didVal = recordOwnersWrite(
          owners,
          { index: keyInfo.index, spread: false, value: valExpr },
          byHolder,
        );
        changed ||= didVal;
      }
    }
  }
  return changed;
}

/** Projects indexed elements of an `ArrayLiteralExpression` source copied by `Object.assign`. */
function recordAssignArrayLiteral(
  literal: ArrayLiteralExpression,
  owners: readonly ArrayHolder[],
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): boolean {
  let changed = false;
  let idx = 0;
  let shifted = false;
  for (const arg of asCallArguments(literal.elements)) {
    if (arg.spread) {
      shifted = true;
      const didSpread = recordOwnersWrite(
        owners,
        { index: undefined, spread: true, value: arg.expression },
        byHolder,
      );
      changed ||= didSpread;
    } else {
      if (arg.expression.kind !== SyntaxKind.OmittedExpression) {
        const didElem = recordOwnersWrite(
          owners,
          { index: shifted ? undefined : idx, spread: false, value: arg.expression },
          byHolder,
        );
        changed ||= didElem;
      }
      idx += 1;
    }
  }
  return changed;
}

/** Pushes child expressions onto `pending` when `plain` is a branch, binding or `Object.assign`. */
function stepExpandedObjectNode(plain: Expression, pending: Expression[]): boolean {
  const branches = branchOperands(plain);
  if (branches !== undefined) {
    pending.push(...branches);
    return true;
  }
  if (isIdentifier(plain) && readsBinding(plain) && expandIdentifierBinding(plain, pending)) {
    return true;
  }
  if (isCallExpression(plain) && globalCallOf(plain)?.path === OBJECT_ASSIGN_PATH) {
    for (const arg of plain.arguments) {
      pending.push(isSpreadElement(arg) ? arg.expression : arg);
    }
    return true;
  }
  return false;
}

/** Pushes initializers and reassignments of `ident` onto `pending`, answering whether any exist. */
function expandIdentifierBinding(ident: Identifier, pending: Expression[]): boolean {
  const selected = frameBindingOf(ident);
  const initials = selected === undefined ? [] : selectedInitialExpressions(ident, selected);
  const assigned = framedAssignedSources(ident).flatMap((src) =>
    projectMemberKeys(src.value, src.keys),
  );
  if (initials.length === 0 && assigned.length === 0) {
    return false;
  }
  pending.push(...initials, ...assigned);
  return true;
}

import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isForOfStatement,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPath } from './global-answers.ts';
import { readsOf } from './local-module-reads.ts';
import { standsInRepeatableScope } from './local-write-arithmetic.ts';
import { ASSIGNING, handedTo, isConstList, isWrapping, memberChain } from './local-write-paths.ts';
import { writesOf } from './local-writes.ts';
import { bindingIdentifiers, withinFunction } from './scope.ts';

/**
 * Where the walk of a parameter's reads (`writesOf`) stops reading what the parameter holds. It reads
 * a write through the parameter's own name, through a `const` the name is taken into and through a
 * name a pattern or a loop binds of it. A parameter the function keeps anywhere else is written
 * through a name the walk does not read; one a call locks before a write is written where it
 * throws. The object the parameter holds is then no object the compile reads (`Target.isHeld`), and
 * a write into it is a change, as it was of any parameter.
 */

/** The operators whose answer is one of their operands: `a || b`, `a && b`, `a ?? b`, `a, b`. */
const CARRYING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.CommaToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * The calls of the language that make an object refuse writes: a frozen, a sealed and a
 * non-extensible object throws where code in a module writes a member it no longer takes.
 */
const LOCKING: ReadonlySet<string> = new Set([
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'Reflect.defineProperty',
  'Reflect.preventExtensions',
]);

/** How `writesOf` reads the function (its `Walk`): the reads it counts are `reads`. */
type Walk = Parameters<typeof writesOf>[2];

/**
 * Whether the parameter `declared` of `fn` holds the object the compile reads of it at each read the
 * walk counts (`Target.isHeld`): the function keeps it nowhere the walk does not follow (`isKept`),
 * and no call of `LOCKING` is handed it before a write into it, which then throws. A lock counts as
 * before every write where it stands in a loop or in a function the code calls, which run it again
 * or later than where it stands; otherwise as before the writes that follow it in the function, the
 * writes of functions the code calls among them. A lock after the last write is no lock.
 */
export function holdsStill(fn: Answering, declared: Identifier, walk: Walk): boolean {
  const isCounted = (name: Identifier): boolean => walk.reads?.(name) !== false;
  const found = readsScanned(fn, declared, isCounted);
  if (found.isKept) {
    return false;
  }
  if (found.locks.length === 0) {
    return true;
  }
  // A lock in a loop or in a function the code calls runs again, or later, than where it stands.
  const from = Math.min(
    ...found.locks.map((lock) => (standsInRepeatableScope(lock, fn) ? fn.pos : lock.end)),
  );
  const isAfter = (name: Identifier): boolean => {
    return (
      isCounted(name) &&
      (name.pos >= from || withinFunction(name, fn) || namesOf(memberChain(name).top).length > 0)
    );
  };
  const written = writesOf(declared, undefined, { ...walk, reads: isAfter });
  return !written.changes && written.values.length === 0;
}

/** What a walk of the reads of a parameter and of the `const` names it is taken into found. */
interface Scanned {
  /** Whether a read of it goes where no read of it is followed (`isKept`). */
  readonly isKept: boolean;
  /** The calls of `LOCKING` that are handed it, or a member of it, as the object they lock. */
  readonly locks: readonly CallExpression[];
}

/** Reads `isCounted` tells, of `declared` and of the `const` names it is taken into. */
function readsScanned(
  fn: Answering,
  declared: Identifier,
  isCounted: (name: Identifier) => boolean,
): Scanned {
  const holders = [readsOf(declared, fn)];
  const seen = new Set<Identifier>([declared]);
  const locks: CallExpression[] = [];
  const place = { fn, isHolder: (node: Node) => holders.some((isRead) => isRead(node)) };
  for (const isRead of holders) {
    const visit = (node: Node): boolean => {
      if (isRead(node) && isCounted(node)) {
        const { top } = memberChain(node);
        if (isKept(top, place)) {
          return true;
        }
        for (const name of namesOf(top)) {
          if (!seen.has(name)) {
            seen.add(name);
            holders.push(readsOf(name, fn));
          }
        }
        const lock = lockedBy(top);
        if (lock !== undefined) {
          locks.push(lock);
        }
      }
      return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
    };
    if (fn.forEachChild((child) => (visit(child) ? true : undefined)) === true) {
      return { isKept: true, locks };
    }
  }
  return { isKept: false, locks };
}

/** The call of `LOCKING` that `top` is the first argument of: the object it locks. */
function lockedBy(top: Expression): CallExpression | undefined {
  const call = handedTo(top);
  if (call === undefined || !isCallExpression(call) || call.arguments[0] !== top) {
    return undefined;
  }
  const path = globalPath(unwrapped(call.expression));
  return path !== undefined && LOCKING.has(path.join('.')) ? call : undefined;
}

/** The `const` names that `top`, a read, is taken into: a declaration's, a loop head's. */
function namesOf(top: Expression): readonly Identifier[] {
  const { parent } = top;
  if (isVariableDeclaration(parent) && parent.initializer === top && isConstList(parent.parent)) {
    return bindingIdentifiers(parent.name);
  }
  if (
    isForOfStatement(parent) &&
    parent.expression === top &&
    isVariableDeclarationList(parent.initializer) &&
    isConstList(parent.initializer)
  ) {
    return parent.initializer.declarations.flatMap((each) => bindingIdentifiers(each.name));
  }
  return [];
}

/** Whether `parent` hands the value of `node` on as its own value or holds it in a value it makes. */
function carries(parent: Node, node: Node): boolean {
  if (isConditionalExpression(parent)) {
    return parent.condition !== node;
  }
  if (isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    return CARRYING.has(operator) && !(operator === SyntaxKind.CommaToken && parent.left === node);
  }
  return (
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isShorthandPropertyAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === node)
  );
}

/** Where a read stands: the function, and whether a name is one the walk reads of the parameter. */
interface Place {
  readonly fn: Answering;
  readonly isHolder: (node: Node) => boolean;
}

/**
 * Whether the value of a read `top` goes where no read of it is followed. A value that only passes
 * through a condition, `||`, a list or an object (`isIndirect`) goes on to what holds that, which
 * the walk does not read, unless it is answered by the function itself. A value that stands alone is
 * followed where it is handed to a call, taken into a `const` or written to; an assignment of it
 * to a member, a field and a default are not. An assignment into the parameter itself
 * (`value.copy = value.id`) is a write the walk reads.
 */
function isKept(top: Expression, place: Place): boolean {
  let node: Node = top;
  let isIndirect = false;
  for (;;) {
    const { parent } = node;
    if (isWrapping(parent, node)) {
      node = parent;
    } else if (carries(parent, node)) {
      isIndirect = true;
      node = parent;
    } else if (isReturnStatement(parent) || (isArrowFunction(parent) && parent.body === node)) {
      return withinFunction(node, place.fn);
    } else if (isExpressionStatement(parent) || isAssignedInto(parent, node, place)) {
      return false;
    } else {
      return isIndirect || isStoredAs(parent, node);
    }
  }
}

/** Whether `parent` assigns `node` to a member of what the walk reads of the parameter. */
function isAssignedInto(parent: Node, node: Node, place: Place): boolean {
  if (
    !isBinaryExpression(parent) ||
    parent.right !== node ||
    !ASSIGNING.has(parent.operatorToken.kind)
  ) {
    return false;
  }
  let target = unwrapped(parent.left);
  while (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
    target = unwrapped(target.expression);
  }
  return place.isHolder(target);
}

/** Whether `parent` stores the value of `node`, which stands alone, where the walk reads no write. */
function isStoredAs(parent: Node, node: Node): boolean {
  if (isBinaryExpression(parent)) {
    return parent.right === node && ASSIGNING.has(parent.operatorToken.kind);
  }
  if (isPropertyDeclaration(parent) || isParameterDeclaration(parent) || isBindingElement(parent)) {
    const { initializer } = parent;
    return initializer !== undefined && initializer === node;
  }
  return false;
}

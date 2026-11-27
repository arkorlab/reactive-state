import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isCaseClause,
  isConditionalExpression,
  isDoStatement,
  isElementAccessExpression,
  isExpressionStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isIfStatement,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSwitchStatement,
  isTemplateSpan,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  isWhileStatement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, givenAt, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPath } from './global-answers.ts';
import { readsOf } from './local-module-reads.ts';
import { standsInRepeatableScope } from './local-write-arithmetic.ts';
import { functionsOf, type ResolvedCallable } from './local-write-callbacks.ts';
import {
  ASSIGNING,
  handedTo,
  isConstList,
  isWrapping,
  memberChain,
  UPDATING,
} from './local-write-paths.ts';
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
  const found = readsScanned(fn, declared, { isCounted, walk });
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
  { isCounted, walk }: { readonly isCounted: (name: Identifier) => boolean; readonly walk: Walk },
): Scanned {
  const holders = [readsOf(declared, fn)];
  const locks: CallExpression[] = [];
  const place: Place = {
    callables: (callee) => functionsOf(callee, walk.calls, walk.resolve),
    fn,
    isHolder: (node) => holders.some((isRead) => isRead(node)),
  };
  const isKeptSomewhere = followReads(
    fn,
    declared,
    { holders, isCounted, isMembers: true },
    ({ top }) => {
      if (isKept(top, place)) {
        return true;
      }
      const lock = lockedBy(top);
      if (lock !== undefined) {
        locks.push(lock);
      }
      return false;
    },
  );
  return { isKept: isKeptSomewhere, locks };
}

/** A read of a name, and the member it reads of it: the keys, and where the member chain ends. */
type Read = ReturnType<typeof memberChain>;

/**
 * Asks `onRead` of each read of `declared` in `fn` that `isCounted` tells, and of each read of a
 * `const` name it is taken into (`holders`, which grows with them; a name taken of a member of it
 * only where `isMembers`), until it says to stop. Whether it did.
 */
function followReads(
  fn: Answering,
  declared: Identifier,
  {
    holders,
    isCounted = () => true,
    isMembers,
  }: {
    readonly holders: ReturnType<typeof readsOf>[];
    readonly isCounted?: (name: Identifier) => boolean;
    readonly isMembers: boolean;
  },
  onRead: (read: Read) => boolean,
): boolean {
  const seen = new Set<Identifier>([declared]);
  for (const isRead of holders) {
    const visit = (node: Node): boolean => {
      if (isRead(node) && isCounted(node)) {
        const read = memberChain(node);
        if (onRead(read)) {
          return true;
        }
        const names = isMembers || read.keys.length === 0 ? namesOf(read.top) : [];
        for (const name of names) {
          if (!seen.has(name)) {
            seen.add(name);
            holders.push(readsOf(name, fn));
          }
        }
      }
      return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
    };
    if (fn.forEachChild((child) => (visit(child) ? true : undefined)) === true) {
      return true;
    }
  }
  return false;
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

/**
 * Where a read stands: the function, whether a name is one the walk reads of the parameter, and the
 * functions of the code that a call's callee names.
 */
interface Place {
  readonly callables: (callee: Expression) => readonly ResolvedCallable[];
  readonly fn: Answering;
  readonly isHolder: (node: Node) => boolean;
}

/**
 * Whether the value of a read `top` goes where no read of it is followed. A value that only passes
 * through a condition, `||`, a list or an object (`isIndirect`) goes on to what holds that, which
 * the walk does not read, unless it is answered by the function itself or only read there
 * (`isConsulted`: a condition, a comparison). A value that stands alone is followed where it is
 * handed to a call, taken into a `const` or written to; an assignment of it to a member, a field
 * and a default are not. An assignment into the parameter itself (`value.copy = value.id`) is a
 * write the walk reads. A value that stands alone and is handed to a function of the code that
 * answers it (`isAnswered`) is kept where its answer is: the name the answer is taken into is one
 * the walk does not read. `isResult` asks it of a value that is an answer already.
 */
function isKept(top: Expression, place: Place, isResult = false): boolean {
  let node: Node = top;
  let isIndirect = isResult;
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
      return isIndirect
        ? !isConsulted(parent, node)
        : isStoredAs(parent, node) || isAnswered(top, place);
    }
  }
}

/**
 * Whether `top`, a value that stands alone, is handed to a function of the code that answers what it
 * is handed (`returnsParameter`) and its answer is kept (`isKept`): `const alias = identity(value)`
 * names the parameter by a name the walk does not read of it.
 */
function isAnswered(top: Expression, place: Place): boolean {
  const call = handedTo(top);
  if (call === undefined || !isCallExpression(call)) {
    return false;
  }
  const callables = place.callables(unwrapped(call.expression));
  return (
    callables.some((callable) => answersGiven(callable, call, top)) && isKept(call, place, true)
  );
}

/** Whether `callable`, called as `call` does, answers the parameter that `top` is passed at. */
function answersGiven(callable: ResolvedCallable, call: CallExpression, top: Expression): boolean {
  const given =
    callable.offset === 0
      ? call.arguments
      : [...Array.from({ length: callable.offset }, () => call.expression), ...call.arguments];
  return parametersOf(callable.fn).some((parameter, index) => {
    const isGiven = callable.anyIndex
      ? index >= callable.offset
      : givenAt(given, callable.fn, index).includes(top);
    return isGiven && isIdentifier(parameter.name) && returnsParameter(callable.fn, parameter.name);
  });
}

/** Whether a function answers the parameter, once where no cycle shaped it: by its parameter name. */
const ANSWERS = new WeakMap<Identifier, boolean>();

/**
 * Whether `fn` answers the parameter `declared` as it is: a `return`, or the body of an arrow, that
 * a read of the whole of it, or of a `const` name it is taken into, reaches alone or through a
 * condition, `||`, `&&`, `??`, a list or an object. An answer of a member of it, or of what a call
 * of another function answers of it, is not read.
 */
function returnsParameter(fn: Answering, declared: Identifier): boolean {
  const known = ANSWERS.get(declared);
  if (known !== undefined) {
    return known;
  }
  const found = followReads(
    fn,
    declared,
    { holders: [readsOf(declared, fn)], isMembers: false },
    ({ keys, top }) => keys.length === 0 && isReturned(top, fn),
  );
  ANSWERS.set(declared, found);
  return found;
}

/** Whether the value of `top`, alone or carried (`carries`), is what the function `fn` returns. */
function isReturned(top: Expression, fn: Answering): boolean {
  let node: Node = top;
  for (;;) {
    const { parent } = node;
    if (!isWrapping(parent, node) && !carries(parent, node)) {
      return (
        (isReturnStatement(parent) || (isArrowFunction(parent) && parent.body === node)) &&
        !withinFunction(node, fn)
      );
    }
    node = parent;
  }
}

/**
 * Whether `parent` only reads the value of `node` and keeps nothing of it: a condition (`if`,
 * `while`, `do`, `for`, `switch`, a case, `?:`), a `!`, a `typeof`, a sign, an operator that answers
 * a new value (a comparison, an arithmetic, `in`), the left of a comma, an element's key, a
 * template's substitution. An assignment keeps what it assigns, and a member read of it writes.
 */
function isConsulted(parent: Node, node: Node): boolean {
  if (isConditionalExpression(parent)) {
    return parent.condition === node;
  }
  if (isForStatement(parent)) {
    return parent.condition !== undefined && parent.condition === node;
  }
  if (
    isIfStatement(parent) ||
    isWhileStatement(parent) ||
    isDoStatement(parent) ||
    isSwitchStatement(parent) ||
    isCaseClause(parent)
  ) {
    return parent.expression === node;
  }
  if (isBinaryExpression(parent)) {
    return !ASSIGNING.has(parent.operatorToken.kind);
  }
  if (isElementAccessExpression(parent)) {
    return parent.argumentExpression === node;
  }
  return (
    isTypeOfExpression(parent) ||
    isVoidExpression(parent) ||
    isTemplateSpan(parent) ||
    (isPrefixUnaryExpression(parent) && !UPDATING.has(parent.operator))
  );
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

import {
  type CallExpression,
  type ClassElement,
  type ClassLikeDeclaration,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralElementLike,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { declarationOf, type Declared, initializerOf } from './framed.ts';
import { isIterator } from './iterators.ts';
import { keptAliasOf } from './kept-aliases.ts';
import {
  declares,
  extendWatchedDeclarations,
  type HolderGraph,
  holderGraphIn,
  isCalledAsLoads,
  isCalledInPlace,
  isCodeAt,
  isFunctionCode,
  isWithin,
  type WatchState,
  type WrittenBy,
} from './kept-scopes.ts';
import { readsBinding } from './scope.ts';

export { rootOf, targetsOf } from './kept-scopes.ts';

/**
 * What a shared module holds once, as it loads, which a function of its may write between calls
 * (`settled.ts`): a name its top level declares or imports, a global's, one a function it calls in
 * place there declares — and one a function it calls there by its name declares, which a function
 * that call answers writes: `n` of `const next = makeCounter()`, of `function makeCounter() { let n
 * = 0; return () => ++n; }`, whose call the module keeps.
 */

/** The operators of which what stands on either side may be what they answer: `||`, `&&`, `??`. */
const EITHER: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** What `handedOut` finds within a function: the functions what it answers holds, the names followed. */
interface Handing {
  readonly fn: Node;
  readonly followed: Set<Node>;
  readonly graph: HolderGraph;
  readonly handed: Set<Node>;
  readonly watchState: WatchState;
}

/** Whether `node` runs each time a function the module declares is called, not once as it loads. */
export function runsPerCall(node: Node): boolean {
  let child = node;
  for (let at = node.parent; !isSourceFile(at); at = at.parent) {
    if (isCodeAt(at, child) && !isCalledInPlace(at)) {
      return true;
    }
    child = at;
  }
  return false;
}

/**
 * Whether `name` names what the module holds once, as it loads: a name its top level declares or
 * imports, one a function it calls in place there declares, or a global's; or one of a function the
 * module keeps a call of, written by a function that call answers (`keepsCall`) — none of a
 * function's own otherwise, which each call declares anew.
 */
export function isKept(name: Identifier, writtenBy: WrittenBy): boolean {
  const seen = new Set<Identifier>();
  let current: Identifier | undefined = name;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (directlyKept(current, writtenBy)) return true;
    current = keptAliasOf(current);
  }
  return false;
}

/** Whether the module itself keeps this binding, before considering a constant receiver alias. */
function directlyKept(name: Identifier, writtenBy: WrittenBy): boolean {
  // The function within the one that declares the name that holds where it is written, if any.
  let inner: Node | undefined;
  let child: Node = name;
  for (let at: Node = name.parent; !isSourceFile(at); at = at.parent) {
    const code = isCodeAt(at, child);
    child = at;
    if (!code) {
      continue;
    }
    if (declares(at, name)) {
      return (
        (isCalledInPlace(at) && !runsPerCall(at)) ||
        (inner !== undefined && keepsCall({ fn: at, inner, writtenBy }))
      );
    }
    inner = at;
  }
  return true;
}

/**
 * Whether the module keeps a call of `fn` whose names `inner`, a function within it, writes: `fn`
 * called by its name as the module loads (`isCalledAsLoads`), answering `inner`, or what reads it
 * (`handedOut`) — which outlives the call, and each call of it writes what the call declared.
 */
function keepsCall({
  fn,
  inner,
  writtenBy,
}: {
  readonly fn: Node;
  readonly inner: Node;
  readonly writtenBy: WrittenBy;
}): boolean {
  return handedOut(fn, writtenBy).has(inner) && isCalledAsLoads(fn);
}

/**
 * The functions within `fn` that what it answers holds — `() => ++n` of `return () => ++n`, the
 * methods of an object or a class it answers, one of its own it answers by its name — and those of
 * its own they read by name, in turn.
 */
function handedOut(fn: Node, writtenBy: WrittenBy): ReadonlySet<Node> {
  const graph = holderGraphIn(fn, writtenBy);
  const handing: Handing = {
    fn,
    followed: new Set(),
    graph,
    handed: new Set(),
    watchState: { aliasWalked: new Set(), watched: new Set() },
  };
  for (const answer of answersOf(fn)) {
    hold(answer, handing);
  }
  // What a function handed out reads by name is handed out with it: `bump` of `() => bump()`.
  for (const each of handing.handed) {
    const visit = (node: Node): void => {
      if (isIdentifier(node)) {
        holdDeclared(node, handing);
      }
      node.forEachChild(visit);
    };
    visit(each);
  }
  return handing.handed;
}

/** What `fn` answers: its arrow's expression, or what its own `return`s give — none of a function's within it. */
export function answersOf(fn: Node): readonly Expression[] {
  if (isArrowFunction(fn) && !isBlock(fn.body)) {
    return [fn.body];
  }
  const answers: Expression[] = [];
  const visit = (node: Node): void => {
    if (node !== fn && isFunctionCode(node)) {
      return;
    }
    if (isReturnStatement(node) && node.expression !== undefined) {
      answers.push(node.expression);
    }
    node.forEachChild(visit);
  };
  visit(fn);
  return answers;
}

/** Adds to `handing` the functions within its function that `node`, what it answers, holds. */
function hold(node: Expression, handing: Handing): void {
  const value = unwrapped(node);
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    handing.handed.add(value);
  } else if (isClassExpression(value)) {
    holdMembers(value.members, handing);
  } else if (isNewExpression(value)) {
    holdInstance(value.expression, handing);
  } else if (isObjectLiteralExpression(value)) {
    holdMembers(value.properties, handing);
  } else if (isArrayLiteralExpression(value)) {
    for (const element of value.elements) {
      hold(isSpreadElement(element) ? element.expression : element, handing);
    }
  } else if (isConditionalExpression(value)) {
    hold(value.whenTrue, handing);
    hold(value.whenFalse, handing);
  } else if (isBinaryExpression(value) && EITHER.has(value.operatorToken.kind)) {
    hold(value.left, handing);
    hold(value.right, handing);
  } else if (isIdentifier(value)) {
    holdDeclared(value, handing);
  }
}

/** A returned instance retains its callable members, after its constructor and field values ran. */
function holdInstance(expression: Expression, handing: Handing): void {
  const owner = constructedClass(expression);
  if (owner === undefined || !isWithin(owner, handing.fn)) {
    return;
  }
  for (const member of owner.members) {
    if (
      isMethodDeclaration(member) ||
      isGetAccessorDeclaration(member) ||
      isSetAccessorDeclaration(member)
    ) {
      if (
        member.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) !== true
      ) {
        handing.handed.add(member);
      }
    } else if (
      isPropertyDeclaration(member) &&
      member.initializer !== undefined &&
      member.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) !== true
    ) {
      const before = handing.handed.size;
      hold(member.initializer, handing);
      if (handing.handed.size > before) {
        handing.handed.add(member);
      }
    }
  }
}

/** A directly constructed local class, past lexical aliases, without executing a factory. */
function constructedClass(expression: Expression): ClassLikeDeclaration | undefined {
  const seen = new Set<Node>();
  let value = unwrapped(expression);
  for (;;) {
    if (isClassExpression(value)) {
      return value;
    }
    if (!isIdentifier(value)) {
      return undefined;
    }
    const declared = declarationOf(value);
    if (declared === undefined || seen.has(declared)) {
      return undefined;
    }
    seen.add(declared);
    if (isClassDeclaration(declared)) {
      return declared;
    }
    if (isFunctionDeclaration(declared) || declared.initializer === undefined) {
      return undefined;
    }
    value = unwrapped(declared.initializer);
  }
}

/** Adds to `handing` the functions of `members`: an object's entries, a class's members. */
function holdMembers(
  members: readonly (ClassElement | ObjectLiteralElementLike)[],
  handing: Handing,
): void {
  for (const member of members) {
    if (isFunctionCode(member)) {
      handing.handed.add(member);
    } else if (
      (isPropertyAssignment(member) || isPropertyDeclaration(member)) &&
      member.initializer !== undefined
    ) {
      hold(member.initializer, handing);
    } else if (isShorthandPropertyAssignment(member) && isIdentifier(member.name)) {
      hold(member.name, handing);
    } else if (isSpreadAssignment(member)) {
      hold(member.expression, handing);
    }
  }
}

/**
 * Adds to `handing` what `name` is declared of within its function (`declarationOf`): a function, a
 * class's members, what a variable holds — of its value, and what the function writes into it.
 */
function holdDeclared(name: Identifier, handing: Handing): void {
  const declared = declarationOf(name);
  if (declared === undefined || handing.followed.has(declared) || !isWithin(declared, handing.fn)) {
    return;
  }
  handing.followed.add(declared);
  if (isFunctionDeclaration(declared)) {
    handing.handed.add(declared);
  } else if (isClassDeclaration(declared)) {
    holdMembers(declared.members, handing);
  } else {
    if (declared.initializer !== undefined) {
      hold(declared.initializer, handing);
    }
    holdWritten(declared, handing);
  }
}

/**
 * Adds to `handing` what its function writes into what `declared`, a variable of its, holds (as
 * `writtenBy` says a node writes): what it assigns to a member of it, `store.next = () => ++n`, and
 * what it hands a method or a global's function that changes it, `handlers.push(() => ++n)`.
 */
function holdWritten(declared: Declared, handing: Handing): void {
  const newlyWatched = extendWatchedDeclarations(declared, handing.graph, handing.watchState);
  for (const owner of newlyWatched) {
    const values = handing.graph.writes.get(owner);
    if (values === undefined) {
      continue;
    }
    for (const value of values) {
      hold(value, handing);
    }
  }
}

/**
 * Whether `node`, a name a function of the module's reads, names an iterator the module makes as it
 * loads — `const ids = [1, 2].values()`, a generator's, `const counts = count()` — which each read of
 * it there may advance: `ids.next()`, `[...ids]`, `for (… of ids)`, `Array.from(ids)`.
 */
export function readsKeptIterator(node: Node, writtenBy: WrittenBy): boolean {
  if (!isIdentifier(node) || !readsBinding(node)) {
    return false;
  }
  // What it is declared of first, which few names are of an iterator; whether the module keeps it
  // last, which looks through the functions around it.
  const declared = initializerOf(node);
  return (
    declared !== undefined &&
    isIterator(declared, followed, isGeneratorCall) &&
    runsPerCall(node) &&
    isKept(node, writtenBy)
  );
}

/** `node` past what wraps it, a name followed to what the variable it names is declared of, in turn. */
function followed(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = initializerOf(value);
    if (declared === undefined) {
      break;
    }
    value = unwrapped(declared);
  }
  return value;
}

/** Whether `call` calls a generator the module declares by its name: `function* count() { … }`. */
function isGeneratorCall(call: CallExpression): boolean {
  const callee = unwrapped(call.expression);
  const declared = isIdentifier(callee) ? declarationOf(callee) : undefined;
  if (declared === undefined || isClassDeclaration(declared)) {
    return false;
  }
  if (isFunctionDeclaration(declared)) {
    return declared.asteriskToken !== undefined;
  }
  const value = declared.initializer === undefined ? undefined : unwrapped(declared.initializer);
  return value !== undefined && isFunctionExpression(value) && value.asteriskToken !== undefined;
}

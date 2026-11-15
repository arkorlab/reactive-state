import {
  type BindingName,
  type CallExpression,
  type ClassElement,
  type ClassLikeDeclaration,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { declarationOf, type Declared, initializerOf } from './framed.ts';
import { isIterator } from './iterators.ts';
import { keptAliasOf } from './kept-aliases.ts';
import { startupField } from './kept-fields.ts';
import { bindingIdentifiers, freeReads, hoistedIn, readsBinding } from './scope.ts';

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

const FREE_READS = new WeakMap<Node, ReadonlySet<Identifier>>();

/** What a node writes into, where it writes: what it assigns, counts up, deletes, changes in place. */
type WrittenBy = (node: Node) => Node | undefined;

/** What `handedOut` finds within a function: the functions what it answers holds, the names followed. */
interface Handing {
  readonly fn: Node;
  readonly handed: Set<Node>;
  readonly followed: Set<Node>;
  readonly writtenBy: WrittenBy;
}

/** Whether `node` runs anew for a call or instance: a function or an instance field's initializer. */
function isFunctionCode(node: Node): boolean {
  return (
    isArrowFunction(node) ||
    isFunctionExpression(node) ||
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isInstanceField(node)
  );
}

/** An instance field's initializer runs at construction; its computed key runs at class definition. */
function isInstanceField(node: Node): node is PropertyDeclaration {
  return (
    isPropertyDeclaration(node) &&
    node.initializer !== undefined &&
    node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) !== true
  );
}

/** Whether `child` belongs to deferred code rather than the field's class-definition expressions. */
function isCodeAt(node: Node, child: Node): boolean {
  return (
    isFunctionCode(node) &&
    (!isPropertyDeclaration(node) || (Object.is(node.initializer, child) && !startupField(node)))
  );
}

/** Parentheses, type assertions and `!` preserve the runtime expression they wrap. */
function isTypeWrapper(node: Node): node is Node & { readonly expression: Expression } {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isNonNullExpression(node)
  );
}

/** Whether `fn`, a function, is called where it is written, once: `(() => { … })()`. */
function isCalledInPlace(fn: Node): boolean {
  let at = fn;
  while (isTypeWrapper(at.parent)) at = at.parent;
  const call = at.parent;
  return isCallExpression(call) && call.expression === at;
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
  const handing: Handing = { fn, followed: new Set(), handed: new Set(), writtenBy };
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
  const visit = (node: Node): void => {
    const written = handing.writtenBy(node);
    const writes = (written === undefined ? [] : targetsOf(written)).some((target) => {
      const root = rootOf(target);
      return root !== undefined && declarationOf(root) === declared;
    });
    if (writes) {
      if (isBinaryExpression(node)) {
        hold(node.right, handing);
      } else if (isCallExpression(node)) {
        for (const each of node.arguments) {
          hold(isSpreadElement(each) ? each.expression : each, handing);
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(handing.fn);
}

/**
 * What `node`, what an assignment or a loop writes into, writes into each: of a pattern, each of its
 * targets, in turn — `[n] = [n + 1]`, `({ a: kept.x } = value)`, a default's, `[n = 0] = …`, a
 * rest's — of anything else, itself.
 */
export function targetsOf(node: Node): readonly Node[] {
  let target = node;
  while (isTypeWrapper(target)) target = target.expression;
  if (isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element) =>
      targetsOf(isSpreadElement(element) ? element.expression : element),
    );
  }
  if (isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property): readonly Node[] => {
      if (isPropertyAssignment(property)) {
        return targetsOf(property.initializer);
      }
      if (isShorthandPropertyAssignment(property)) {
        return [property.name];
      }
      return isSpreadAssignment(property) ? targetsOf(property.expression) : [];
    });
  }
  return isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken
    ? targetsOf(target.left)
    : [target];
}

/** The name `node` is of, past the members it reads and what wraps it: `cache` of `cache[key].x`. */
export function rootOf(node: Node): Identifier | undefined {
  let each = node;
  while (
    isPropertyAccessExpression(each) ||
    isElementAccessExpression(each) ||
    isTypeWrapper(each)
  ) {
    each = each.expression;
  }
  return isIdentifier(each) && readsBinding(each) ? each : undefined;
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

/** Whether `node` stands within `fn`. */
function isWithin(node: Node, fn: Node): boolean {
  for (let at: Node = node.parent; !isSourceFile(at); at = at.parent) {
    if (at === fn) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the module calls `fn` by its name as it loads, `const next = makeCounter()` — of the name
 * it is declared by, or a variable's it is the value of, where nothing between declares it again.
 */
function isCalledAsLoads(fn: Node): boolean {
  const name = nameOf(fn);
  if (name === undefined) {
    return false;
  }
  const holder = holderOf(name);
  let found = false;
  const visit = (node: Node): void => {
    // A function's code, but one called in place, runs as it is called, not as the module loads.
    if (found) {
      return;
    }
    if (isInstanceField(node)) {
      if (isComputedPropertyName(node.name)) {
        visit(node.name.expression);
      }
      if (startupField(node) && node.initializer !== undefined) {
        visit(node.initializer);
      }
      return;
    }
    if (isFunctionCode(node) && !isCalledInPlace(node)) {
      return;
    }
    const callee = isCallExpression(node) ? unwrapped(node.expression) : undefined;
    found =
      callee !== undefined &&
      isIdentifier(callee) &&
      callee.text === name.text &&
      holderOf(callee) === holder;
    if (!found) {
      node.forEachChild(visit);
    }
  };
  let file: Node = fn;
  while (!isSourceFile(file)) {
    file = file.parent;
  }
  file.forEachChild(visit);
  return found;
}

/** The name `fn` is called by: the one it is declared by, or a variable's it is the value of. */
function nameOf(fn: Node): Identifier | undefined {
  if (isFunctionDeclaration(fn)) {
    return fn.name;
  }
  let at = fn.parent;
  while (isTypeWrapper(at)) at = at.parent;
  return isVariableDeclaration(at) && isIdentifier(at.name) ? at.name : undefined;
}

/** What declares `name` where it stands, of its own (`declares`): a function around it, or the module. */
function holderOf(name: Identifier): Node {
  let child: Node = name;
  let at: Node = name.parent;
  while (!isSourceFile(at) && !(isCodeAt(at, child) && declares(at, name))) {
    child = at;
    at = at.parent;
  }
  return at;
}

/** Whether this identifier resolves within `fn`, using its actual block, loop and catch scopes. */
function declares(fn: Node, name: Identifier): boolean {
  if ((isFunctionDeclaration(fn) && fn.name === name) || readsFunctionObject(fn, name)) {
    return false;
  }
  return !freeWithin(fn).has(name);
}

/** The free identifier nodes of one immutable syntax tree, preserving block binding identities. */
function freeWithin(fn: Node): ReadonlySet<Identifier> {
  let free = FREE_READS.get(fn);
  if (free === undefined) {
    free = new Set(freeReads(fn));
    FREE_READS.set(fn, free);
  }
  return free;
}

/** A named expression's self reference reaches the function object allocated by its outer frame. */
function readsFunctionObject(fn: Node, name: Identifier): boolean {
  if (!isFunctionExpression(fn) || fn.name?.text !== name.text) {
    return false;
  }
  const parameters = fn.parameters;
  const bound = (declaration: { readonly name: BindingName }): boolean =>
    bindingIdentifiers(declaration.name).some((each) => each.text === name.text);
  if (parameters.some((parameter) => bound(parameter))) {
    return false;
  }
  if (!isWithin(name, fn.body)) {
    return true;
  }
  return (
    hoistedIn([fn.body]).every((declaration) => !bound(declaration)) &&
    freeWithin(fn.body).has(name)
  );
}

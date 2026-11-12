import {
  isAwaitExpression,
  type Identifier,
  isArrowFunction,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isFunctionDeclaration,
  isForOfStatement,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isSourceFile,
  isYieldExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedPossibleBranch } from './framed-branches.ts';
import {
  namesOf,
  namesOfClass,
  holderOf,
  boundVariable,
  isAssignment,
  isFunctionCode,
  isGenerator,
  isNamedFunction,
  madeInPlace,
  madeOnTheSpot,
  runsInPlace,
  type FunctionNames,
} from './framed-function-names.ts';
import { called, droppedCall, isTypeOnly, referenceText, written } from './framed-references.ts';
import { framedWrittenTargets } from './framed-written-targets.ts';

export { isNamedFunction, madeInPlace } from './framed-function-names.ts';

/**
 * Where a function can run itself again, and where this module stops looking.
 *
 * A run of a function is followed into itself in four ways.
 * - By a name. A function is reached by the names it is given: its declaration's, its expression's,
 *   the variable, the property or the assignment target it is the value of, past parentheses and
 *   type wrappers, its method's or accessor's key, its class's, and `constructor`. Code that reads
 *   one of them, as a name or as a property, may reach it, with no regard to which object holds it.
 * - Through a helper. A function whose code reads such a name is reached by its own names as well,
 *   as far as that goes in the file.
 * - From anywhere. A function whose name is worked out, one that is a method, an accessor or a
 *   property's value, one the language calls by itself, one held where no name gives it (passed to
 *   a call, returned, put in a list), a generator whose iterator is used otherwise than dropped,
 *   and one a name is used for otherwise than to call it may be reached by any code that runs,
 *   wherever it is written.
 * - By waiting. A run that waits or yields lets another call of the function go on in its place.
 *
 * Counted as run where it is written: the code of the function itself, the body of one that is
 * made and called there, a class that is made there, its static code and its computed names and
 * decorators, whichever the arm of a branch that may run. Counted only where it is reached, and not
 * where it is written: the body of any other function, an instance initializer, a generator whose
 * iterator is not advanced there. Not counted at all: code a constant condition rules out, a type,
 * and a function that is dropped.
 *
 * Left to refuse, not to follow: a call through anything but a name or a property name (`call` and
 * `apply` are followed; `bind`, `Reflect.apply`, a trap, a stored alias are uses that reach it from
 * anywhere); code in another file; `eval`; a short circuit is a branch that may run.
 */

/**
 * Whether the parameters of a function, which run when it is called, read one of the names where
 * the code may run.
 */
function parametersMention(fn: Node, names: ReadonlySet<string>): boolean {
  const pending: Node[] = [...((fn as { readonly parameters?: readonly Node[] }).parameters ?? [])];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isFunctionCode(node) && !runsInPlace(node)) {
      pending.push(...definitionParts(node));
      continue;
    }
    if (deferredInitializer(node, fn)) continue;
    const text = referenceText(node);
    if (
      text !== undefined &&
      names.has(text) &&
      !written(node) &&
      !shadowedByParameter(node, fn) &&
      runsWithin(node, fn)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * Whether a node reads a name that only generators have, in a call whose iterator is dropped: the
 * call makes an iterator, runs the parameters of the generator and none of its body.
 */
function dropsGenerator(node: Node, name: string, names: ReadonlySet<string>): boolean {
  if (!droppedCall(node)) return false;
  const functions = functionsOf(node.getSourceFile()).byName.get(name) ?? [];
  return (
    functions.length > 0 &&
    functions.every((each) => isGenerator(each) && !parametersMention(each, names))
  );
}

/**
 * Whether the iterator of a generator may be advanced: a name of it is used, where the code may
 * run, otherwise than in a call whose iterator is dropped.
 */
function advanced(fn: Node): boolean {
  const names = new Set(namesOf(fn).names);
  const pending: Node[] = [fn.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const text = referenceText(node);
    if (
      text !== undefined &&
      names.has(text) &&
      !written(node) &&
      !droppedCall(node) &&
      framedPossibleBranch(node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether no arm a written condition rules out holds the node, or a function that holds it. */
function runsWithin(node: Node, fn: Node): boolean {
  if (!framedPossibleBranch(node)) return false;
  for (let at = node.parent; at !== fn; at = at.parent)
    if (isAnswering(at) && !framedPossibleBranch(at)) return false;
  return true;
}

/** Whether a node lies in the initializer of an instance field, which runs when one is made. */
function inInstanceInitializer(node: Node, fn: Node): boolean {
  for (let at = node; at !== fn; at = at.parent) if (deferredInitializer(at, fn)) return true;
  return false;
}

/** Whether a node is the initializer of an instance field of a class within the function. */
function deferredInitializer(node: Node, fn: Node): boolean {
  return node !== fn && isInstanceInitializer(node.parent, node) && node.parent.parent !== fn;
}

/** Whether a node is what the instance field that holds it is given, where it is run later. */
function isInstanceInitializer(holder: Node, node: Node): boolean {
  if (!isPropertyDeclaration(holder)) return false;
  const initializer: Node | undefined = holder.initializer;
  return (
    initializer === node &&
    holder.modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) !== true &&
    !madeOnTheSpot(holder.parent)
  );
}

/**
 * Whether a name is read as a parameter of a function within the scope, which takes what its caller
 * gives, has no default and is not written within it: the parameter is no function the name is given
 * to.
 */
function shadowedByParameter(node: Node, scope: Node): boolean {
  if (!isIdentifier(node)) return false;
  const declared = frameDeclarationOf(node);
  if (
    declared === undefined ||
    !isParameterDeclaration(declared) ||
    declared.initializer !== undefined ||
    declared.pos < scope.pos ||
    declared.end > scope.end
  )
    return false;
  const pending: Node[] = [scope];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (
      framedWrittenTargets(each).some((target) => {
        const assigned = unwrapped(target) as Node;
        return isIdentifier(assigned) && assigned.text === node.text;
      })
    )
      return false;
    each.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/**
 * Whether a name read inside the function resolves to the function: no parameter, no local, and no
 * function or class within it that is named alike takes the name first. A name that is not the
 * function's own or its variable's is taken for the function's wherever it is read.
 */
function refersToFunction(name: Identifier, fn: Node): boolean {
  const declared = frameDeclarationOf(name);
  if (isFunctionExpression(fn) && fn.name?.text === name.text) {
    if (declared !== undefined) return false;
  } else if (isFunctionDeclaration(fn) && fn.name?.text === name.text) {
    if (declared !== fn) return false;
  } else if (boundVariable(fn)?.name.getText() === name.text && declared !== boundVariable(fn)) {
    return false;
  }
  for (let at = name.parent; at !== fn; at = at.parent)
    if ((isFunctionExpression(at) || isClassExpression(at)) && at.name?.text === name.text)
      return false;
  return true;
}

/** The functions of the file with the names they are reached by, and the code of each. */
interface FileFunctions {
  readonly byName: ReadonlyMap<string, readonly Node[]>;
  readonly implicit: readonly Node[];
}

const FUNCTIONS = new WeakMap<SourceFile, FileFunctions>();

/** Adds a function or a class to the names it is reached by, and to those reached from anywhere. */
function register(
  found: { byName: Map<string, Node[]>; implicit: Node[] },
  node: Node,
  reached: FunctionNames,
): void {
  for (const name of reached.names)
    found.byName.set(name, [...(found.byName.get(name) ?? []), node]);
  if ((isNamedFunction(node) && runsBySelf(node)) || (isClass(node) && reached.computed))
    found.implicit.push(node);
}

/** The functions of a file by name, and those the language may call by itself. */
function functionsOf(file: SourceFile): FileFunctions {
  const known = FUNCTIONS.get(file);
  if (known !== undefined) return known;
  const found: { byName: Map<string, Node[]>; implicit: Node[] } = {
    byName: new Map(),
    implicit: [],
  };
  const reachedBy = new Map<Node, FunctionNames>();
  const referenced = new Set<string>();
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node) || (node !== file && !framedPossibleBranch(node))) continue;
    const reached = reachedNames(node);
    if (reached.names.length > 0 || reached.computed) reachedBy.set(node, reached);
    const text = referenceText(node);
    if (text !== undefined) referenced.add(text);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  for (const [node, reached] of reachedBy)
    if (!neverCreated(node, referenced)) register(found, node, reached);
  FUNCTIONS.set(file, found);
  return found;
}

/** Whether a node lies within a function, a method or an arrow, as code that runs when it is called. */
function isNested(node: Node): boolean {
  for (let at = node.parent; !isSourceFile(at); at = at.parent) if (isFunctionCode(at)) return true;
  return false;
}

/**
 * Whether what a node lies in of a function runs where the function is written: the function is
 * called there, and the node is in its body, or in what a generator runs at the call.
 */
function runsAtOnce(fn: Node, node: Node): boolean {
  if (!madeInPlace(fn)) return false;
  return !isGenerator(fn) || inDefinition(fn, node);
}

/**
 * Whether a node lies in a function that is never made or run: it is declared within another
 * function, no name of it is read anywhere in the file, and nothing else reaches it, a computed
 * name or an object that holds it; or in the initializer of an instance field of a class that is
 * declared within a function and read by no name; or in the body of a generator whose iterator no
 * name advances. A function or a class at the top of a file may be run from elsewhere, and is taken
 * to run.
 */
function neverCreated(node: Node, referenced: ReadonlySet<string>): boolean {
  for (let at = node; !isSourceFile(at); at = at.parent) {
    if (isInstanceInitializer(at.parent, at) && unreachedClass(at.parent.parent, referenced))
      return true;
    if (at !== node && unreachedFunction(at, node, referenced)) return true;
  }
  return false;
}

/** Whether a function declared within another is read by no name, and nothing else reaches it. */
function unreachedFunction(fn: Node, node: Node, referenced: ReadonlySet<string>): boolean {
  if (!isFunctionCode(fn) || !isNested(fn) || runsAtOnce(fn, node) || reachedByProperty(fn))
    return false;
  const { names, computed } = namesOf(fn);
  if (computed) return false;
  if (names.every((name) => !referenced.has(name))) return true;
  return isGenerator(fn) && !advanced(fn) && !inDefinition(fn, node);
}

/**
 * Whether a node lies in what a generator runs at a call, though its body waits for the iterator:
 * its parameters, and what `definitionParts` has.
 */
function inDefinition(fn: Node, node: Node): boolean {
  const { parameters } = fn as { readonly parameters?: readonly Node[] };
  return [...definitionParts(fn), ...(parameters ?? [])].some(
    (part) => node.pos >= part.pos && node.end <= part.end,
  );
}

/** Whether a class declared within a function is read by no name, so that no instance is made. */
function unreachedClass(declaration: Node, referenced: ReadonlySet<string>): boolean {
  if (!isNested(declaration) || buildsItself(declaration)) return false;
  const { names, computed } = namesOfClass(declaration);
  return !computed && names.every((name) => !referenced.has(name));
}

/**
 * Whether a class may be built with no name of it read: a decorator is handed the class, or its
 * static code reads `this`, which is the class there.
 */
function buildsItself(declaration: Node): boolean {
  const { modifiers, members } = declaration as {
    readonly modifiers?: readonly Node[];
    readonly members?: readonly Node[];
  };
  if (modifiers?.some((each) => each.kind === SyntaxKind.Decorator) === true) return true;
  return (members ?? []).some((member) => isStaticCode(member) && readsThis(member));
}

/** Whether a member of a class runs when the class is defined: a static block, a static field. */
function isStaticCode(member: Node): boolean {
  if (member.kind === SyntaxKind.ClassStaticBlockDeclaration) return true;
  const { modifiers } = member as { readonly modifiers?: readonly Node[] };
  return (
    member.kind === SyntaxKind.PropertyDeclaration &&
    modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) === true
  );
}

/** Whether a node holds a `this`, whichever function it is in. */
function readsThis(node: Node): boolean {
  if (node.kind === SyntaxKind.ThisKeyword) return true;
  let found = false;
  node.forEachChild((child) => {
    found ||= readsThis(child);
  });
  return found;
}

/** Whether a node is a class, a declaration or an expression. */
function isClass(node: Node): boolean {
  return isClassDeclaration(node) || isClassExpression(node);
}

/** The names a function or a class is reached by; a class by its own. */
function reachedNames(node: Node): FunctionNames {
  if (isClass(node)) return namesOfClass(node);
  return isNamedFunction(node) ? namesOf(node) : { names: [], computed: false };
}

/**
 * Whether a function may be reached by a way no name follows: its name is worked out, an object
 * holds it, or the language calls it by itself, as a getter, a setter or a method of the iteration
 * or of a coercion; or it is a generator whose iterator may be advanced. An object may be read by a
 * key that is worked out, by its values, by a copy, or by a lookup at run time.
 */
function runsBySelf(fn: Node): boolean {
  return namesOf(fn).computed || reachedByProperty(fn) || (isGenerator(fn) && advanced(fn));
}

/** Whether the code of a function reads one of the names where it may run. */
function mentionsAny(fn: Node, names: ReadonlySet<string>): boolean {
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (node !== fn && isFunctionCode(node) && !runsInPlace(node)) {
      pending.push(...definitionParts(node));
      continue;
    }
    if (deferredInitializer(node, fn)) continue;
    const text = referenceText(node);
    if (
      text !== undefined &&
      names.has(text) &&
      !written(node) &&
      !dropsGenerator(node, text, names) &&
      !shadowedByParameter(node, fn) &&
      runsWithin(node, fn)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * The names by which a function is reached again, and whether it may be reached from anywhere: its
 * own, and those of the functions of the file that read one of them; and a function that is used
 * otherwise than by a call, or one the language calls by itself that reads one.
 */
function reaching(fn: Node): { readonly names: ReadonlySet<string>; readonly anywhere: boolean } {
  const names = new Set(namesOf(fn).names);
  const { byName, implicit } = functionsOf(fn.getSourceFile());
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, functions] of byName)
      if (!names.has(name) && functions.some((each) => mentionsAny(each, names))) {
        names.add(name);
        grew = true;
      }
  }
  const anywhere =
    namesOf(fn).computed ||
    reachedByProperty(fn) ||
    implicit.some((each) => mentionsAny(each, names)) ||
    escapes(fn.getSourceFile(), names);
  return { names, anywhere };
}

/** Whether a function is the value of a property, or a method: a key worked out reaches it. */
function reachedByProperty(fn: Node): boolean {
  if (isMethodDeclaration(fn) || isGetAccessorDeclaration(fn) || isSetAccessorDeclaration(fn))
    return true;
  if (!isFunctionExpression(fn) && !isArrowFunction(fn)) return false;
  for (let at = holderOf(fn); ;) {
    const { parent } = at;
    if (isPropertyAssignment(parent) || isPropertyDeclaration(parent)) return true;
    if (!isAssignment(parent) || (parent.right as Node) !== at) return false;
    const left = unwrapped(parent.left) as Node;
    if (isPropertyAccessExpression(left) || isElementAccessExpression(left)) return true;
    at = holderOf(parent);
  }
}

/** Whether the file uses one of the names otherwise than by calling it or giving it a value. */
function escapes(file: SourceFile, names: ReadonlySet<string>): boolean {
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const text = referenceText(node);
    if (
      text !== undefined &&
      names.has(text) &&
      !written(node) &&
      !called(node) &&
      !isDeclarationName(node) &&
      framedPossibleBranch(node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether a node names what a declaration declares, in a property of a literal or a class. */
function isDeclarationName(node: Node): boolean {
  const { parent } = node;
  return (isPropertyAssignment(parent) || isPropertyDeclaration(parent)) && parent.name === node;
}

/**
 * The parts of a function that run where it is written: a computed name, its decorators, and the
 * parameters of a generator that is called there, whose body waits for its iterator.
 */
function definitionParts(fn: Node): readonly Node[] {
  const { name, modifiers, parameters } = fn as {
    readonly name?: Node;
    readonly modifiers?: readonly Node[];
    readonly parameters?: readonly Node[];
  };
  const decorators = modifiers?.filter((each) => each.kind === SyntaxKind.Decorator) ?? [];
  const run = isGenerator(fn) && madeInPlace(fn) ? (parameters ?? []) : [];
  const named = name !== undefined && isComputedPropertyName(name) ? [name] : [];
  return [...named, ...decorators, ...run];
}

/** Whether code that runs in the range reaches what the language may call by itself. */

function runsCodeBetween(fn: Node, from: number, to: number): boolean {
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (node !== fn && isAnswering(node) && !runsInPlace(node)) {
      pending.push(...definitionParts(node));
      continue;
    }
    if (deferredInitializer(node, fn)) continue;
    if (node.pos >= from && node.pos < to && !isCodeFree(node) && framedPossibleBranch(node))
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** The kinds of node that run no code but their parts': a name, a literal, a plain statement. */
const CODE_FREE: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.AsExpression,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.Block,
  SyntaxKind.BreakStatement,
  SyntaxKind.CaseBlock,
  SyntaxKind.CaseClause,
  SyntaxKind.CatchClause,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.ClassStaticBlockDeclaration,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.ContinueStatement,
  SyntaxKind.DefaultClause,
  SyntaxKind.EmptyStatement,
  SyntaxKind.ExpressionStatement,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FunctionExpression,
  SyntaxKind.Identifier,
  SyntaxKind.IfStatement,
  SyntaxKind.LabeledStatement,
  SyntaxKind.NonNullExpression,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.ReturnStatement,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.StringLiteral,
  SyntaxKind.SwitchStatement,
  SyntaxKind.ThisKeyword,
  SyntaxKind.ThrowStatement,
  SyntaxKind.TrueKeyword,
  SyntaxKind.TryStatement,
  SyntaxKind.TypeAssertionExpression,
  SyntaxKind.VariableDeclaration,
  SyntaxKind.VariableDeclarationList,
  SyntaxKind.VariableStatement,
]);

/** Whether a node runs no code but its parts': any other may call a getter, a trap or a method. */
function isCodeFree(node: Node): boolean {
  return CODE_FREE.has(node.kind);
}

/** Whether a node suspends the function that runs it, which lets another run of it begin. */
function isSuspension(node: Node): boolean {
  return (
    isAwaitExpression(node) ||
    isYieldExpression(node) ||
    (isForOfStatement(node) && node.awaitModifier !== undefined)
  );
}

/**
 * Whether the function runs itself again between two positions: its names, or those of a function
 * that reads one of them, are read there where the code may run; where the function may be reached
 * from anywhere, whenever code runs there at all; and where it waits or yields, which lets a run
 * that another call began go on in its place.
 */
export function runsItselfBetween(fn: Node, from: number, to: number): boolean {
  if (!isNamedFunction(fn)) return false;
  const { names, anywhere } = reaching(fn);
  if (anywhere && runsCodeBetween(fn, from, to)) return true;
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (node !== fn && isFunctionCode(node) && !runsInPlace(node)) {
      pending.push(...definitionParts(node));
      continue;
    }
    if (node.pos >= from && node.pos < to && reenters(node, fn, names)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether a node, where it may run, lets the function run again: it reaches it, or it waits. */
function reenters(node: Node, fn: Node, names: ReadonlySet<string>): boolean {
  return isSuspension(node) ? runsWithin(node, fn) : callsFunction(node, fn, names);
}

/** Whether a node reads a name by which the function is reached, in a place that may run. */

function callsFunction(node: Node, fn: Node, names: ReadonlySet<string>): boolean {
  const text = referenceText(node);
  return (
    text !== undefined &&
    names.has(text) &&
    !written(node) &&
    !dropsGenerator(node, text, names) &&
    (!isIdentifier(node) || refersToFunction(node, fn)) &&
    !shadowedByParameter(node, fn) &&
    runsWithin(node, fn) &&
    !inInstanceInitializer(node, fn)
  );
}

/** Whether the function runs itself again anywhere in its code. */
export function runsItself(fn: Node): boolean {
  return runsItselfBetween(fn, -Infinity, Infinity);
}

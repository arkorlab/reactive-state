import {
  type BigIntLiteral,
  isAwaitExpression,
  isBigIntLiteral,
  type Identifier,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isFunctionDeclaration,
  isForOfStatement,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isExpressionStatement,
  isIdentifier,
  isMetaProperty,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isMethodDeclaration,
  isNewExpression,
  isParameterDeclaration,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTypeNode,
  isYieldExpression,
  type Node,
  type NoSubstitutionTemplateLiteral,
  type NumericLiteral,
  type PrivateIdentifier,
  type SourceFile,
  type StringLiteral,
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
import { framedWrittenTargets } from './framed-written-targets.ts';
import { readsBinding } from './scope.ts';

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

/** Whether a node is a type and no value: the expression a class extends is a value. */
function isTypeOnly(node: Node): boolean {
  return isTypeNode(node) && !isExpressionWithTypeArguments(node);
}

/** The name an identifier or a private name reads: a variable's, or a property's by its name. */
function readName(node: Identifier | PrivateIdentifier): string | undefined {
  const { parent } = node;
  if (isPropertyAccessExpression(parent) && parent.name === node) return node.text;
  if (!isIdentifier(node)) return undefined;
  if (!isShorthandPropertyAssignment(parent) && (parent as { name?: Node }).name === node)
    return undefined;
  return readsBinding(node) ? node.text : undefined;
}

/** The name a node reads, if it reads one: a variable, or a property by its name. */
function referenceText(node: Node): string | undefined {
  if (isMetaProperty(node))
    return node.keywordToken === SyntaxKind.NewKeyword ? 'constructor' : undefined;
  if (isIdentifier(node) || isPrivateIdentifier(node)) return readName(node);
  return isLiteralKey(node) ? literalText(node as KeyLiteral) : undefined;
}

/** The literals a property is named by: a string, a template without substitutions, a number. */
type KeyLiteral = BigIntLiteral | NoSubstitutionTemplateLiteral | NumericLiteral | StringLiteral;

/** Whether a node is a literal that names a property. */
function isLiteral(node: Node): node is KeyLiteral {
  return (
    isStringLiteral(node) ||
    isNoSubstitutionTemplateLiteral(node) ||
    isNumericLiteral(node) ||
    isBigIntLiteral(node)
  );
}

/** The property a literal names: a big integer's is its digits. */
function literalText(node: KeyLiteral): string {
  return isBigIntLiteral(node) ? node.text.replace(/n$/u, '') : node.text;
}

/** Whether a node is a literal an element access names its property by, past type wrappers. */
function isLiteralKey(node: Node): boolean {
  if (!isLiteral(node)) return false;
  const held = holderOf(node);
  return isElementAccessExpression(held.parent) && held.parent.argumentExpression === held;
}

/**
 * The call, construction or tag that a node, the name of a reference, is what it calls: the name
 * itself, a property's, or either of them through `call` or `apply`.
 */
function callOf(node: Node): Node | undefined {
  let at = holderOf(node);
  if ((isPropertyAccessExpression(at.parent) && at.parent.name === at) || isLiteralKey(node))
    at = holderOf(at.parent);
  if (isPropertyAccessExpression(at.parent) && at.parent.expression === at) {
    const via = at.parent.name.text;
    if (via !== 'call' && via !== 'apply') return undefined;
    at = holderOf(at.parent);
  }
  const { parent } = at;
  return ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === at) ||
    (isTaggedTemplateExpression(parent) && parent.tag === at)
    ? parent
    : undefined;
}

/** Whether a node, the name of a reference, is what a call, a construction or a tag calls. */
function called(node: Node): boolean {
  return callOf(node) !== undefined;
}

/** Whether a node, the name of a reference, is what a call calls whose result is dropped. */
function droppedCall(node: Node): boolean {
  const call = callOf(node);
  return call !== undefined && isExpressionStatement(call.parent);
}

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

/**
 * Whether a reference is a name that is written to, and not read: a variable, or a property by its
 * name. A write of a property that calls a setter is found by the setter, which is reached from
 * anywhere, whatever the name.
 */
function written(node: Node): boolean {
  const { parent } = node;
  let target = node;
  if (isPropertyAccessExpression(parent) && parent.name === node) target = parent;
  else if (isLiteralKey(node)) target = holderOf(node).parent;
  const held = holderOf(target);
  return (
    isBinaryExpression(held.parent) &&
    held.parent.left === held &&
    held.parent.operatorToken.kind === SyntaxKind.EqualsToken
  );
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

/** The functions of a file by name, and those the language may call by itself. */
function functionsOf(file: SourceFile): FileFunctions {
  const known = FUNCTIONS.get(file);
  if (known !== undefined) return known;
  const byName = new Map<string, Node[]>();
  const implicit: Node[] = [];
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node) || (node !== file && !framedPossibleBranch(node))) continue;
    const reached = reachedNames(node);
    for (const name of reached.names) byName.set(name, [...(byName.get(name) ?? []), node]);
    if ((isNamedFunction(node) && runsBySelf(node)) || (isClass(node) && reached.computed))
      implicit.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const found = { byName, implicit };
  FUNCTIONS.set(file, found);
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
  SyntaxKind.ExpressionWithTypeArguments,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FunctionExpression,
  SyntaxKind.HeritageClause,
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

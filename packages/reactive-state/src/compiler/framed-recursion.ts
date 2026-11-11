import {
  type Identifier,
  isArrowFunction,
  isClassExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isParenthesizedExpression,
  isTypeNode,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  type VariableDeclaration,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedPossibleBranch } from './framed-branches.ts';
import { readsBinding } from './scope.ts';

/**
 * Where a function can run itself again: the code of a function that is called by a name, a
 * declaration, a named expression or the variable an arrow or an expression is given to, or by a
 * function it holds or another that names it, may reach it before it ends.
 */

/** A function that has a name to be called by, with the name. */
export type NamedFunction = Node & { readonly body?: Node };

/** The name a function is called by: its own, or the variable it is given to. */
function nameOf(fn: Node): Identifier | undefined {
  if ((isFunctionDeclaration(fn) || isFunctionExpression(fn)) && fn.name !== undefined)
    return fn.name;
  const bound = boundVariable(fn);
  return bound !== undefined && isIdentifier(bound.name) ? bound.name : undefined;
}

/** The variable an arrow or a function expression is the value of. */
function boundVariable(fn: Node): VariableDeclaration | undefined {
  if (!isArrowFunction(fn) && !isFunctionExpression(fn)) return undefined;
  let at: Node = fn;
  while (isParenthesizedExpression(at.parent)) at = at.parent;
  const { parent } = at;
  return isVariableDeclaration(parent) &&
    parent.initializer !== undefined &&
    unwrapped(parent.initializer) === fn
    ? parent
    : undefined;
}

/** Whether a node is a function that is called by a name. */
export function isNamedFunction(node: Node): boolean {
  return (
    (isFunctionDeclaration(node) || isFunctionExpression(node) || isArrowFunction(node)) &&
    nameOf(node) !== undefined
  );
}

/**
 * Whether the function runs itself again between two positions: by its name, or through a function
 * that names it, wherever that function is written, or a name reached through it in turn.
 */
export function runsItselfBetween(fn: Node, from: number, to: number): boolean {
  const name = nameOf(fn);
  if (name === undefined) return false;
  const names = recursiveNames(fn, name);
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (
      node !== name &&
      node.pos >= from &&
      node.pos < to &&
      isIdentifier(node) &&
      names.has(node.text) &&
      readsBinding(node) &&
      (node.text !== name.text || refersToFunction(node, fn)) &&
      runsWithin(node, fn)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether the function runs itself again anywhere in its code. */
export function runsItself(fn: Node): boolean {
  return runsItselfBetween(fn, -Infinity, Infinity);
}

/**
 * The names by which the function runs itself: its own, and those of the functions of the file,
 * a declaration or a variable given one, whose code names one of them. A name that more than one
 * function has counts if any of them does.
 */
function recursiveNames(fn: Node, name: Identifier): ReadonlySet<string> {
  const names = new Set([name.text]);
  const helpers = functionsByName(fn.getSourceFile());
  for (let grew = true; grew;) {
    grew = false;
    for (const [helper, bodies] of helpers)
      if (!names.has(helper) && bodies.some((body) => mentionsAny(body, names))) {
        names.add(helper);
        grew = true;
      }
  }
  return names;
}

const FUNCTIONS = new WeakMap<SourceFile, ReadonlyMap<string, readonly Node[]>>();

/** The functions of a file, each name with the code of every function that has it. */
function functionsByName(file: SourceFile): ReadonlyMap<string, readonly Node[]> {
  const known = FUNCTIONS.get(file);
  if (known !== undefined) return known;
  const found = new Map<string, Node[]>();
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (isNamedFunction(node)) {
      const name = nameOf(node);
      const { body } = node as NamedFunction;
      if (name !== undefined && body !== undefined)
        found.set(name.text, [...(found.get(name.text) ?? []), body]);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  FUNCTIONS.set(file, found);
  return found;
}

/** Whether the code reads one of the names. */
function mentionsAny(body: Node, names: ReadonlySet<string>): boolean {
  const pending: Node[] = [body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (isIdentifier(node) && names.has(node.text) && readsBinding(node)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * Whether a name read inside the function resolves to the function: no parameter, no local, and no
 * function or class within it that is named alike takes the name first.
 */
function refersToFunction(name: Identifier, fn: Node): boolean {
  const declared = frameDeclarationOf(name);
  const own = isFunctionExpression(fn) && fn.name !== undefined;
  const self = isFunctionDeclaration(fn) ? fn : boundVariable(fn);
  if (own ? declared !== undefined : declared !== self) return false;
  for (let at = name.parent; at !== fn; at = at.parent)
    if ((isFunctionExpression(at) || isClassExpression(at)) && at.name?.text === name.text)
      return false;
  return true;
}

/** Whether no arm a written condition rules out holds the node, or a function that holds it. */
function runsWithin(node: Node, fn: Node): boolean {
  if (!framedPossibleBranch(node)) return false;
  for (let at = node.parent; at !== fn; at = at.parent)
    if (isAnswering(at) && !framedPossibleBranch(at)) return false;
  return true;
}

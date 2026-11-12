import {
  isClassStaticBlockDeclaration,
  isCallExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isSourceFile,
  type Identifier,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { eagerBody, isAnswering } from './answers.ts';
import { useOf } from './code-globals.ts';

/**
 * Where a class's own work runs: a class evaluates the computed keys of all its members before it
 * runs any static initializer or static block, though they are written after them.
 */

/**
 * Whether `node` lies in a computed key of a class whose static initializer or static block holds
 * `reference`, or of one that holds that class in such a place: a class evaluates the keys of all
 * its members before it runs any static initializer, whichever is written first, and the classes
 * written in its static initializers are created while they run.
 */
export function ownerKeyFirst(node: Node, reference: Identifier): boolean {
  return staticOwners(reference).some((owner) => keyOf(node, owner));
}

/** Whether `node` lies in a computed key of the members of `owner`, or is a member that holds one. */
function keyOf(node: Node, owner: Node): boolean {
  if (node.parent === owner && hasComputedKey(node)) return true;
  for (let at: Node = node; at !== owner && !isSourceFile(at); at = at.parent)
    if (isComputedPropertyName(at) && at.parent.parent === owner) return true;
  return false;
}

/** Whether `member` of a class is named by a computed key, which the walk must reach to read it. */
function hasComputedKey(member: Node): boolean {
  return (
    (isPropertyDeclaration(member) ||
      isMethodDeclaration(member) ||
      isGetAccessorDeclaration(member) ||
      isSetAccessorDeclaration(member)) &&
    isComputedPropertyName(member.name)
  );
}

/**
 * Whether `at`, in the function or constructor `parent`, runs when the function is called, and not
 * where it is written: its body and its parameters do — but for a body called where it is written,
 * without arguments, which runs in place — and its computed name, which is evaluated where the
 * function is written, does not.
 */
function deferredBody(parent: Node, at: Node): boolean {
  if (isConstructorDeclaration(parent)) return true;
  if (!isAnswering(parent)) return false;
  const regions: readonly (Node | undefined)[] = [parent.body, ...parent.parameters];
  if (!regions.includes(at)) return false;
  const { parent: use } = useOf(parent);
  return !isCallExpression(use) || use.arguments.length > 0 || eagerBody(use) !== parent.body;
}

/**
 * The classes whose static initializer or static block `reference` is evaluated in, as they are
 * defined, the nearest first, and those that hold such a class in a static initializer of theirs.
 */
function staticOwners(reference: Identifier): readonly Node[] {
  const owners: Node[] = [];
  for (let at: Node = reference; !isSourceFile(at.parent); at = at.parent) {
    const { parent } = at;
    if (deferredBody(parent, at)) break;
    const field = initializerKind(parent, at);
    if (field === 'instance') break;
    if (field === 'static' || isClassStaticBlockDeclaration(parent)) owners.push(parent.parent);
  }
  return owners;
}

/** Whether `at` is the initializer of a field of a class, and whether the field is static. */
function initializerKind(parent: Node, at: Node): 'instance' | 'static' | undefined {
  if (!isPropertyDeclaration(parent) || parent.initializer?.pos !== at.pos) return undefined;
  return parent.modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) === true
    ? 'static'
    : 'instance';
}

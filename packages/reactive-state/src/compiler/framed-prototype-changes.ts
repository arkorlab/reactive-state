import {
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isInterfaceDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isSourceFile,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeOfExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { globalPathOf, useOf } from './code-globals.ts';
import { isTypeOnly } from './framed-references.ts';

const PROTOTYPE_CHANGES = new WeakMap<SourceFile, boolean>();

/**
 * Whether a file may give an array another prototype, or another inherited method, whose setter an
 * assignment then meets. The file is read for what it MAY do, by name: it may, wherever a value
 * mentions a name that reaches a prototype (`REACHING`: as a member, a key or a text, of any object),
 * or a global that holds one (`HOLDERS`), unless the mention is one of the few uses of the language's
 * that reach none (`ordinary`). A name the code does not write whole (a call's answer, a variable, a
 * text joined at run time) is not read.
 */
export function prototypeMayChange(file: SourceFile): boolean {
  const known = PROTOTYPE_CHANGES.get(file);
  if (known !== undefined) return known;
  let found = false;
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined && !found; node = pending.pop()) {
    found = escapes(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  PROTOTYPE_CHANGES.set(file, found);
  return found;
}

/** The names that reach a prototype, or give another to an object. */
const REACHING: ReadonlySet<string> = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'getPrototypeOf',
  'prototype',
  'setPrototypeOf',
]);

/** The globals that reach a prototype, and the global objects that hold them. */
const HOLDERS: ReadonlySet<string> = new Set([
  'Array',
  'Function',
  'global',
  'globalThis',
  'Object',
  'Reflect',
  'self',
  'window',
]);

/** The calls, by their names, that an application makes and that give no object another prototype. */
const CALLED: ReadonlySet<string> = new Set([
  'Array.from',
  'Array.isArray',
  'Array.of',
  'Object.assign',
  'Object.entries',
  'Object.freeze',
  'Object.fromEntries',
  'Object.keys',
  'Object.values',
]);

/** Whether a node, where it is read, may reach a prototype: a name that reaches one, or a holder not used as `ordinary` says. */
function escapes(node: Node): boolean {
  if (!isIdentifier(node) && !isStringLiteral(node) && !isNoSubstitutionTemplateLiteral(node))
    return false;
  if (inType(node)) return false;
  if (REACHING.has(node.text)) return true;
  const root = isIdentifier(node) ? globalPathOf(node)?.[0] : undefined;
  return root !== undefined && HOLDERS.has(root) && !ordinary(node, root);
}

/** Whether a name is written in a type, which names no value and reaches no prototype. */
function inType(node: Node): boolean {
  for (let at = node.parent; !isSourceFile(at); at = at.parent)
    if (isTypeOnly(at) || isInterfaceDeclaration(at) || isTypeAliasDeclaration(at)) return true;
  return false;
}

/**
 * Whether a holder is used as an application does: tested (`typeof Object`, `x instanceof Array`),
 * made (`new Array(n)`, `Array(n)`), or a member of it called by its name (`CALLED`).
 */
function ordinary(holder: Node, root: string): boolean {
  const { at, parent } = useOf(holder);
  if (isTypeOfExpression(parent)) return true;
  if (isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.InstanceOfKeyword)
    return parent.right === at;
  if ((isNewExpression(parent) || isCallExpression(parent)) && parent.expression === at)
    return root === 'Array' || root === 'Object';
  if (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) return false;
  const member = useOf(parent);
  return (
    parent.expression === at &&
    isCallExpression(member.parent) &&
    member.parent.expression === member.at &&
    CALLED.has(globalPathOf(parent)?.join('.') ?? '')
  );
}

import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isSpreadElement,
  SyntaxKind,
} from 'typescript/ast';

import { calledMember, globalOf, unwrapped } from './bounded.ts';
import { globalPath } from './global-answers.ts';
import type { Resolve } from './numbers.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** What `FinalizationRegistry` methods throw of weak targets, tokens, and identical held values. */

/**
 * Whether a method of a registry the code shows it constructs is given a target or token that
 * cannot be held weakly: primitives but nonregistered symbols. A register token of `undefined` is
 * optional; unregister requires one. The held value cannot be the target itself.
 */
export function registryArgumentThrows(
  callee: Expression,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const member = calledMember(callee);
  if (
    member === undefined ||
    !['register', 'unregister'].includes(member.name) ||
    !isRegistry(member.of, resolve) ||
    given.some((each) => isSpreadElement(each))
  ) {
    return false;
  }
  const [target, held, token] = given;
  if (member.name === 'unregister') {
    return cannotHoldWeakly(target, resolve);
  }
  return (
    cannotHoldWeakly(target, resolve) ||
    (token !== undefined &&
      !isUndefined(writtenOf(token, resolve)) &&
      cannotHoldWeakly(token, resolve)) ||
    (target !== undefined && held !== undefined && sameHeldValue(target, held, resolve))
  );
}

/** Whether the held value is the same written value, binding or well-known symbol as the target. */
function sameHeldValue(
  target: Expression,
  held: Expression,
  resolve: Resolve | undefined,
): boolean {
  const first = writtenOf(target, resolve);
  const second = writtenOf(held, resolve);
  if (
    first === second ||
    (isIdentifier(first) && isIdentifier(second) && first.text === second.text)
  ) {
    return true;
  }
  const path = globalPath(first)?.join('.');
  return (
    path !== undefined && isSymbolWritten(first, resolve) && path === globalPath(second)?.join('.')
  );
}

/** Whether the receiver is a registry constructed there, through constants. */
function isRegistry(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  return (
    isNewExpression(value) &&
    globalPath(unwrapped(value.expression))?.join('.') === 'FinalizationRegistry'
  );
}

/** Whether a value the code writes cannot be held weakly; unknown values remain for the runtime. */
function cannotHoldWeakly(node: Expression | undefined, resolve: Resolve | undefined): boolean {
  if (node === undefined) {
    return true;
  }
  const value = writtenOf(node, resolve);
  if (primitiveOf(value, resolve) !== undefined) {
    return true;
  }
  return (
    isCallExpression(value) && globalPath(unwrapped(value.expression))?.join('.') === 'Symbol.for'
  );
}

/** Whether an optional register token is explicitly `undefined`, including `void` expressions. */
function isUndefined(node: Expression): boolean {
  return node.kind === SyntaxKind.VoidExpression || globalOf(node) === 'undefined';
}

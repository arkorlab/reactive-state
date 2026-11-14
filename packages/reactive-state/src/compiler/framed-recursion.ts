import { isParameterDeclaration, type Node } from 'typescript/ast';

import { isFunctionCode } from './framed-function-names.ts';

/**
 * Where a function can run itself again: anywhere. A function may be reached by a name, a property,
 * a getter, a trap, a decorator, a wait or one of the language's own calls, and the compile follows
 * none of them; every function, method, accessor and constructor runs itself again.
 */

/** Whether the function runs itself again somewhere in its code: any function may. */
export function runsItself(fn: Node): boolean {
  return isFunctionCode(fn);
}

/**
 * Whether a declaration lies in the function as an array each run of the function makes: a variable
 * it declares, or its rest parameter. A parameter that a caller gives is not: a recursive call may
 * pass on the same one.
 */
export function madeWithin(declared: Node, fn: Node): boolean {
  const given = isParameterDeclaration(declared) && declared.dotDotDotToken === undefined;
  return !given && declared.pos >= fn.pos && declared.end <= fn.end;
}

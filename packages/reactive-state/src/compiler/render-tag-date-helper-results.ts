import {
  type BindingElement,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrowFunction,
  isBindingElement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isSpreadElement,
  isVariableDeclaration,
  type CallExpression,
  type Node,
  type ParameterDeclaration,
} from 'typescript/ast';

import { type Answering, overloadsOf, returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { bindingIdentifiers } from './scope.ts';

/** What a function of the file answers of the Date a tag hands it: in a call, or as a callback. */

/** Whether an expression carries a Date, asked of the path in hand (`shared`) or of a fresh one (`fresh`). */
export interface DatedQueries {
  readonly shared: (expression: Expression) => boolean;
  readonly fresh: (expression: Expression) => boolean;
}

/** The parameters a call hands a Date, while the answers of the function are asked, and the functions asked. */
const ASSUMED = new Set<Node>();
const ASKED = new Set<Node>();

/**
 * Whether a name a parameter of a function the answers of which are being asked binds holds a Date:
 * none where the parameter is not handed one, the parameter itself, and what array patterns take
 * of it, not what an object pattern takes (`({ length }) => length`).
 */
export function handedNameCarries(
  name: Identifier,
  parameter: ParameterDeclaration,
): boolean | undefined {
  if (!ASSUMED.has(parameter)) return undefined;
  if (isIdentifier(parameter.name)) return true;
  const bound = bindingIdentifiers(parameter.name).find((each) => each.text === name.text)?.parent;
  return bound !== undefined && isBindingElement(bound) && boundThroughArrays(bound, parameter);
}

function boundThroughArrays(element: BindingElement, parameter: ParameterDeclaration): boolean {
  let node: Node = element;
  while (node !== parameter) {
    if (isBindingElement(node) && !isArrayBindingPattern(node.parent)) return false;
    node = node.parent;
  }
  return true;
}

/** The functions an expression may be, found once for each: a walk of the scope each. */
const FUNCTIONS = new WeakMap<Node, readonly Answering[]>();

/**
 * The functions of the file an expression may be: a function written there, a declaration (each of
 * its overloads that has a body), or what a constant or a variable written once stands for. None
 * for a name the code does not show (an import, a native function, a parameter).
 */
function functionsOf(callee: Expression): readonly Answering[] {
  const target = unwrapped(callee);
  if (isArrowFunction(target) || isFunctionExpression(target)) return [target];
  if (!isIdentifier(target)) return [];
  const known = FUNCTIONS.get(target);
  if (known !== undefined) return known;
  const found = functionsNamedBy(target);
  FUNCTIONS.set(target, found);
  return found;
}

function functionsNamedBy(target: Identifier): readonly Answering[] {
  const declared = frameDeclarationOf(target);
  if (declared !== undefined && isFunctionDeclaration(declared)) {
    return overloadsOf(declared).filter((each) => each.body !== undefined);
  }
  const selected = frameBindingOf(target);
  const initializer =
    selected?.keys.length === 0 && isVariableDeclaration(selected.binding)
      ? selected.binding.initializer
      : undefined;
  const written = [
    ...(initializer === undefined ? [] : [initializer]),
    ...framedAssignedSources(target)
      .filter((source) => source.keys.length === 0)
      .map((source) => source.value),
  ];
  return written
    .map((each) => unwrapped(each))
    .filter((each) => isArrowFunction(each) || isFunctionExpression(each));
}

/**
 * Which arguments of a call carry a Date: by position, and from a spread that does, on. Each is
 * asked of a path of its own, so that what one visits (an alias both read) is not cut from the next.
 */
interface Handed {
  readonly at: ReadonlySet<number>;
  readonly from: number;
}

function handedBy(call: CallExpression, fresh: DatedQueries['fresh']): Handed {
  const at = new Set<number>();
  let from = Infinity;
  for (const [index, argument] of call.arguments.entries()) {
    if (isSpreadElement(argument)) {
      if (fresh(argument.expression)) from = Math.min(from, index);
    } else if (fresh(argument)) {
      at.add(index);
    }
  }
  return { at, from };
}

/**
 * Whether a call of a function of the file answers a Date: the Date its returns make of the
 * parameters the call hands one (`(value) => value ?? '-'`, `(value) => [value]`). A function that
 * makes text or a number of the parameter, a constant, and a function that calls itself again
 * while its answers are asked, answer none.
 */
export function helperResultCarriesDated(call: CallExpression, queries: DatedQueries): boolean {
  const functions = functionsOf(call.expression);
  if (functions.length === 0) return false;
  const handed = handedBy(call, queries.fresh);
  return functions.some((fn) => answersHandedDate(fn, handed, queries.fresh));
}

function answersHandedDate(fn: Answering, handed: Handed, fresh: DatedQueries['fresh']): boolean {
  if (ASKED.has(fn)) return false;
  const parameters = fn.parameters.filter((parameter, index) => {
    if (parameter.dotDotDotToken === undefined) return handed.at.has(index) || index >= handed.from;
    return handed.from !== Infinity || [...handed.at].some((slot) => slot >= index);
  });
  if (parameters.length === 0) return false;
  ASKED.add(fn);
  for (const parameter of parameters) ASSUMED.add(parameter);
  try {
    return returnedBy(fn).some((returned) => fresh(returned));
  } finally {
    ASKED.delete(fn);
    for (const parameter of parameters) ASSUMED.delete(parameter);
  }
}

/**
 * What the callback of `map`, `flatMap` or `Array.from` answers of the elements of `receiver`: an
 * inline callback's returns (its parameter asks the receiver), or those of a function of the file
 * handed the element when the receiver carries a Date. A callback the code does not show answers none.
 */
export function mappedResultCarriesDated(
  callback: Expression | undefined,
  receiver: Expression,
  queries: DatedQueries,
): boolean {
  const target = callback === undefined ? undefined : unwrapped(callback);
  if (target === undefined) return false;
  if (isArrowFunction(target) || isFunctionExpression(target)) {
    return returnedBy(target).some((returned) => queries.shared(returned));
  }
  const functions = functionsOf(target);
  if (functions.length === 0 || !queries.fresh(receiver)) return false;
  const handed: Handed = { at: new Set([0]), from: Infinity };
  return functions.some((fn) => answersHandedDate(fn, handed, queries.fresh));
}

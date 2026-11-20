import {
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isSpreadElement,
  isVariableDeclaration,
  type CallExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, answersLater, overloadsOf, parametersOf, returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedAssignedSources } from './framed-writes.ts';

/** What a function of the file answers of the Date a tag hands it: in a call, or as a callback. */

/**
 * Whether an expression carries a Date, asked of the path in hand (`shared`) or of a fresh one
 * (`fresh`), where a function that is not an arrow has an `arguments` of its own (`ownArguments`).
 */
export interface DatedQueries {
  readonly shared: (expression: Expression) => boolean;
  readonly fresh: (expression: Expression, ownArguments?: boolean) => boolean;
}

/** The parameters a call hands a Date, while the answers of the function are asked, and the questions asked. */
const ASSUMED = new Set<Node>();
const ASKED = new Set<string>();

/**
 * Whether a parameter of a function the answers of which are being asked is handed a Date: a plain
 * name, a rest parameter, or an array pattern (whose names, and the rest list, are the Date to the
 * walk). What a helper makes of a member (`({ length })`), `arguments` or a `this` it is typed of is
 * not the Date itself, so the helper's answer is the Date only where it returns the parameter, as
 * it is handed.
 */
export function isHandedDate(parameter: ParameterDeclaration): boolean {
  return ASSUMED.has(parameter);
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
  if (isArrowFunction(target) || isFunctionExpression(target)) {
    return answersLater(target) ? [] : [target];
  }
  if (!isIdentifier(target)) return [];
  const known = FUNCTIONS.get(target);
  if (known !== undefined) return known;
  const found = functionsNamedBy(target).filter((each) => !answersLater(each));
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

const FORWARDING_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.CommaToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** The expressions a returned value may be: past a conditional, a logical operator and a comma. */
function answeredLeaves(expression: Expression): readonly Expression[] {
  const value = unwrapped(expression);
  if (isConditionalExpression(value)) {
    return [...answeredLeaves(value.whenTrue), ...answeredLeaves(value.whenFalse)];
  }
  if (isBinaryExpression(value) && FORWARDING_OPERATORS.has(value.operatorToken.kind)) {
    return [...answeredLeaves(value.left), ...answeredLeaves(value.right)];
  }
  return [value];
}

/** Whether one of the returns of `fn` is a call of `fn` itself: `n === 0 ? c : turn(c, a, b, n - 1)`. */
function answersItself(fn: Answering): boolean {
  return returnedBy(fn).some((returned) => {
    return answeredLeaves(returned).some(
      (leaf) => isCallExpression(leaf) && functionsOf(leaf.expression).includes(fn),
    );
  });
}

/** Answers found for a function and the parameters it is handed, while one outermost question runs. */
const ANSWERED = new Map<string, boolean>();
const ASKING = { asked: 0, cut: 0, depth: 0 };
const BUDGET = { asks: 512 } as const;

/**
 * Whether a call hands the Date to `parameter`, the one at `index`: a plain name at its position
 * (or from a spread on); a rest parameter, from its position on, with a spread anywhere in doubt,
 * and an array pattern at its position, whose names the walk takes for the Date, as it does not tell
 * the positions of a list apart; not an object pattern, whose members are not the Date.
 */
function handsPosition(parameter: ParameterDeclaration, index: number, handed: Handed): boolean {
  if (parameter.dotDotDotToken !== undefined) {
    return (
      isIdentifier(parameter.name) &&
      (handed.from !== Infinity || [...handed.at].some((position) => position >= index))
    );
  }
  return (
    (isIdentifier(parameter.name) || isArrayBindingPattern(parameter.name)) &&
    (handed.at.has(index) || index >= handed.from)
  );
}

function answersHandedDate(fn: Answering, handed: Handed, fresh: DatedQueries['fresh']): boolean {
  const parameters = parametersOf(fn).filter((parameter, index) =>
    handsPosition(parameter, index, handed),
  );
  if (parameters.length === 0) return false;
  const question = `${String(fn.pos)}:${parameters.map((each) => String(each.pos)).join(',')}`;
  const key = `${question}|${[...ASSUMED].map((each) => String(each.pos)).join(',')}`;
  // A call that hands the same parameters again asks what is being asked: it is cut. One that hands
  // the Date to another parameter is another question, asked once for each set of parameters.
  if (ASKED.has(question)) {
    ASKING.cut += 1;
    return false;
  }
  // A function that answers a call of itself, handed a Date, may answer it on another path than
  // the one in hand reads: the walk takes it for an answer that is the Date.
  if (answersItself(fn)) return true;
  const known = ANSWERED.get(key);
  if (known !== undefined) return known;
  // A question that asks more than any plausible helper's answers is taken to be answered yes.
  if (ASKING.asked >= BUDGET.asks) return true;
  ASKING.asked += 1;
  const cutBefore = ASKING.cut;
  ASKING.depth += 1;
  ASKED.add(question);
  for (const parameter of parameters) ASSUMED.add(parameter);
  try {
    const answer = returnedBy(fn).some((returned) => fresh(returned, !isArrowFunction(fn)));
    // An answer found while a function that is asked again was cut is not final: it is not kept.
    if (ASKING.cut === cutBefore) ANSWERED.set(key, answer);
    return answer;
  } finally {
    ASKED.delete(question);
    for (const parameter of parameters) ASSUMED.delete(parameter);
    ASKING.depth -= 1;
    if (ASKING.depth === 0) {
      ANSWERED.clear();
      ASKING.asked = 0;
      ASKING.cut = 0;
    }
  }
}

/**
 * What the callback of `map`, `flatMap` or `Array.from` answers of the elements of `receiver`: an
 * inline callback's returns (its parameter asks the receiver), or those of a function of the file
 * handed the slots `slots` (the element, and for `map` and `flatMap` the array after the index) when the
 * receiver carries a Date. A callback the code does not show answers none.
 */
export function mappedResultCarriesDated(
  callback: Expression | undefined,
  receiver: Expression,
  queries: DatedQueries,
  slots: ReadonlySet<number> = new Set([0]),
): boolean {
  const target = callback === undefined ? undefined : unwrapped(callback);
  if (target === undefined) return false;
  if (isArrowFunction(target) || isFunctionExpression(target)) {
    return !answersLater(target) && returnedBy(target).some((returned) => queries.shared(returned));
  }
  const functions = functionsOf(target);
  if (functions.length === 0 || !queries.fresh(receiver)) return false;
  const handed: Handed = { at: slots, from: Infinity };
  return functions.some((fn) => answersHandedDate(fn, handed, queries.fresh));
}

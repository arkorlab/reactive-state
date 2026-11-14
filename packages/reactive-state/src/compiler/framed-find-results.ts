import {
  type CallExpression,
  type Expression,
  isArrowFunction,
  isBlock,
  isIdentifier,
  isOmittedExpression,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { immediateMember, quietSource } from './framed-copy-guards.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { framedAppliedArguments } from './framed-keys.ts';
import { framedCondition } from './framed-sources.ts';

/**
 * Native find and findLast with an async predicate, whose Promise is always truthy, answer the
 * first or the last element they visit, a hole read as undefined.
 */

/**
 * The element an immediately member-read find or findLast of a quiet written source answers for
 * an async arrow predicate with a written constant body and plain parameters: none for a hole, and
 * no proof for other forms.
 */
export function asyncFoundElements(
  call: CallExpression,
  receiver: Expression,
  method: string,
  stable: (receiver: Expression) => boolean,
): readonly Expression[] | undefined {
  const given = foundArguments(call);
  const argument = given?.[0];
  const predicate = argument === undefined ? undefined : unwrapped(argument);
  if (
    given === undefined ||
    predicate === undefined ||
    !isArrowFunction(predicate) ||
    !answersLater(predicate) ||
    isBlock(predicate.body) ||
    framedCondition(predicate.body) === undefined ||
    predicate.parameters.some(
      (each) => !(isIdentifier(each.name) && each.initializer === undefined),
    ) ||
    !immediateMember(call)
  )
    return undefined;
  const quiet = quietSource({ call, receiver, given }, given.slice(1), stable);
  if (quiet === undefined) return undefined;
  const { elements } = quiet.source;
  const element = method === 'findLast' ? elements.at(-1) : elements[0];
  if (element === undefined || isOmittedExpression(element)) return [];
  return iteratorCarriedUnexposed(quiet.roots, [{ value: element }], call) ? [element] : undefined;
}

/** A direct call's arguments, or a known borrowed call's after its receiver. */
function foundArguments(call: CallExpression): readonly Expression[] | undefined {
  const borrowed = borrowedTextCall(call);
  if (borrowed === undefined) return call.arguments;
  return borrowed.applied === undefined
    ? borrowed.given
    : framedAppliedArguments(call, borrowed.applied);
}

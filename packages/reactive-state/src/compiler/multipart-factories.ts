import {
  type CallExpression,
  type Expression,
  isIdentifier,
  isSpreadElement,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering, returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { parameterOf } from './framed.ts';
import { metadataCallee } from './input-callees.ts';

/**
 * What a call of a function the source writes can answer, for the multipart check: a `Response`
 * body or `Request` options made by a helper, `new Response(makeBody())`, read where it returns.
 */

/**
 * The expressions a call of a source-written synchronous function can return: each `return` of its
 * body, whatever the control flow, and the argument written at the call for a parameter it returns
 * as it is. None for a callee the source does not show, an `async` function, which answers a
 * promise, or a generator, which answers an iterator.
 */
export function factoryReturns(call: CallExpression): readonly Expression[] | undefined {
  const callee = metadataCallee(call.expression);
  if (callee === undefined || !isAnswering(callee) || answersLater(callee)) {
    return undefined;
  }
  const returned: Expression[] = [];
  for (const value of returnedBy(callee)) {
    returned.push(value);
    const given = passedArgument(value, callee, call);
    if (given !== undefined) {
      returned.push(given);
    }
  }
  return returned;
}

/** The argument a call writes for the parameter that `value` returns, when `value` is that name. */
function passedArgument(
  value: Expression,
  callee: Answering,
  call: CallExpression,
): Expression | undefined {
  const name = unwrapped(value);
  const parameter = isIdentifier(name) ? parameterOf(name) : undefined;
  const index = parameter === undefined ? -1 : callee.parameters.indexOf(parameter);
  if (index === -1 || call.arguments.slice(0, index + 1).some((each) => isSpreadElement(each))) {
    return undefined;
  }
  return call.arguments[index];
}

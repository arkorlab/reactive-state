import { type CallExpression, type Expression, isSpreadElement } from 'typescript/ast';

import { answersLater, isAnswering, overloadsOf, returnedBy } from './answers.ts';
import { metadataCallee } from './input-callees.ts';

/**
 * What a call of a function the source writes can answer, for the multipart check: a `Response`
 * body or `Request` options made by a helper, `new Response(makeBody())`, read where it returns.
 */

export interface SourceFactory {
  /** What the call gives it: each argument, a spread one by what it spreads. */
  readonly given: readonly Expression[];
  /** What it can return: each `return` of its body, whatever the control flow. */
  readonly returned: readonly Expression[];
}

/**
 * A call of a source-written synchronous function: what it returns and what it is given. The
 * result may be what it is given (`return body`, `{ body }`, `flag ? a : b`), which the check does
 * not follow into the function by parameter: a caller reads the arguments as well. A function
 * declared over overloads is its implementation. None for a callee the source does not show, one
 * without a body, an `async` function, which answers a promise, or a generator, which answers an
 * iterator.
 */
export function sourceFactory(call: CallExpression): SourceFactory | undefined {
  const resolved = metadataCallee(call.expression);
  const callee =
    resolved !== undefined && isAnswering(resolved)
      ? overloadsOf(resolved).find((each) => each.body !== undefined)
      : undefined;
  if (callee === undefined || answersLater(callee)) {
    return undefined;
  }
  return {
    given: call.arguments.map((each) => (isSpreadElement(each) ? each.expression : each)),
    returned: returnedBy(callee),
  };
}

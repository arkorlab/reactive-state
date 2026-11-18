import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isConditionalExpression,
  isIdentifier,
  isNewExpression,
  isParameterDeclaration,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { frameDeclarationOf } from '../src/compiler/framed-bindings.ts';
import {
  type DatedQueries,
  handedNameCarries,
  helperResultCarriesDated,
} from '../src/compiler/render-tag-date-helper-results.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * What a function of the file answers of a Date it is handed is asked once for each function and
 * each set of parameters handed one, whatever the number of calls that lead to it: a chain of
 * helpers that each call the next one twice, once for each branch of a flag, is one question per
 * helper. The questions the module puts are counted with the tag's own reading of a Date stood in
 * by a few lines, as the compiler's whole walk of a tag asks more of these helpers than this module
 * does.
 */
const HELPERS = 23;
const QUESTIONS = { most: 20 * HELPERS } as const;

function chain(end: string): string {
  const helpers = Array.from({ length: HELPERS }, (_, index) => {
    const next = `h${String(index + 1)}`;
    return `const h${String(index)}=(value:unknown,flag:boolean):unknown=>flag?${next}(value,true):${next}(value,false);`;
  });
  return [
    ...helpers,
    `const h${String(HELPERS)}=(value:any,_flag:boolean):unknown=>${end};`,
    'export const answer=h0(new Date(0),true);',
  ].join('');
}

function firstCall(root: Node): CallExpression {
  let found: CallExpression | undefined;
  const visit = (node: Node): void => {
    if (found === undefined && isCallExpression(node)) {
      const callee = unwrapped(node.expression);
      if (isIdentifier(callee) && callee.text === 'h0') found = node;
    }
    node.forEachChild(visit);
  };
  visit(root);
  if (found === undefined) throw new Error('the chain has no call of its first helper');
  return found;
}

describe('the answers of a chain of helpers that branch into the next helper', () => {
  it.each([
    { id: 'ending-in-the-time', end: 'value.getTime()', answer: false },
    { id: 'ending-in-the-value', end: 'value', answer: true },
  ])('$id', ({ end, answer }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'helper-result-queries.ts', chain(end));
    const call = firstCall(parsed.sourceFile);
    let asked = 0;
    const queries: DatedQueries = {
      fresh: (expression) => {
        asked += 1;
        return carries(expression);
      },
      shared: (expression) => carries(expression),
    };

    function carries(expression: Expression): boolean {
      const value = unwrapped(expression);
      if (isConditionalExpression(value))
        return carries(value.whenTrue) || carries(value.whenFalse);
      if (isCallExpression(value)) return helperResultCarriesDated(value, queries);
      if (isNewExpression(value)) return true;
      if (!isIdentifier(value)) return false;
      const declared = frameDeclarationOf(value);
      return (
        declared !== undefined &&
        isParameterDeclaration(declared) &&
        handedNameCarries(value, declared) === true
      );
    }

    expect(helperResultCarriesDated(call, queries)).toBe(answer);
    expect(asked).toBeLessThan(QUESTIONS.most);
  });
});

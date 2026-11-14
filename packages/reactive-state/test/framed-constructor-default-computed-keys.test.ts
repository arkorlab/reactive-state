import {
  type CallExpression,
  type ConstructorDeclaration,
  isCallExpression,
  isConstructorDeclaration,
  isNewExpression,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedConstructorDefaultEvaluation } from '../src/compiler/framed-constructor-default-evaluation.ts';

/**
 * A default read of a field of what a construction supplies reads the field the literal holds at
 * last: a key the code computes after the field, `['message']`, may replace it, with a value the
 * default cannot tell — the read is then no more quiet than a read of any value. A computed key
 * before the field is replaced by it. The rows marked a pin answer the same before the change as
 * after it.
 */

const FAILURE =
  'class Failure extends Error { constructor(fallback: unknown, options = fallback as { message: { inner: unknown } }) { super(options.message.inner as never); } }';

const CASES = [
  {
    quiet: false,
    supplied: "{ message: { inner: error }, ['message']: replaced() }",
    what: 'a field a computed key replaces',
  },
  {
    quiet: false,
    supplied: '{ message: { inner: error }, [key]: other }',
    what: 'a field an unread key may replace',
  },
  {
    quiet: true,
    supplied: '{ [key]: other, message: { inner: error } }',
    what: 'a field after an unread key (pin)',
  },
  { quiet: true, supplied: '{ message: { inner: error } }', what: 'a field alone (pin)' },
  {
    quiet: false,
    supplied: "{ ['message']: { inner: error } }",
    what: 'a computed key alone (pin)',
  },
] as const;

describe('a constructor default read of a field a computed key may replace', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `Failure`'s default evaluation is quiet, constructed of `supplied`. */
  function quietOf(supplied: string): boolean {
    using parsed = api.createSourceFile(
      'framed-constructor-defaults.ts',
      [
        'declare const error: Error;',
        'declare const key: string;',
        'declare const other: unknown;',
        'declare function replaced(): { inner: unknown };',
        FAILURE,
        `new Failure(${supplied});`,
      ].join('\n'),
    );
    let constructor: ConstructorDeclaration | undefined;
    let made: NewExpression | undefined;
    let call: CallExpression | undefined;
    const visit = (node: Node): void => {
      if (isConstructorDeclaration(node)) constructor = node;
      if (isNewExpression(node)) made = node;
      if (isCallExpression(node) && node.expression.kind === SyntaxKind.SuperKeyword) call = node;
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (constructor === undefined || made === undefined || call === undefined) {
      throw new Error(`No construction of Failure of ${supplied}.`);
    }
    const slots = (made.arguments ?? []).map((value) => [{ keys: [], value }]);
    return framedConstructorDefaultEvaluation(constructor.parameters, slots, call.arguments);
  }

  it.each(CASES)('$what', ({ quiet, supplied }) => {
    expect(quietOf(supplied)).toBe(quiet);
  });
});

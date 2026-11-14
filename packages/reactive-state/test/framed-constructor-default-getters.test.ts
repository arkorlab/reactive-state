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
 * A default read through a getter of what a construction supplies runs the getter's code: the
 * default's evaluation is quiet only where what the getter returns is — `return error`, not a call
 * of the application's or an expression of several, which may change what the default reads. The
 * rows marked a pin answer the same before the change as after it.
 */

const FAILURE =
  'class Failure extends Error { constructor(a: { x: unknown }, message = a.x) { super(message as never); } }';

const CASES = [
  {
    quiet: false,
    supplied: '{ get x() { return mutate(); } }',
    what: 'a getter of a call',
  },
  {
    quiet: false,
    supplied: '{ get x() { return (mutate(), error); } }',
    what: 'a getter of a comma',
  },
  {
    quiet: false,
    supplied: '{ get x() { return holder.value; } }',
    what: 'a getter of a member read',
  },
  { quiet: true, supplied: '{ get x() { return error; } }', what: 'a getter of a name (pin)' },
  { quiet: true, supplied: "{ get x() { return 'fixed'; } }", what: 'a getter of text (pin)' },
  { quiet: true, supplied: '{ x: error }', what: 'a field (pin)' },
] as const;

describe('a constructor default read through a getter', () => {
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
        'declare const holder: { value: unknown };',
        'declare function mutate(): unknown;',
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

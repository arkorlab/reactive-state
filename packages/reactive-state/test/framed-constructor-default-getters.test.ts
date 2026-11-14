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
 * of the application's or an expression of several, which may change what the default reads.
 * The scan no longer follows what a construction supplies: a default, or a `super` argument,
 * that reads a member, an element or a pattern is not quiet whatever is supplied. The rows marked a
 * pin answer the same before that change as after it; those marked "was quiet" answered true
 * before it.
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
  {
    quiet: false,
    supplied: '{ get x() { return error; } }',
    what: 'a getter of a name (was quiet)',
  },
  {
    quiet: false,
    supplied: "{ get x() { return 'fixed'; } }",
    what: 'a getter of text (was quiet)',
  },
  { quiet: false, supplied: '{ x: error }', what: 'a field (was quiet)' },
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
    return framedConstructorDefaultEvaluation(constructor.parameters, call.arguments);
  }

  it.each(CASES)('$what', ({ quiet, supplied }) => {
    expect(quietOf(supplied)).toBe(quiet);
  });
});

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
 * A spread in JSX, `<div {...props} />`, copies the own fields of what it spreads, a getter's
 * return among them, as a spread in an object literal does, and `{...items}` as a child iterates
 * it: the application's own code, so a default that holds one is not quiet.
 * The scan no longer follows what a construction supplies: a default, or a `super` argument,
 * that reads a member, an element or a pattern is not quiet whatever is supplied. The `super`
 * argument of these rows is plain, so that it is the JSX the scan answers for.
 */

/** A constructor whose default `view` is the element `element`, with a `super` argument that reads nothing. */
const viewOf = (element: string): string =>
  `class Failure extends Error { constructor(props: any, view = ${element}) { super('fixed'); } }`;

const MADE = 'new Failure({ get x() { return mutate(); } })';

const CASES = [
  {
    made: MADE,
    quiet: false,
    source: viewOf('<div {...props} />'),
    what: 'a spread of a parameter',
  },
  {
    made: MADE,
    quiet: false,
    source: viewOf('<Wrap {...props} />'),
    what: 'a spread into a component',
  },
  {
    made: MADE,
    quiet: false,
    source: viewOf('<div a="1" {...props} />'),
    what: 'a spread beside an attribute',
  },
  {
    made: MADE,
    quiet: false,
    source: viewOf('<div>{...props}</div>'),
    what: 'a spread as a child',
  },
  {
    made: MADE,
    quiet: false,
    source: viewOf('<div {...{ a: 1 }} />'),
    what: 'a spread of a written literal',
  },
  {
    made: MADE,
    quiet: true,
    source: viewOf('<div a="1" />'),
    what: 'an element of a written attribute, with no spread',
  },
  {
    made: MADE,
    quiet: false,
    source: viewOf('<div a={props.a} />'),
    what: 'an element of an attribute that reads a member (pin)',
  },
] as const;

describe('a constructor default beside a spread in JSX', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the default evaluation of the class `source` is quiet, constructed as `made`. */
  function quietOf(source: string, made: string): boolean {
    using parsed = api.createSourceFile(
      'framed-constructor-jsx-spreads.tsx',
      [
        'declare const error: Error;',
        'declare function mutate(): unknown;',
        'declare function Wrap(props: object): unknown;',
        source,
        `${made};`,
      ].join('\n'),
    );
    let constructor: ConstructorDeclaration | undefined;
    let construction: NewExpression | undefined;
    let call: CallExpression | undefined;
    const visit = (node: Node): void => {
      if (isConstructorDeclaration(node)) constructor = node;
      if (isNewExpression(node) && node.expression.getText() === 'Failure') construction = node;
      if (isCallExpression(node) && node.expression.kind === SyntaxKind.SuperKeyword) call = node;
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (constructor === undefined || construction === undefined || call === undefined) {
      throw new Error(`No construction of Failure as ${made}.`);
    }
    return framedConstructorDefaultEvaluation(constructor.parameters, call.arguments);
  }

  it.each(CASES)('$what', ({ made, quiet, source }) => {
    expect(quietOf(source, made)).toBe(quiet);
  });
});

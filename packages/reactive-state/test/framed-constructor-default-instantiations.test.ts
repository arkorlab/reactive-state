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
 * An instantiation expression, `a.x<string>`, `make()<string>`, is a type node of TypeScript's
 * syntax tree whose expression runs: a call, a construction, a read of a getter. A default is
 * quiet only where that expression is, so the scan does not leave it out with the types written
 * beside it.
 * The scan no longer follows what a construction supplies: a default, or a `super` argument,
 * that reads a member, an element or a pattern is not quiet whatever is supplied. The rows marked a
 * pin answer the same before that change as after it; those marked "was quiet" answered true
 * before it.
 */

/** A constructor whose default is the expression `init`. */
const defaultOf = (init: string): string =>
  `class Failure extends Error { constructor(a: any, message = ${init}) { super(message as never); } }`;

/** A constructor whose `super` argument is the expression `init`. */
const argumentOf = (init: string): string =>
  `class Failure extends Error { constructor(a: any) { super(${init} as never); } }`;

const CASES = [
  {
    made: 'new Failure({})',
    quiet: false,
    source: defaultOf('make()<string>'),
    what: 'a call instantiated',
  },
  {
    made: 'new Failure({})',
    quiet: false,
    source: defaultOf('new Maker()<string>'),
    what: 'a construction instantiated',
  },
  {
    made: 'new Failure({ get x() { return mutate(); } })',
    quiet: false,
    source: defaultOf('a.x<string>'),
    what: 'a getter of a call read instantiated',
  },
  {
    made: 'new Failure(holder)',
    quiet: false,
    source: defaultOf('a.x<string>'),
    what: 'an unknown value read instantiated',
  },
  {
    made: 'new Failure({})',
    quiet: false,
    source: argumentOf('make()<string>'),
    what: 'a call instantiated as the super argument',
  },
  {
    made: 'new Failure({ x: 0 })',
    quiet: false,
    source: defaultOf('a.x<string>'),
    what: 'a field read instantiated (was quiet)',
  },
  {
    made: 'new Failure({ message: "fixed" })',
    quiet: false,
    source: defaultOf('a.message as string'),
    what: 'a field read with a type written beside it (was quiet)',
  },
  {
    made: 'new Failure({ get x() { return mutate(); } })',
    quiet: false,
    source: defaultOf('a.x'),
    what: 'a getter of a call read (pin)',
  },
  {
    made: 'new Failure({})',
    quiet: false,
    source: defaultOf('make()'),
    what: 'a call (pin)',
  },
] as const;

describe('a constructor default beside an instantiation expression', () => {
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
      'framed-constructor-instantiations.ts',
      [
        'declare const holder: never;',
        'declare function mutate(): unknown;',
        'declare function make(): <T>(value?: T) => T;',
        'declare class Maker {}',
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

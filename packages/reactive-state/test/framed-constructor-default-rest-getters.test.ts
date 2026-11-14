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
 * An object rest copies each own field of what its pattern takes apart, and so runs each getter
 * of a supplied literal: the copy is quiet only where what every getter returns is — not a call of
 * the application's, nor a getter of statements before its return. An array rest of an array
 * literal reads its elements alone.
 * The scan no longer follows what a construction supplies: a default, or a `super` argument,
 * that reads a member, an element or a pattern is not quiet whatever is supplied. The rows marked a
 * pin answer the same before that change as after it; those marked "was quiet" answered true
 * before it.
 */

/** A constructor whose default is read along a path, beside a parameter of an object rest. */
const REST =
  'class Failure extends Error { constructor(fallback: unknown, { ...rest }: { fix: unknown }, options = fallback as { message: unknown }) { super(options.message as never); } }';

/** The same, of a rest inside the parameter's pattern. */
const NESTED =
  'class Failure extends Error { constructor(fallback: unknown, { inner: { ...rest } }: { inner: { fix: unknown } }, options = fallback as { message: unknown }) { super(options.message as never); } }';

/** The same, of an array rest. */
const ELEMENTS =
  'class Failure extends Error { constructor(fallback: unknown, [first, ...rest]: unknown[], options = fallback as { message: unknown }) { super(options.message as never); } }';

const CASES = [
  {
    made: 'new Failure({ message: error }, { get fix() { return mutate(); } })',
    quiet: false,
    source: REST,
    what: 'a getter of a call copied',
  },
  {
    made: 'new Failure({ message: error }, { fix: 0, get other() { return mutate(); } })',
    quiet: false,
    source: REST,
    what: 'a getter beside a field copied',
  },
  {
    made: 'new Failure({ message: error }, { get fix() { mutate(); return 0; } })',
    quiet: false,
    source: REST,
    what: 'a getter of statements copied',
  },
  {
    made: 'new Failure({ message: error }, { inner: { get fix() { return mutate(); } } })',
    quiet: false,
    source: NESTED,
    what: 'a getter copied by a nested rest',
  },
  {
    made: 'new Failure({ message: error }, { get fix() { return 0; } })',
    quiet: false,
    source: REST,
    what: 'a getter of a number copied (was quiet)',
  },
  {
    made: 'new Failure({ message: error }, { fix: 0 })',
    quiet: false,
    source: REST,
    what: 'a field copied (was quiet)',
  },
  {
    made: 'new Failure({ message: error }, holder)',
    quiet: false,
    source: REST,
    what: 'an unknown value copied (pin)',
  },
  {
    made: 'new Failure({ message: error }, [0, 1])',
    quiet: false,
    source: ELEMENTS,
    what: 'an array rest of an array (was quiet)',
  },
] as const;

describe('a constructor default beside a rest of a parameter pattern', () => {
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
      'framed-constructor-patterns.ts',
      [
        'declare const error: Error;',
        'declare const holder: never;',
        'declare function mutate(): unknown;',
        source,
        `${made};`,
      ].join('\n'),
    );
    let constructor: ConstructorDeclaration | undefined;
    let construction: NewExpression | undefined;
    let call: CallExpression | undefined;
    const visit = (node: Node): void => {
      if (isConstructorDeclaration(node)) constructor = node;
      if (isNewExpression(node)) construction = node;
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

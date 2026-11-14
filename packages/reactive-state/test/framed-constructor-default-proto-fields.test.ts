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
 * In an object literal `__proto__: value` — written as a name or as a string — sets the object's
 * prototype and makes no own field, so a read of `__proto__` through it is the inherited accessor's:
 * what a getter of the prototype returns, the application's code. Such a read is no shown ordinary
 * field, as the default's own checks have it. A key the literal does write, beside a prototype it
 * sets, is read as before, and so is an own `__proto__` a getter or a shorthand makes, whichever
 * comes first: it stands before the prototype's inherited one.
 * The scan no longer follows what a construction supplies: a default, or a `super` argument,
 * that reads a member, an element or a pattern is not quiet whatever is supplied. The rows marked a
 * pin answer the same before that change as after it; those marked "was quiet" answered true
 * before it.
 */

/** A constructor whose default reads a member of its first argument. */
const MEMBER =
  'class Failure extends Error { constructor(a: any, message = a.message) { super(message); } }';

/** The same, of the member `__proto__`. */
const PROTO =
  'class Failure extends Error { constructor(a: any, message = a.__proto__) { super(message); } }';

/** The same, of the member `__proto__` as an element key. */
const ELEMENT =
  'class Failure extends Error { constructor(a: any, message = a["__proto__"]) { super(message); } }';

/** A constructor whose default is read beside a parameter pattern that takes `__proto__`. */
const PATTERN =
  'class Failure extends Error { constructor(fallback: any, { __proto__: parent }: any, options = fallback as { message: unknown }) { super(options.message as never); } }';

const CASES = [
  {
    made: 'new Failure({ __proto__: { get __proto__() { return mutate(); } } })',
    quiet: false,
    source: PROTO,
    what: 'a prototype whose getter is read as the member',
  },
  {
    made: 'new Failure({ "__proto__": { get __proto__() { return mutate(); } } })',
    quiet: false,
    source: PROTO,
    what: 'a prototype written as a string',
  },
  {
    made: 'new Failure({ __proto__: { get __proto__() { return mutate(); } } })',
    quiet: false,
    source: ELEMENT,
    what: 'a prototype read by an element key',
  },
  {
    made: 'new Failure({ __proto__: { message: error } })',
    quiet: false,
    source: PROTO,
    what: 'a prototype of fields',
  },
  {
    made: 'new Failure({ message: error }, { __proto__: { get __proto__() { return mutate(); } } })',
    quiet: false,
    source: PATTERN,
    what: 'a prototype a parameter pattern takes by its key',
  },
  {
    made: 'new Failure({ __proto__: null, message: "fixed" })',
    quiet: false,
    source: MEMBER,
    what: 'a null prototype beside a field read (was quiet)',
  },
  {
    made: 'new Failure({ __proto__: { x: 1 }, message: "fixed" })',
    quiet: false,
    source: MEMBER,
    what: 'a prototype beside a field read (was quiet)',
  },
  {
    made: 'new Failure({ __proto__: null })',
    quiet: false,
    source: MEMBER,
    what: 'a null prototype and no field read (pin)',
  },
  {
    made: 'new Failure({ get __proto__() { return 0; } })',
    quiet: false,
    source: PROTO,
    what: 'an own getter of a number (was quiet)',
  },
  {
    made: 'new Failure({ get __proto__() { return mutate(); } })',
    quiet: false,
    source: PROTO,
    what: 'an own getter of a call (pin)',
  },
  {
    made: 'new Failure({ __proto__ })',
    quiet: false,
    source: PROTO,
    what: 'an own shorthand field (was quiet)',
  },
  {
    made: 'new Failure({ message: error }, { __proto__: holder })',
    quiet: false,
    source: PATTERN,
    what: 'an unknown prototype a parameter pattern takes by its key',
  },
  {
    made: 'new Failure({ __proto__: null, get __proto__() { return 0; } })',
    quiet: false,
    source: PROTO,
    what: 'an own getter after a prototype (was quiet)',
  },
  {
    made: 'new Failure({ get __proto__() { return 0; }, __proto__: null })',
    quiet: false,
    source: PROTO,
    what: 'an own getter before a prototype (was quiet)',
  },
  {
    made: 'new Failure({ __proto__: null, __proto__ })',
    quiet: false,
    source: PROTO,
    what: 'an own shorthand after a prototype (was quiet)',
  },
  {
    made: 'new Failure({ __proto__, __proto__: null })',
    quiet: false,
    source: PROTO,
    what: 'an own shorthand before a prototype (was quiet)',
  },
  {
    made: 'new Failure({ __proto__: null, get __proto__() { return 0; } })',
    quiet: false,
    source: ELEMENT,
    what: 'an own getter beside a prototype, read by an element key (was quiet)',
  },
  {
    made: 'new Failure({ message: error }, { __proto__: null, get __proto__() { return 0; } })',
    quiet: false,
    source: PATTERN,
    what: 'an own getter beside a prototype, taken by a parameter pattern (was quiet)',
  },
  {
    made: 'new Failure({ __proto__: null, get __proto__() { return mutate(); } })',
    quiet: false,
    source: PROTO,
    what: 'an own getter of a call beside a prototype (pin)',
  },
  {
    made: 'new Failure({ __proto__: null, ["__proto__"]: 0 })',
    quiet: false,
    source: PROTO,
    what: 'a computed key beside a prototype (pin)',
  },
  {
    made: 'new Failure({ ...holder, __proto__: null })',
    quiet: false,
    source: PROTO,
    what: 'a spread beside a prototype (pin)',
  },
] as const;

describe('a constructor default beside a read of a literal member named __proto__', () => {
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
      'framed-constructor-proto-fields.ts',
      [
        'declare const error: Error;',
        'declare const holder: never;',
        'declare const __proto__: number;',
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

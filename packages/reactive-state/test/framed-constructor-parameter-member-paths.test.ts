import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedSubclassMessages } from '../src/compiler/framed-subclass-messages.ts';

/**
 * A parameter that a `super` argument reads along a member path, `options.message` of
 * `constructor(options: { message: unknown })`, passes on what the construction gives at that
 * path. Where the construction gives an `Error` there, or an object that holds one a key before
 * the last, the path reads into a value the compile cannot read into: a member of an `Error` is
 * the words each engine writes, which a direct read of `error.message` is refused for, and the
 * path alone shows no field. So what the read selects a member of is forwarded whole as well,
 * each given value read up to the key before the last (or up to the keys read, where a later one
 * is not). An object or an array written as a literal and read by one key is not: the path
 * resolves the member it holds, so `['fixed', error]` read at `[0]` stays what it holds. The rows
 * say which written argument is forwarded at which path; a row that is not forwarded pins an
 * argument no read selects, which stays unread. The rows marked a pin answer the same before the
 * change as after it.
 */

interface Case {
  /** Whether the construction's written `supplied` argument is forwarded at `path`. */
  readonly forwarded: boolean;
  /** The member path, its keys joined by dots; `*` is any member after it (a key not read). */
  readonly path: string;
  readonly source: string;
  readonly supplied: string;
  readonly what: string;
}

const WRAPPED =
  'class Wrapped extends Error { constructor(options: { message: unknown }) { super(options.message as never); } }';

const CASES: readonly Case[] = [
  {
    forwarded: true,
    path: '',
    source: `${WRAPPED} new Wrapped(error);`,
    supplied: 'error',
    what: 'a member of a parameter with no default, given an Error',
  },
  {
    forwarded: true,
    path: 'inner',
    source:
      'class Wrapped extends Error { constructor(options: { inner: { message: unknown } }) { super(options.inner.message as never); } } new Wrapped({ inner: error });',
    supplied: '{ inner: error }',
    what: 'the same one member deeper',
  },
  {
    forwarded: true,
    path: '',
    source:
      'class Wrapped extends Error { constructor({ message }: { message: unknown }) { super(message as never); } } new Wrapped(error);',
    supplied: 'error',
    what: 'a name a pattern binds',
  },
  {
    forwarded: true,
    path: 'inner',
    source:
      'class Wrapped extends Error { constructor({ inner: { message } }: { inner: { message: unknown } }) { super(message as never); } } new Wrapped({ inner: error });',
    supplied: '{ inner: error }',
    what: 'a name a nested pattern binds',
  },
  {
    forwarded: true,
    path: '0',
    source:
      'class Wrapped extends Error { constructor(list: { message: unknown }[]) { super(list[0]!.message as never); } } new Wrapped([error]);',
    supplied: '[error]',
    what: 'an element, then a member',
  },
  {
    forwarded: true,
    path: '',
    source:
      'class Wrapped extends Error { constructor(...args: { message: unknown }[]) { super(args[0]!.message as never); } } new Wrapped(error);',
    supplied: 'error',
    what: 'a member of an argument a rest parameter holds',
  },
  {
    forwarded: true,
    path: '',
    source:
      'class Wrapped extends Error { constructor(options?: { message: unknown }) { super(options?.message as never); } } new Wrapped(error);',
    supplied: 'error',
    what: 'a member by an optional chain',
  },
  {
    forwarded: true,
    path: '',
    source:
      'class Wrapped extends Error { constructor(options: Record<string, unknown>, key: string) { super(options[key] as never); } } new Wrapped(error, "message");',
    supplied: 'error',
    what: 'a member by a key the compile cannot read',
  },
  {
    forwarded: true,
    path: '',
    source:
      'class Failure extends Error { constructor(fallback: unknown, options = fallback as { message: unknown }) { super(options.message as never); } } new Failure(undefined, error);',
    supplied: 'error',
    what: 'an Error given to a parameter that has a default',
  },
  {
    forwarded: true,
    path: '',
    source:
      'class Mid extends Error { constructor(options: { message: unknown }) { super(options.message as never); } } class Wrapped extends Mid { constructor(options: { message: unknown }) { super(options); } } new Wrapped(error);',
    supplied: 'error',
    what: 'a member read by the base of a subclass that passes the parameter on',
  },
  {
    forwarded: true,
    path: '',
    source:
      'declare const errors: Error[]; class Wrapped extends Error { constructor(list: unknown[]) { super(list[0] as never); } } new Wrapped(errors);',
    supplied: 'errors',
    what: 'an element of an array the construction names, whose elements are Errors',
  },
  {
    forwarded: false,
    path: '',
    source:
      "class Wrapped extends Error { constructor(list: unknown[]) { super(list[0] as never); } } new Wrapped(['fixed', error]);",
    supplied: "['fixed', error]",
    what: 'an element of a literal array that holds the Error at another index (pin)',
  },
  {
    forwarded: false,
    path: '',
    source: `${WRAPPED} new Wrapped({ message: 'fixed', other: error });`,
    supplied: 'error',
    what: 'an Error held by a member no read selects (pin)',
  },
  {
    forwarded: false,
    path: '',
    source:
      'class Wrapped extends Error { constructor(...args: unknown[]) { super(args[1] as never); } } new Wrapped(error, "fixed");',
    supplied: 'error',
    what: 'an argument of a rest parameter no read selects (pin)',
  },
  {
    forwarded: true,
    path: 'message',
    source: `${WRAPPED} new Wrapped({ message: error });`,
    supplied: '{ message: error }',
    what: 'an Error held at the path itself (pin)',
  },
];

/** A `new` of a name, or a `Reflect.construct` call: the constructions the rows write. */
function isConstruction(node: Node): node is Expression {
  if (isNewExpression(node)) return isIdentifier(node.expression);
  return isCallExpression(node) && node.expression.getText() === 'Reflect.construct';
}

const NATIVE_ERRORS: ReadonlySet<string> = new Set(['AggregateError', 'DOMException', 'Error']);

describe('what a parameter with no default forwards along the member path a read selects', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The value pairs, `[written, path]`, the construction forwards to the native base. */
  function forwardedBy(source: string): readonly (readonly [string, string])[] {
    using parsed = api.createSourceFile(
      'framed-constructor-parameter-member-paths.ts',
      ['declare const error: Error;', source].join('\n'),
    );
    let construction: Expression | undefined;
    const visit = (node: Node): void => {
      if (construction === undefined && isConstruction(node)) construction = node;
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (construction === undefined) throw new Error('No construction is written.');
    return (framedSubclassMessages(construction, NATIVE_ERRORS) ?? []).map((each) => {
      return [
        each.value.getText(),
        each.any === true ? [...each.keys, '*'].join('.') : each.keys.join('.'),
      ];
    });
  }

  it.each(CASES)('$what', ({ forwarded, path, source, supplied }) => {
    const found = forwardedBy(source).some(([written, at]) => written === supplied && at === path);

    expect(found).toBe(forwarded);
  });
});

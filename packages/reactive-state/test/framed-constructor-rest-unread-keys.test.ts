import {
  type CallExpression,
  type ConstructorDeclaration,
  isCallExpression,
  isConstructorDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedSlotValues } from '../src/compiler/framed-constructor-parameters.ts';

/**
 * A read of a rest parameter's element along a path whose key the compile cannot read, as
 * `args[0].message[key]` or `args[index].message`, may read any member after the keys it reads:
 * the value the construction supplies there is kept with any member possible, as a read of any
 * other parameter keeps it. The rows marked a pin answer the same before the change as after it.
 */

const CASES = [
  {
    read: '(args[0] as { message: Record<string, unknown> }).message[key]',
    values: [{ any: true, keys: ['message'] }],
    what: 'an unread key after an element',
  },
  {
    read: '(args[index] as { message: unknown }).message',
    values: [{ any: true, keys: [] }],
    what: 'an unread element',
  },
  {
    read: '(args[0] as { message: unknown }).message',
    values: [{ any: false, keys: ['message'] }],
    what: 'a written element and key (pin)',
  },
] as const;

describe('a rest parameter read past a key the compile cannot read', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What the `super` argument `read` may hold of the object the construction supplies. */
  function valuesOf(
    read: string,
  ): readonly { readonly any: boolean; readonly keys: readonly string[] }[] {
    using parsed = api.createSourceFile(
      'framed-constructor-rest.ts',
      [
        'declare const error: Error;',
        'declare const key: string;',
        'declare const index: number;',
        `class Failure extends Error { constructor(...args: unknown[]) { super(${read} as never); } }`,
        'new Failure({ message: { a: error } });',
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
    const [argument] = call?.arguments ?? [];
    if (constructor === undefined || made === undefined || argument === undefined) {
      throw new Error(`No construction of Failure reads ${read}.`);
    }
    const slots = (made.arguments ?? []).map((value) => [{ keys: [], value }]);
    const values = framedSlotValues(argument, constructor.parameters, slots) ?? [];
    return values
      .filter((each) => isObjectLiteralExpression(each.value))
      .map((each) => ({ any: each.any === true, keys: each.keys }));
  }

  it.each(CASES)('$what', ({ read, values }) => {
    expect(valuesOf(read)).toStrictEqual(values);
  });
});

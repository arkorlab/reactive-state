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
 * A name a rest parameter's pattern binds, `...[message = fallback.text]`, takes its element's
 * default where the rest holds no argument there, and the default reads the parameters before it:
 * what a `super` argument forwards through it includes what those parameters were given, as it
 * does through the pattern of any other parameter. Whether the rest holds an argument at the
 * position is not told, so the default may be taken, and is read whole. The rows marked a pin
 * answer the same before the change as after it.
 */

const CASES = [
  {
    declaration: '...[message = fallback.text]: [unknown?]',
    read: 'message',
    values: [{ any: false, keys: ['text'] }],
    what: 'an element default of a rest pattern',
  },
  {
    declaration: '...[{ text = fallback.text }]: [{ text?: unknown }?]',
    read: 'text',
    values: [{ any: false, keys: ['text'] }],
    what: 'a field default of a pattern inside the rest pattern',
  },
  {
    declaration: '...[message]: [unknown?]',
    read: 'message',
    values: [],
    what: 'a rest pattern without a default (pin)',
  },
  {
    declaration: '[message = fallback.text]: [unknown?] = []',
    read: 'message',
    values: [{ any: false, keys: ['text'] }],
    what: 'the same pattern of a parameter that is no rest (pin)',
  },
] as const;

describe('a name a rest parameter pattern binds, beside the default of its element', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What the `super` argument `read` may hold of the object given as `fallback`. */
  function valuesOf(
    declaration: string,
    read: string,
  ): readonly { readonly any: boolean; readonly keys: readonly string[] }[] {
    using parsed = api.createSourceFile(
      'framed-constructor-rest-pattern-defaults.ts',
      [
        'declare const error: Error;',
        `class Failure extends Error { constructor(fallback: { text: unknown }, ${declaration}) { super(${read} as never); } }`,
        'new Failure({ text: { a: error } });',
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

  it.each(CASES)('$what', ({ declaration, read, values }) => {
    expect(valuesOf(declaration, read)).toStrictEqual(values);
  });
});

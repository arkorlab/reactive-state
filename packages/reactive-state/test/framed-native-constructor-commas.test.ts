import { isExpressionStatement } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedNativeConstructor } from '../src/compiler/framed-sources.ts';

/**
 * A comma's value is its last operand's, whatever the operands before it do: `(0, Reflect.get)` is
 * `Reflect.get` itself, called as it is, and a constant of it holds the same. The rows marked a pin
 * answer the same before the change as after it.
 */

const CASES = [
  { native: true, source: '(0, Reflect.get)', what: 'a comma before the function' },
  { native: true, source: '((0), Reflect.get)', what: 'a comma of a parenthesized operand' },
  { native: true, source: '(mutate(), Reflect.get)', what: 'a comma after a call' },
  { native: true, source: 'read', what: 'a constant of a comma' },
  { native: true, source: 'Reflect.get', what: 'the function itself (pin)' },
  { native: false, source: '(Reflect.get, Reflect.has)', what: 'a comma of another (pin)' },
  { native: false, source: '(0, 1)', what: 'a comma of a number (pin)' },
] as const;

describe('a native function read through a comma', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the expression `source` ends its module with is `Reflect.get`. */
  function nativeOf(source: string): boolean {
    using parsed = api.createSourceFile(
      'framed-native-constructor.ts',
      ['declare function mutate(): void;', 'const read = (0, Reflect.get);', `${source};`].join(
        '\n',
      ),
    );
    const last = parsed.sourceFile.statements.at(-1);
    if (last === undefined || !isExpressionStatement(last)) {
      throw new Error(`No expression ends the module of ${source}.`);
    }
    return framedNativeConstructor(last.expression, new Set(['Reflect.get']));
  }

  it.each(CASES)('$what', ({ native, source }) => {
    expect(nativeOf(source)).toBe(native);
  });
});

import {
  type CallExpression,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inputMetadata } from '../src/compiler/input-metadata.ts';

const FROZEN_REASON =
  "calls `Object.isFrozen()` on what may be an input, whose flags differ between the browser's mutable value and the authority's frozen copy";

const CASES = [
  {
    body: 'class Box { constructor(x = (input.n = 1)) {} } return Object.isFrozen(new Box(maybe));',
    expected: FROZEN_REASON,
    id: 'unknown-top-level-default',
  },
  {
    body: 'function pick(): number | undefined { return undefined; } class Box { constructor(x = (input.n = 1)) {} } return Object.isFrozen(new Box(pick()));',
    expected: FROZEN_REASON,
    id: 'call-top-level-default',
  },
  {
    body: 'class Box { constructor(x: { n: number } = input) { return x; } } return Object.isFrozen(new Box(kept));',
    expected: FROZEN_REASON,
    id: 'unknown-top-level-return-input',
  },
  {
    body: 'class Box { constructor({ x = (input.n = 1) }: { x?: number }) {} } return Object.isFrozen(new Box({ x: maybe }));',
    expected: FROZEN_REASON,
    id: 'unknown-property-default',
  },
  {
    body: 'class Box { constructor({ x = input }: { x?: { n: number } }) { return x; } } return Object.isFrozen(new Box({ x: kept }));',
    expected: FROZEN_REASON,
    id: 'unknown-property-return-input',
  },
  {
    body: 'class Box { constructor(...[x = (input.n = 1)]: number[]) {} } return Object.isFrozen(new Box());',
    expected: FROZEN_REASON,
    id: 'empty-rest-array-pattern-default',
  },
  {
    body: 'class Box { constructor(...[x = (input.n = 1)]: Array<number | undefined>) {} } return Object.isFrozen(new Box(maybe));',
    expected: FROZEN_REASON,
    id: 'unknown-rest-array-pattern-default',
  },
  {
    body: 'class Box { constructor(...[, second = (input.n = 1)]: number[]) {} } return Object.isFrozen(new Box(0));',
    expected: FROZEN_REASON,
    id: 'nested-rest-tail-pattern-default',
  },
  {
    body: 'function tag([, second = String((input.n = 1))]: readonly string[]) { return second; } class Box { constructor() { tag`only-one`; } } return Object.isFrozen(new Box());',
    expected: FROZEN_REASON,
    id: 'tag-second-string-default',
  },
  {
    body: 'function tag({ raw: [, second = String((input.n = 1))] }: TemplateStringsArray) { return second; } class Box { constructor() { tag`only-one`; } } return Object.isFrozen(new Box());',
    expected: FROZEN_REASON,
    id: 'tag-raw-second-default',
  },
  {
    body: 'function tag(...[, second = (input.n = 1)]: unknown[]) { return second; } class Box { constructor() { tag`only-one`; } } return Object.isFrozen(new Box());',
    expected: FROZEN_REASON,
    id: 'tag-rest-second-default',
  },
  {
    body: 'class Box { constructor(x = (input.n = 1)) {} } return Object.isFrozen(new Box(0));',
    expected: undefined,
    id: 'defined-top-level-argument',
  },
  {
    body: 'class Box { constructor(x: number | null = (input.n = 1)) {} } return Object.isFrozen(new Box(null));',
    expected: undefined,
    id: 'null-top-level-argument',
  },
  {
    body: 'class Box { constructor(...[x = (input.n = 1)]: number[]) {} } return Object.isFrozen(new Box(0));',
    expected: undefined,
    id: 'defined-rest-array-pattern-argument',
  },
  {
    body: 'class Inner { constructor(value: unknown = input) { return value as Inner; } } class Outer { constructor(...values: unknown[]) { const passed = values; return new Inner(passed); } } return Object.isFrozen(new Outer(input));',
    expected: undefined,
    id: 'rest-array-passed-to-default-parameter',
  },
  {
    body: 'function tag([head = String((input.n = 1))]: readonly string[]) { return head; } class Box { constructor() { tag`present`; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'tag-present-first-string-default',
  },
  {
    body: `function tag([, second = String((input.n = 1))]: readonly string[], _sub: number) { return second; } class Box { constructor() { tag\`a\${0}b\`; } } return Object.isFrozen(new Box());`,
    expected: undefined,
    id: 'tag-present-second-string-with-substitution',
  },
  {
    body: 'function tag({ raw = [(input.n = 1)] as never }: TemplateStringsArray) { return raw.length; } class Box { constructor() { tag`present`; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'tag-present-raw-default',
  },
] as const;

describe('metadata parameter and pattern default selections', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Reads `inputMetadata` on the `Object.isFrozen(...)` call in `body`. */
  function metadataOf(body: string): string | undefined {
    using parsed = api.createSourceFile(
      'input-default-selections.ts',
      `declare const kept: { n: number } | undefined;\nexport function check(input: { n: number }, maybe?: number): boolean { ${body} }\n`,
    );
    let target: CallExpression | undefined;
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (
        isCallExpression(at) &&
        isPropertyAccessExpression(at.expression) &&
        isIdentifier(at.expression.expression) &&
        at.expression.expression.text === 'Object' &&
        at.expression.name.text === 'isFrozen'
      ) {
        target = at;
      }
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    if (target === undefined) {
      throw new Error(`No Object.isFrozen call found in ${body}.`);
    }
    return inputMetadata(target);
  }

  it.each(CASES)('$id', ({ body, expected }) => {
    expect(metadataOf(body)).toBe(expected);
  });
});

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
    body: 'class Box { constructor(public data: { count: number }) { this.data.count++; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'single-constructor-parameter-property-input-write',
  },
  {
    body: 'class Box { constructor(data: { count: number }); constructor(public data: { count: number }) { this.data.count++; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'overloaded-constructor-parameter-property-input-write',
  },
  {
    body: 'class Box { constructor(data: { count: number }); constructor(data: string); constructor(public data: { count: number } | string) { (this.data as { count: number }).count++; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'two-overload-signatures-parameter-property-input-write',
  },
  {
    body: 'class Box { constructor(data: { count: number }); constructor(public data: { count: number }) { this.data.count = 1; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'overloaded-constructor-parameter-property-input-assignment',
  },
  {
    body: 'class Box { constructor(data: { count: number }); constructor(public data: { count: number }) { this.data.count++; } } return Object.isFrozen(new Box({ count: 0 }));',
    expected: undefined,
    id: 'overloaded-constructor-parameter-property-fresh-argument',
  },
  {
    body: 'class Box { constructor(data: { count: number }); constructor(public data: { count: number }) {} } return Object.isFrozen(new Box({ count: 0 }));',
    expected: undefined,
    id: 'overloaded-constructor-without-writes',
  },
  {
    body: 'class Box { data = { count: 0 }; constructor(other: { count: number }); constructor(public other: { count: number }) { this.data.count++; } } return Object.isFrozen(new Box(input));',
    expected: undefined,
    id: 'overloaded-constructor-writes-its-own-fresh-field',
  },
] as const;

describe('metadata writes through the parameter property of an overloaded constructor', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Reads `inputMetadata` on the `Object.isFrozen(...)` call in `body`. */
  function frozenOf(body: string): string | undefined {
    using parsed = api.createSourceFile(
      'input-overloaded-constructor-properties.ts',
      `export function check(input: { count: number }): boolean { ${body} }\n`,
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
    expect(frozenOf(body)).toBe(expected);
  });
});

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
    body: 'class Box { constructor(...items: Array<{ count: number }>) { items[0].count++; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'rest-parameter-member-increment',
  },
  {
    body: 'class Box { constructor(...items: Array<{ count: number }>) { items[0].count = 1; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'rest-parameter-member-assignment',
  },
  {
    body: 'class Box { constructor(...items: Array<{ count?: number }>) { delete items[0].count; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'rest-parameter-member-delete',
  },
  {
    body: 'class Box { constructor(...items: Array<{ count: number }>) { Object.assign(items[0], { count: 1 }); } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'rest-parameter-member-object-assign',
  },
  {
    body: 'class Box { constructor(...items: Array<{ count: number }>) { [items[0].count] = [1]; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'rest-parameter-destructuring-member-write',
  },
  {
    body: 'class Box { constructor([, ...items]: [number, ...Array<{ count: number }>]) { items[0].count++; } } return Object.isFrozen(new Box([0, input]));',
    expected: FROZEN_REASON,
    id: 'array-pattern-rest-member-write',
  },
  {
    body: 'class Box { constructor({ ...rest }: { nested: { count: number } }) { rest.nested.count++; } } return Object.isFrozen(new Box(nestedInput));',
    expected: FROZEN_REASON,
    id: 'object-pattern-rest-member-write',
  },
  {
    body: 'class Box { constructor() { const copy = [...[input]]; copy[0].count++; } } return Object.isFrozen(new Box());',
    expected: FROZEN_REASON,
    id: 'spread-copy-member-write',
  },
  {
    body: 'class Box { constructor() { const copy = { ...nestedInput }; copy.nested.count++; } } return Object.isFrozen(new Box());',
    expected: FROZEN_REASON,
    id: 'object-spread-copy-member-write',
  },
  {
    body: 'class Box { constructor(...items: Array<{ count: number }>) { items[0] = { count: 0 }; } } return Object.isFrozen(new Box(input));',
    expected: undefined,
    id: 'rest-parameter-shallow-element-write',
  },
  {
    body: 'class Box { constructor(...items: Array<{ count: number }>) { Object.freeze(items); } } return Object.isFrozen(new Box(input));',
    expected: undefined,
    id: 'rest-parameter-container-freeze',
  },
  {
    body: 'class Box { constructor(...items: Array<{ count: number }>) { return items; } } return Object.isFrozen(new Box(input));',
    expected: undefined,
    id: 'rest-parameter-returned-fresh-array',
  },
  {
    body: 'class Box { constructor({ ...rest }: { nested: { count: number } }) { rest.nested = { count: 0 }; } } return Object.isFrozen(new Box(nestedInput));',
    expected: undefined,
    id: 'object-rest-shallow-field-write',
  },
  {
    body: "class Box { constructor() { const copy = [...list]; copy[0] = 'changed'; } } return Object.isFrozen(new Box());",
    expected: undefined,
    id: 'spread-copy-shallow-write',
  },
  {
    body: 'class Box { size = 0; constructor(...items: Array<{ count: number }>) { this.size = items.length; Object.freeze(this); } } return Object.isFrozen(new Box(input));',
    expected: undefined,
    id: 'receiver-field-write',
  },
] as const;

describe('metadata writes through retained rest and shallow-copy members', () => {
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
      'input-rest-member-writes.ts',
      `export function check(input: { count: number }, nestedInput: { nested: { count: number } }, list: string[]): boolean { ${body} }
`,
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

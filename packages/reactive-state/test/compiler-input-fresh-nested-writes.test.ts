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
    body: 'class Box { constructor() { const local = { nested: { count: 0 } }; local.nested.count++; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-nested-object-increment',
  },
  {
    body: 'class Box { constructor() { const local = { a: { b: { count: 0 } } }; local.a.b.count = 1; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-deeply-nested-object-write',
  },
  {
    body: 'class Box { constructor() { const items = [{ count: 0 }]; items[0].count++; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-nested-array-element-increment',
  },
  {
    body: "class Box { constructor() { const local = { nested: { count: 0 } }; local['nested'].count++; } } return Object.isFrozen(new Box());",
    expected: undefined,
    id: 'fresh-nested-bracket-key-write',
  },
  {
    body: 'class Box { constructor() { const local = { nested: { count: 0 } }; Object.assign(local.nested, { count: 1 }); } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-nested-object-assign-in-place',
  },
  {
    body: 'class Box { constructor() { const local: { nested: { count?: number } } = { nested: { count: 0 } }; [local.nested.count] = [1]; delete local.nested.count; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-nested-destructuring-and-delete',
  },
  {
    body: 'class Box { constructor() { const local = { nested: { count: 0 } }; const sub = local.nested; sub.count++; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-nested-alias-write',
  },
  {
    body: 'class Box { constructor(config = { nested: { count: 0 } }) { config.nested.count++; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-constructor-default-nested-write',
  },
  {
    body: 'const local = { nested: { count: 0 } }; return Object.isFrozen(local.nested);',
    expected: undefined,
    id: 'direct-is-frozen-on-fresh-nested-member',
  },
  {
    body: 'class Box { constructor() { const local: { nested: { count: number }; other: { count: number } } = { nested: { count: 0 }, other: { count: 0 } }; local.other = input; local.nested.count++; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-nested-unrelated-sibling-slot-write',
  },
  {
    body: 'class Box { data = { count: 0 }; constructor() { this.data.count++; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-receiver-field-nested-increment',
  },
  {
    body: 'class Box { data: { count: number }; constructor() { this.data = { count: 0 }; this.data.count++; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-receiver-constructor-assigned-nested-write',
  },
  {
    body: 'class Box { data = { inner: { count: 0 } }; constructor() { this.data.inner.count++; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-receiver-deeply-nested-field-write',
  },
  {
    body: 'class Box { items = [{ count: 0 }]; constructor() { this.items[0].count++; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-receiver-array-field-element-write',
  },
  {
    body: 'class Box { #data = { count: 0 }; constructor() { this.#data.count++; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-receiver-private-field-nested-write',
  },
  {
    body: 'class Box { data = { count: 0 }; next = ++this.data.count; } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-receiver-field-initializer-only-nested-write',
  },
  {
    body: 'class Box { constructor(public data = { count: 0 }) { this.data.count++; } } return Object.isFrozen(new Box());',
    expected: undefined,
    id: 'fresh-receiver-parameter-property-default-nested-write',
  },
  {
    body: 'class Box { constructor() { const local = { nested: input }; local.nested.count++; } } return Object.isFrozen(new Box());',
    expected: FROZEN_REASON,
    id: 'fresh-container-holding-input-member-write',
  },
  {
    body: 'class Box { constructor() { const local = { nested: { count: 0 } }; local.nested = input; local.nested.count++; } } return Object.isFrozen(new Box());',
    expected: FROZEN_REASON,
    id: 'fresh-container-reassigned-slot-to-input-write',
  },
  {
    body: 'class Box { constructor() { const items = [{ count: 0 }]; items[0] = input; items[0].count++; } } return Object.isFrozen(new Box());',
    expected: FROZEN_REASON,
    id: 'fresh-array-replaced-slot-to-input-write',
  },
  {
    body: 'class Box { constructor() { const items = [{ count: 0 }]; items.unshift(input); items[0].count++; } } return Object.isFrozen(new Box());',
    expected: FROZEN_REASON,
    id: 'fresh-array-pushed-input-member-write',
  },
  {
    body: 'function sneak(target: { nested: { count: number } }) { target.nested = input; } class Box { constructor() { const local = { nested: { count: 0 } }; sneak(local); local.nested.count++; } } return Object.isFrozen(new Box());',
    expected: FROZEN_REASON,
    id: 'fresh-container-escaped-to-helper-before-nested-write',
  },
  {
    body: 'const local = { nested: input }; return Object.isFrozen(local.nested);',
    expected: FROZEN_REASON,
    id: 'direct-is-frozen-on-fresh-container-holding-input',
  },
  {
    body: 'class Box { data: { count: number }; constructor(x: { count: number }) { this.data = x; this.data.count++; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'receiver-constructor-assigned-input-member-write',
  },
  {
    body: 'class Box { data = input; constructor() { this.data.count++; } } return Object.isFrozen(new Box());',
    expected: FROZEN_REASON,
    id: 'receiver-field-holding-outer-input-member-write',
  },
  {
    body: 'class Box { constructor(public data: { count: number }) { this.data.count++; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'receiver-parameter-property-input-member-write',
  },
  {
    body: 'class Box { data = { count: 0 }; constructor(x: { count: number }) { Object.assign(this, { data: x }); this.data.count++; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'receiver-object-assign-input-before-member-write',
  },
  {
    body: 'class Box { data = { inner: { count: 0 } }; constructor(x: { count: number }) { this.data.inner = x; this.data.inner.count++; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'receiver-deeply-nested-slot-reassigned-to-input-write',
  },
] as const;

describe('metadata writes on fresh nested local and receiver containers', () => {
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
      'input-fresh-nested-writes.ts',
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

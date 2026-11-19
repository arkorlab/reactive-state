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
    body: 'return Object.isFrozen(new Promise((resolve) => { ({ resolve } = { resolve: () => { input.count++; } }); resolve(0); }));',
    expected: FROZEN_REASON,
    id: 'object-destructuring-reassigned-resolve',
  },
  {
    body: 'return Object.isFrozen(new Promise((resolve) => { [resolve] = [() => { input.count++; }]; resolve(0); }));',
    expected: FROZEN_REASON,
    id: 'array-destructuring-reassigned-resolve',
  },
  {
    body: 'return Object.isFrozen(new Promise((resolve) => { ({ resolve = () => { input.count++; } } = {}); resolve(0); }));',
    expected: FROZEN_REASON,
    id: 'defaulted-destructuring-reassigned-resolve',
  },
  {
    body: 'return Object.isFrozen(new Promise((resolve) => { for ([resolve] of [[() => { input.count++; }]]) {} resolve(0); }));',
    expected: FROZEN_REASON,
    id: 'for-of-reassigned-resolve',
  },
  {
    body: 'return Object.isFrozen(new Promise((resolve) => { (resolve) = () => { input.count++; }; resolve(0); }));',
    expected: FROZEN_REASON,
    id: 'parenthesized-reassigned-resolve',
  },
  {
    body: 'return Object.isFrozen(new Promise((_resolve, reject) => { ({ reject } = { reject: () => { input.count++; } }); reject(input); }));',
    expected: FROZEN_REASON,
    id: 'destructured-reassigned-reject',
  },
  {
    body: 'return Object.isFrozen(new Promise(((resolve: (value: number) => void, _reject: (reason?: unknown) => void, _extra = (resolve = () => { input.count++; })) => { void _extra; resolve(0); }) as ConstructorParameters<typeof Promise>[0]));',
    expected: FROZEN_REASON,
    id: 'parameter-default-reassigned-resolve',
  },
  {
    body: 'return Object.isFrozen(new Promise((resolve) => { resolve(0); }));',
    expected: undefined,
    id: 'unchanged-resolve-primitive',
  },
  {
    body: 'return Object.isFrozen(new Promise((_resolve, reject) => { reject(input); }));',
    expected: undefined,
    id: 'unchanged-reject-input',
  },
  {
    body: 'return Object.isFrozen(new Promise((resolve) => { let other = 0; ({ other } = { other: 1 }); void other; resolve(0); }));',
    expected: undefined,
    id: 'unrelated-destructuring-in-executor',
  },
  {
    body: 'return Object.isFrozen(new Promise((resolve) => { { let resolve = () => {}; ({ resolve } = { resolve: () => {} }); void resolve; } resolve(0); }));',
    expected: undefined,
    id: 'shadowed-block-resolve-write',
  },
] as const;

describe('metadata promise executor settlement parameter reassignments', () => {
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
      'input-promise-resolver-patterns.ts',
      `export function check(input: { count: number }): boolean { ${body} }
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

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
    body: 'return Object.isFrozen(new Promise((resolve) => { input.count++; resolve(0); }));',
    expected: FROZEN_REASON,
    id: 'direct-promise-executor-write',
  },
  {
    body: 'return Object.isFrozen(new Promise(() => { input.count = 1; }));',
    expected: FROZEN_REASON,
    id: 'direct-promise-unsettled-executor-write',
  },
  {
    body: 'const AsyncBox = Promise; return Object.isFrozen(new AsyncBox((resolve) => { input.count++; resolve(0); }));',
    expected: FROZEN_REASON,
    id: 'aliased-promise-constructor-executor-write',
  },
  {
    body: 'return Object.isFrozen(new Promise(async () => { input.count++; await 0; }));',
    expected: FROZEN_REASON,
    id: 'direct-promise-async-prefix-write',
  },
  {
    body: 'return Object.isFrozen(new Promise(externalExecutor));',
    expected: FROZEN_REASON,
    id: 'direct-promise-unknown-executor',
  },
  {
    body: 'return Object.isFrozen(flag ? new Promise((resolve) => { input.count++; resolve(0); }) : {});',
    expected: FROZEN_REASON,
    id: 'conditional-direct-promise-write',
  },
  {
    body: 'return Object.isFrozen(new Promise((resolve) => { resolve(0); }));',
    expected: undefined,
    id: 'direct-promise-primitive-resolve',
  },
  {
    body: 'return Object.isFrozen(new Promise((resolve) => { void input.count; resolve(0); }));',
    expected: undefined,
    id: 'direct-promise-read-only-executor',
  },
  {
    body: 'return Object.isFrozen(new Promise(async () => { await 0; input.count++; }));',
    expected: undefined,
    id: 'direct-promise-async-post-await-write',
  },
  {
    body: 'return Object.isFrozen(new Promise(function* () { input.count++; } as never));',
    expected: undefined,
    id: 'direct-promise-generator-executor',
  },
  {
    body: 'return Object.isFrozen(new Promise((resolve) => { const local = { count: 0 }; local.count++; resolve(0); }));',
    expected: undefined,
    id: 'direct-promise-local-write',
  },
  {
    body: 'return Object.isFrozen(new Array(input));',
    expected: undefined,
    id: 'direct-array-construction',
  },
] as const;

describe('metadata direct native construction synchronous callbacks', () => {
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
      'input-direct-promise-effects.ts',
      `export function check(input: { count: number }, flag: boolean, externalExecutor: (resolve: (value: number) => void) => void): boolean { ${body} }
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

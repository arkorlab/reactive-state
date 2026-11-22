import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when `??` falls through `null` to a possibly `undefined` timestamp. */
const TIMED_FILE_REFUSAL = 'makes a `File` of no `lastModified`, which it takes of the time';

/**
 * Nullish coalescing selects its right operand when the left evaluates to `null` as well as
 * `undefined`, whereas a standalone `null` timestamp converts to `0`.
 */
const CASES = [
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'direct-null-before-undefined',
    options: '{ endings: "transparent", lastModified: null ?? undefined }',
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'conditional-null-branch-before-undefined',
    options: '{ endings: "transparent", lastModified: (flag ? null : 0) ?? undefined }',
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'conditional-null-branch-before-unknown',
    options: '{ endings: "transparent", lastModified: (flag ? null : 0) ?? stamp }',
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'nested-coalesce-null-fallback-before-undefined',
    options: '{ endings: "transparent", lastModified: (stamp ?? null) ?? undefined }',
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'const-null-binding-before-unknown',
    options: '{ endings: "transparent", lastModified: nothing ?? stamp }',
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'logical-or-null-fallback-before-undefined',
    options: '{ endings: "transparent", lastModified: (flag || null) ?? undefined }',
  },
  {
    expected: undefined,
    id: 'const-null-binding-alone-pin',
    options: '{ endings: "transparent", lastModified: nothing }',
  },
  {
    expected: undefined,
    id: 'standalone-null-pin',
    options: '{ endings: "transparent", lastModified: null }',
  },
  {
    expected: undefined,
    id: 'null-coalesced-to-zero-pin',
    options: '{ endings: "transparent", lastModified: null ?? 0 }',
  },
  {
    expected: undefined,
    id: 'unknown-coalesced-to-null-pin',
    options: '{ endings: "transparent", lastModified: stamp ?? null }',
  },
  {
    expected: undefined,
    id: 'number-coalesced-to-unknown-pin',
    options: '{ endings: "transparent", lastModified: 0 ?? stamp }',
  },
  {
    expected: undefined,
    id: 'conditional-numbers-before-unknown-pin',
    options: '{ endings: "transparent", lastModified: (flag ? 1 : 2) ?? stamp }',
  },
  {
    expected: undefined,
    id: 'logical-or-ending-in-null-pin',
    options: '{ endings: "transparent", lastModified: stamp || null }',
  },
] as const;

describe('timed file timestamp nullish coalescing', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` for a shared helper constructing a `File` with `options`. */
  function refusalFor(options: string): string | undefined {
    const source = [
      'const nothing = null;',
      'export function make(flag: boolean, stamp: number | undefined) {',
      `  return new File([], 'x', ${options} as FilePropertyBag).size;`,
      '}',
    ].join('\n');
    using parsed = parseModule(api, 'timed-coalescing.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, options }) => {
    expect(refusalFor(options)).toBe(expected);
  });
});

import { isIdentifier, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalPathOf } from '../src/compiler/code-globals.ts';
import { fileReferenceReadsClock } from '../src/compiler/file-timestamps.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';

/**
 * A global File a module only tests — `typeof File`, `value instanceof File` — constructs nothing,
 * so no timestamp is taken from the clock where it is read, as a constant that aliases it, too.
 * Handed on, or the left of `instanceof`, which hands it to the right side's `Symbol.hasInstance`,
 * it may be constructed there. The rows marked a pin answer the same before the change as after it.
 */

const TESTED = [
  { code: 'declare const value: unknown; value instanceof File;', what: 'instanceof' },
  {
    code: 'declare const value: unknown; value instanceof (File);',
    what: 'instanceof, in parentheses',
  },
  {
    code: 'declare const value: unknown; value instanceof (File as typeof File);',
    what: 'instanceof, of a cast',
  },
  {
    code: 'declare const value: unknown; value instanceof File!;',
    what: 'instanceof, of a non-null assertion',
  },
  {
    code: 'declare const value: unknown; function is() { return value instanceof File; }',
    what: 'instanceof, in a function',
  },
  { code: "typeof File === 'function';", what: 'typeof' },
  { code: "typeof (File) === 'function';", what: 'typeof, in parentheses' },
  {
    code: 'declare const value: unknown; const Make = File; value instanceof Make;',
    what: 'instanceof, of a constant alias',
  },
  {
    code: "const Make = File; typeof Make === 'function';",
    what: 'typeof, of a constant alias',
  },
  {
    code: "declare const value: unknown; value instanceof File && new File([], 'x', { lastModified: 0 });",
    what: 'instanceof beside a construction that is dated',
  },
] as const;

const HANDED = [
  {
    code: 'declare const other: Function; File instanceof other;',
    what: 'File as the left of instanceof',
  },
  {
    code: 'declare const value: unknown; value instanceof File; read(File);',
    what: 'instanceof, and File as an argument',
  },
  {
    code: 'declare const value: unknown; const Make = File; value instanceof Make; export { Make };',
    what: 'instanceof, and an alias that is exported',
  },
  {
    code: 'declare const value: unknown; value instanceof File.prototype.constructor;',
    what: 'instanceof of a member of File',
  },
  {
    code: "typeof File; new File([], 'x');",
    what: 'typeof, and a construction of no timestamp (pin)',
  },
  { code: 'const holder = { File };', what: 'File held in an object (pin)' },
  { code: 'read(File);', what: 'File as an argument (pin)' },
] as const;

describe('a global File a module only tests', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether any runtime read of the global File in `code` may reach an unchecked construction. */
  function reachesClock(code: string): boolean {
    using parsed = api.createSourceFile('file-reference.ts', code);
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (isTypeOnly(at)) continue;
      if (
        isIdentifier(at) &&
        globalPathOf(at)?.join('.') === 'File' &&
        fileReferenceReadsClock(at)
      ) {
        return true;
      }
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    return false;
  }

  it.each(TESTED)('reads no clock: $what', ({ code }) => {
    expect(reachesClock(code)).toBe(false);
  });

  it.each(HANDED)('keeps its possible clock: $what', ({ code }) => {
    expect(reachesClock(code)).toBe(true);
  });
});

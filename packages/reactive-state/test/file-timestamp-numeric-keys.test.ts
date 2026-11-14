import { type Expression, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalPathOf } from '../src/compiler/code-globals.ts';
import { fileReadsClock, hasFileTimestamp } from '../src/compiler/file-timestamps.ts';

/**
 * A key of a File's options that is a number — `{ lastModified: 0, 1: 'x' }`, written, or computed
 * of a constant — is text of digits, which is never `lastModified`: it replaces no timestamp, as a
 * key of any other literal name does not. A key the code computes of what it does not show still
 * may. The rows marked a pin answer the same before the change as after it.
 */

const CASES = [
  { dated: true, options: "{ lastModified: 0, 1: 'x' }", what: 'a number written after' },
  { dated: true, options: "{ 1: 'x', lastModified: 0 }", what: 'a number written before (pin)' },
  { dated: true, options: "{ lastModified: 0, 0x10: 'x' }", what: 'a hexadecimal number' },
  { dated: true, options: "{ lastModified: 0, 1.5: 'x' }", what: 'a fraction' },
  { dated: true, options: "{ lastModified: 0, 1_000: 'x' }", what: 'a number with separators' },
  { dated: true, options: '{ lastModified: 0, 1() { return 1; } }', what: 'a method named by one' },
  { dated: true, options: "{ lastModified: 0, [1]: 'x' }", what: 'a number computed' },
  { dated: true, options: "{ lastModified: 0, [1 + 1]: 'x' }", what: 'a sum computed' },
  { dated: true, options: "{ lastModified: 0, [index]: 'x' }", what: 'a constant number computed' },
  { dated: true, options: "{ lastModified: 0, ...{ 1: 'x' } }", what: 'a number of a spread' },
  { dated: false, options: "{ 1: 'x' }", what: 'a number and no timestamp (pin)' },
  {
    dated: false,
    options: "{ lastModified: undefined, 1: 'x' }",
    what: 'a number after none (pin)',
  },
  { dated: false, options: "{ lastModified: 0, [stamp]: 'x' }", what: 'a key not shown (pin)' },
  { dated: false, options: "{ lastModified: 0, ['lastModified']: undefined }", what: 'text (pin)' },
  { dated: true, options: "{ lastModified: 0, a: 'x' }", what: 'a name (pin)' },
] as const;

/** The source of a module that makes a File of `options`, beside the names they read. */
function moduleOf(options: string): string {
  return [
    'declare const stamp: string | number | undefined;',
    'const index = 1;',
    `new File([], 'x', ${options});`,
  ].join('\n');
}

/** Whether `expression` reads the global `File`. */
function isGlobalFile(expression: Expression): boolean {
  return globalPathOf(expression)?.join('.') === 'File';
}

describe('a File timestamp beside keys that are numbers', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the File made of `options` shows its timestamp, and whether it reads the clock. */
  function timestampOf(options: string): { readonly dated: boolean; readonly clock: boolean } {
    using parsed = api.createSourceFile('file-timestamp.ts', moduleOf(options));
    let made: NewExpression | undefined;
    const visit = (node: Node): void => {
      if (isNewExpression(node)) {
        made = node;
      }
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (made === undefined) {
      throw new Error(`No File is made of ${options}.`);
    }
    return { clock: fileReadsClock(made, isGlobalFile), dated: hasFileTimestamp(made) };
  }

  it.each(CASES)('$what', ({ dated, options }) => {
    expect(timestampOf(options)).toStrictEqual({ clock: !dated, dated });
  });
});

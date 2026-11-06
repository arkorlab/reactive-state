import { type Expression, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalPathOf } from '../src/compiler/code-globals.ts';
import { fileReadsClock, hasFileTimestamp } from '../src/compiler/file-timestamps.ts';

/**
 * A `lastModified` of the global `NaN` or `Infinity` is a number a File's options read as one of
 * its own, not the clock's — `0 / 0` is read so already — there or through a constant of it. The
 * rows marked a pin answer the same before the change as after it.
 */

const CASES = [
  { dated: true, options: '{ lastModified: NaN }', what: 'the global NaN' },
  { dated: true, options: '{ lastModified: Infinity }', what: 'the global Infinity' },
  { dated: true, options: '{ lastModified: notANumber }', what: 'a constant of NaN' },
  { dated: true, options: '{ lastModified: NaN ?? stamp }', what: 'NaN before a read' },
  { dated: true, options: '{ lastModified: 0 / 0 }', what: 'NaN computed (pin)' },
  { dated: true, options: '{ lastModified: -Infinity }', what: 'a negated Infinity (pin)' },
  { dated: false, options: '{ lastModified: undefined }', what: 'undefined (pin)' },
  { dated: false, options: '{ lastModified: stamp }', what: 'a read (pin)' },
] as const;

/** The source of a module that makes a File of `options`, beside the names they read. */
function moduleOf(options: string): string {
  return [
    'declare const stamp: number | undefined;',
    'const notANumber = NaN;',
    `new File([], 'x', ${options});`,
  ].join('\n');
}

/** Whether `expression` reads the global `File`. */
function isGlobalFile(expression: Expression): boolean {
  return globalPathOf(expression)?.join('.') === 'File';
}

describe('a File timestamp of a global number', () => {
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

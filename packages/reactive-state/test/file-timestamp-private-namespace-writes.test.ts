import { type Expression, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalPathOf } from '../src/compiler/code-globals.ts';
import { fileReadsClock, hasFileTimestamp } from '../src/compiler/file-timestamps.ts';

/**
 * A write within a namespace that is private to its body reaches the constant around it, not a
 * member of the same name an exported namespace of another body has: `namespace A { export
 * namespace N { export const options = {}; } } namespace A { namespace N { options.lastModified
 * = undefined; } }` changes the options the File is made of, and the File takes the clock, whether
 * the other body is ambient and exports by `export {}` or not. The row marked a pin answers the same before the change as after it.
 */

const OPTIONS = 'const options: { lastModified?: number } = { lastModified: 0 };';
const MADE = "new File([], 'x', options);";

const CASES = [
  {
    clock: true,
    source: `${OPTIONS} namespace A { export namespace N { export const options = {}; } } namespace A { namespace N { options.lastModified = undefined; } } ${MADE}`,
    what: 'a write within a private namespace beside an exported one of the same name',
  },
  {
    clock: true,
    source: `${OPTIONS} declare namespace A { namespace N { const options: {}; } export {}; } namespace A { export namespace N { options.lastModified = undefined; } } ${MADE}`,
    what: 'a write within a namespace beside a private one of an ambient body that exports by `export {}`',
  },
  {
    clock: true,
    source: `${OPTIONS} declare namespace A { namespace N { enum E { options = 0 } } export {}; } namespace A { export namespace N { export enum E { entry = (options.lastModified = undefined, 0) } } } ${MADE}`,
    what: 'a write within an enum of a namespace beside a private one of an ambient body',
  },
  {
    clock: false,
    source: `${OPTIONS} namespace A { export namespace N { export const options: { lastModified?: number } = {}; } } namespace A { export namespace N { options.lastModified = undefined; } } ${MADE}`,
    what: 'a write within a namespace that merges with the exported one (pin)',
  },
] as const;

/** Whether `expression` reads the global `File`. */
function isGlobalFile(expression: Expression): boolean {
  return globalPathOf(expression)?.join('.') === 'File';
}

describe('a File whose options a private namespace writes the name of', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the last File `source` makes shows its timestamp, and whether it reads the clock. */
  function timestampOf(source: string): { readonly dated: boolean; readonly clock: boolean } {
    using parsed = api.createSourceFile('file-timestamp.ts', source);
    let made: NewExpression | undefined;
    const visit = (node: Node): void => {
      if (isNewExpression(node)) {
        made = node;
      }
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (made === undefined) {
      throw new Error(`No File is made in ${source}.`);
    }
    return { clock: fileReadsClock(made, isGlobalFile), dated: hasFileTimestamp(made) };
  }

  it.each(CASES)('$what', ({ clock, source }) => {
    expect(timestampOf(source)).toStrictEqual({ clock, dated: !clock });
  });
});

import { type Expression, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalPathOf } from '../src/compiler/code-globals.ts';
import { fileReadsClock, hasFileTimestamp } from '../src/compiler/file-timestamps.ts';

/**
 * An export that is erased with the types — `export type { options }`, `export { type options }` —
 * hands the constant that holds a File's options to no one, as a type that names it does not. An
 * export of the value is one, and so is one under another name. The rows marked a pin answer the
 * same before the change as after it.
 */

const HOLDER = 'const options = { lastModified: 0 };';
const MADE = "new File([], 'x', options);";

const CASES = [
  { source: `${HOLDER} export type { options }; ${MADE}`, what: 'a type export' },
  { source: `${HOLDER} export { type options }; ${MADE}`, what: 'a type specifier' },
  {
    source: `${HOLDER} export type { options as shown }; ${MADE}`,
    what: 'a type export under another name',
  },
  {
    source: `${HOLDER} export { type options as shown }; ${MADE}`,
    what: 'a type specifier under another name',
  },
] as const;

const PINS = [
  { dated: false, source: `${HOLDER} export { options }; ${MADE}`, what: 'an export (pin)' },
  {
    dated: false,
    source: `${HOLDER} export { options as shown }; ${MADE}`,
    what: 'an export under another name (pin)',
  },
  {
    dated: false,
    source: `${HOLDER} export default options; ${MADE}`,
    what: 'a default export (pin)',
  },
  {
    dated: false,
    source: `${HOLDER} export { type options, options as shown }; ${MADE}`,
    what: 'a type specifier beside an export (pin)',
  },
  {
    dated: true,
    source: `${HOLDER} export { options } from './data'; ${MADE}`,
    what: 'a re-export of another module’s name (pin)',
  },
  {
    dated: true,
    source: `${HOLDER} const other = 0; export { other as options }; ${MADE}`,
    what: 'an export labelled as it is (pin)',
  },
] as const;

/** Whether `expression` reads the global `File`. */
function isGlobalFile(expression: Expression): boolean {
  return globalPathOf(expression)?.join('.') === 'File';
}

describe('the options of a File that an export of the constant that holds them names', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the File `source` makes shows its timestamp, and whether it reads the clock. */
  function timestampOf(source: string): { readonly dated: boolean; readonly clock: boolean } {
    using parsed = api.createSourceFile('file-timestamp.ts', source);
    let made: NewExpression | undefined;
    const visit = (node: Node): void => {
      if (made === undefined && isNewExpression(node)) {
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

  it.each(CASES)('$what', ({ source }) => {
    expect(timestampOf(source)).toStrictEqual({ clock: false, dated: true });
  });

  it.each(PINS)('$what', ({ dated, source }) => {
    expect(timestampOf(source)).toStrictEqual({ clock: !dated, dated });
  });
});

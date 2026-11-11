import { type Expression, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalPathOf } from '../src/compiler/code-globals.ts';
import { fileReadsClock, hasFileTimestamp } from '../src/compiler/file-timestamps.ts';

/**
 * What a namespace exports in one of its bodies is a name in each of its others — TypeScript emits
 * `N.field` for a bare `field` there — before a constant around the namespace, so that in `namespace
 * N { export const field = 'other'; } namespace N { … { [field]: 0 } … }` the option's key is
 * `'other'`, not that of the constant `field`, and the File takes the clock. The rows marked a pin
 * answer the same before the change as after it.
 */

const BEFORE = "const field = 'lastModified';";
const MAKES = "new File([], 'x', { [field]: 0 });";

const CASES = [
  {
    source: `namespace N { export const field = 'other'; } namespace N { ${MAKES} }`,
    what: 'a const',
  },
  { source: `namespace N { export let field = 'other'; } namespace N { ${MAKES} }`, what: 'a let' },
  { source: `namespace N { export var field = 'other'; } namespace N { ${MAKES} }`, what: 'a var' },
  {
    source: `namespace N { export function field() { return 'other'; } } namespace N { ${MAKES} }`,
    what: 'a function',
  },
  { source: `namespace N { export class field {} } namespace N { ${MAKES} }`, what: 'a class' },
  { source: `namespace N { export enum field { A } } namespace N { ${MAKES} }`, what: 'an enum' },
  {
    source: `namespace N { export namespace field { export const own = 1; } } namespace N { ${MAKES} }`,
    what: 'a namespace',
  },
  {
    source: `namespace N { ${MAKES} } namespace N { export const field = 'other'; }`,
    what: 'an export of a later body',
  },
  {
    source: `namespace N { export const field = 'other'; } namespace N { export const other = 1; } namespace N { ${MAKES} }`,
    what: 'an export of the first of three bodies',
  },
  {
    source: `namespace M { export namespace N { export const field = 'other'; } } namespace M { export namespace N { ${MAKES} } }`,
    what: 'an export of a nested namespace’s other body',
  },
  {
    source: `namespace M.N { export const field = 'other'; } namespace M.N { ${MAKES} }`,
    what: 'an export of a dotted namespace’s other body',
  },
  {
    source: `namespace N { export const field = 'other'; } namespace N { function make() { ${MAKES} } }`,
    what: 'a File made in a function of the body',
  },
] as const;

const PINS = [
  {
    source: `namespace N { const field = 'other'; } namespace N { ${MAKES} }`,
    what: 'a name not exported (pin)',
  },
  {
    source: `namespace N { export const field = 'other'; } namespace O { ${MAKES} }`,
    what: 'an export of another namespace (pin)',
  },
  {
    source: `namespace N { export const other = 'other'; } namespace N { ${MAKES} }`,
    what: 'an export of another name (pin)',
  },
  {
    source: `namespace N { export interface field { own: 1 } } namespace N { ${MAKES} }`,
    what: 'an interface, which has no value (pin)',
  },
  {
    source: `namespace N { export type field = string; } namespace N { ${MAKES} }`,
    what: 'a type alias, which has no value (pin)',
  },
  {
    source: `namespace N { export const field = 'other'; } ${MAKES}`,
    what: 'a File beside the namespace (pin)',
  },
] as const;

/** Whether `expression` reads the global `File`. */
function isGlobalFile(expression: Expression): boolean {
  return globalPathOf(expression)?.join('.') === 'File';
}

describe('a File made in a namespace whose other body exports the name its options are keyed by', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the last File `source` makes shows its timestamp, and whether it reads the clock. */
  function timestampOf(source: string): { readonly dated: boolean; readonly clock: boolean } {
    using parsed = api.createSourceFile('file-timestamp.ts', `${BEFORE} ${source}`);
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

  it.each(CASES)('$what', ({ source }) => {
    expect(timestampOf(source)).toStrictEqual({ clock: true, dated: false });
  });

  it.each(PINS)('$what', ({ source }) => {
    expect(timestampOf(source)).toStrictEqual({ clock: false, dated: true });
  });
});

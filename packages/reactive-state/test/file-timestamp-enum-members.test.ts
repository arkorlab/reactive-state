import { type Expression, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalPathOf } from '../src/compiler/code-globals.ts';
import { fileReadsClock, hasFileTimestamp } from '../src/compiler/file-timestamps.ts';

/**
 * Within an enum's initializers a bare name is a member of that enum, of any declaration of it
 * beside it in its scope — as it is for the keys of a binding — before it is a constant around the
 * enum: in `enum E { field = 'other', entry = … { [field]: 0 } … }` the option's key is `'other'`,
 * not that of the constant `field`, so the File takes the clock. The rows marked a pin answer the
 * same before the change as after it.
 */

const BEFORE = "const field = 'lastModified';";
const MAKES = "Number(new File([], 'x', { [field]: 0 }))";

const CASES = [
  {
    source: `enum E { field = 'other', entry = ${MAKES} }`,
    what: 'a member before the construction',
  },
  {
    source: `enum E { entry = ${MAKES}, field = 'other' }`,
    what: 'a member after the construction',
  },
  {
    source: `enum E { 'field' = 'other', entry = ${MAKES} }`,
    what: 'a member named by text',
  },
  {
    source: `enum E { field = 'other' } enum E { entry = ${MAKES} }`,
    what: 'a member of an enum merged with it',
  },
  {
    source: `namespace N { export enum E { field = 'other' } } namespace N { export enum E { entry = ${MAKES} } }`,
    what: 'a member of an enum a namespace’s other body exports',
  },
  {
    source: `function make() { enum E { field = 'other', entry = ${MAKES} } }`,
    what: 'a member of an enum of a function’s body',
  },
] as const;

const PINS = [
  {
    dated: true,
    source: `enum E { other = 'other', entry = ${MAKES} }`,
    what: 'a member of another name (pin)',
  },
  {
    dated: true,
    source: `enum F { field = 'other' } enum E { entry = ${MAKES} }`,
    what: 'a member of another enum (pin)',
  },
  {
    dated: true,
    source: `enum E { field = 'other' } ${MAKES};`,
    what: 'a construction beside the enum (pin)',
  },
  {
    dated: true,
    source: `enum E { entry = ${MAKES} }`,
    what: 'an enum of no member of the name (pin)',
  },
  {
    dated: true,
    source: `namespace N { export enum E { field = 'other' } } namespace N { enum E { entry = ${MAKES} } }`,
    what: 'an enum that is not exported beside one that is (pin)',
  },
  {
    dated: true,
    source: `declare namespace N { enum E { field = 'other' } } namespace N { enum E { entry = ${MAKES} } }`,
    what: 'an enum that is not exported beside an ambient one (pin)',
  },
  {
    dated: true,
    source: `namespace N { declare enum E { field = 'other' } } namespace N { export enum E { entry = ${MAKES} } }`,
    what: 'an enum declared in a body that is not ambient (pin)',
  },
  {
    dated: true,
    source: `declare namespace N { export {}; enum E { field = 'other' } } namespace N { export enum E { entry = ${MAKES} } }`,
    what: 'an enum of an ambient namespace that exports by `export {}` (pin)',
  },
  {
    dated: true,
    source: `declare namespace A { namespace N { enum E { field = 'other' } } export {}; } namespace A { export namespace N { export enum E { entry = ${MAKES} } } }`,
    what: 'an enum of a nested namespace that an ambient body keeps private (pin)',
  },
] as const;

/** Whether `expression` reads the global `File`. */
function isGlobalFile(expression: Expression): boolean {
  return globalPathOf(expression)?.join('.') === 'File';
}

describe('a File made within an enum that has a member of the name its options are keyed by', () => {
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

  it.each(PINS)('$what', ({ dated, source }) => {
    expect(timestampOf(source)).toStrictEqual({ clock: !dated, dated });
  });
});

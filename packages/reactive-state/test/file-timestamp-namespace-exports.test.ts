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
const TYPES =
  "namespace Types { export interface T {} export type U = string; export namespace NI { export interface J {} } export namespace Q { export interface T {} } export const V = 'other'; export namespace NV { export const x = 1; } }";
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
    source: `${TYPES} namespace N { export import field = Types.V; } namespace N { ${MAKES} }`,
    what: 'an exported alias of a constant (pin)',
  },
  {
    source: `${TYPES} namespace N { export import field = Types.NV; } namespace N { ${MAKES} }`,
    what: 'an exported alias of a namespace of values (pin)',
  },
  {
    source: `namespace N { export import field = Foreign.T; } namespace N { ${MAKES} }`,
    what: 'an exported alias of what the file does not declare (pin)',
  },
  {
    source: `namespace N { export declare const field: string; } namespace N { ${MAKES} }`,
    what: 'an exported `declare` constant (pin)',
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
    source: `namespace C { namespace A { export namespace N { export const field = 'other'; } } namespace A { export namespace N { ${MAKES} } } }`,
    what: 'an export of a nested namespace in the other of two bodies of a namespace its enclosing body keeps private',
  },
  {
    source: `namespace D { namespace C { namespace B { export namespace N { export const field = 'other'; } } namespace B { export namespace N { ${MAKES} } } } }`,
    what: 'an export of a namespace three levels in, where two enclosing bodies keep theirs private',
  },
  {
    source: `namespace C { namespace A { export namespace N { export const field = 'other'; } } namespace A.N { ${MAKES} } }`,
    what: 'an export of a nested namespace in a dotted one beside a private body',
  },
  {
    source: `namespace M.N { export const field = 'other'; } namespace M.N { ${MAKES} }`,
    what: 'an export of a dotted namespace’s other body',
  },
  {
    source: `namespace N { export const field = 'other'; } namespace N { function make() { ${MAKES} } }`,
    what: 'a File made in a function of the body',
  },
  {
    source: `namespace M.field { export const own = 1; } namespace M { ${MAKES} }`,
    what: 'a dotted namespace’s own name',
  },
  {
    source: `namespace A.B.field { export const own = 1; } namespace A.B { ${MAKES} }`,
    what: 'a namespace dotted three deep’s own name',
  },
  {
    source: `declare namespace N { const field: string; } namespace N { ${MAKES} }`,
    what: 'a member of an ambient namespace, exported with no word',
  },
  {
    source: `declare namespace N { function field(): string; } namespace N { ${MAKES} }`,
    what: 'a function of an ambient namespace',
  },
  {
    source: `declare namespace M { namespace N { const field: string; } } namespace M { export namespace N { ${MAKES} } }`,
    what: 'a member of an ambient namespace nested in one merged',
  },
  {
    source: `declare namespace M.N { const field: string; } namespace M.N { ${MAKES} }`,
    what: 'a member of a dotted ambient namespace',
  },
  {
    source: `namespace N { export namespace field { export const own = 1; } } namespace N { ${MAKES} }`,
    what: 'a namespace of a value',
  },
  {
    source: `namespace N { export namespace field { export const enum E { A } } } namespace N { ${MAKES} }`,
    what: 'a namespace of a const enum alone',
  },
  {
    source: `namespace N { export namespace field { export import T = Types.T; } } namespace N { ${MAKES} }`,
    what: 'a namespace of an exported import alias',
  },
  {
    source: `namespace N { export namespace field { import T = Types.T; export const own = 1; } } namespace N { ${MAKES} }`,
    what: 'a namespace of a private import alias beside a value',
  },
  {
    source: `namespace A { export const field = 'other'; } namespace A.B { ${MAKES} }`,
    what: 'an export of the outer part of a dotted namespace',
  },
  {
    source: `namespace A.B { ${MAKES} } namespace A { export const field = 'other'; }`,
    what: 'an export of a later declaration of the outer part',
  },
  {
    source: `namespace A { export const field = 'other'; } namespace A.B.C { ${MAKES} }`,
    what: 'an export of the outermost of three',
  },
  {
    source: `namespace A.B { export const field = 'other'; } namespace A.B.C { ${MAKES} }`,
    what: 'an export of the middle of three',
  },
  {
    source: `namespace A.field { export const own = 1; } namespace A.B { ${MAKES} }`,
    what: 'the name of a dotted namespace beside it',
  },
  {
    source: `declare namespace A { const field: string; } namespace A.B { ${MAKES} }`,
    what: 'a member of an ambient outer part',
  },
  {
    source: `declare namespace Z { namespace N { const field: string; } } namespace Z { export namespace N { ${MAKES} } }`,
    what: 'a member of an ambient nested namespace an exported one merges with',
  },
  {
    source: `namespace Z { export namespace A { export const field = 'other'; } } namespace Z { export namespace A.B { ${MAKES} } }`,
    what: 'an export of a nested namespace’s outer part',
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
    source: `${TYPES} namespace N { export import field = Types.T; } namespace N { ${MAKES} }`,
    what: 'an exported alias of an interface, which has no value',
  },
  {
    source: `${TYPES} namespace N { export import field = Types.U; } namespace N { ${MAKES} }`,
    what: 'an exported alias of a type alias',
  },
  {
    source: `${TYPES} namespace N { export import field = Types.NI; } namespace N { ${MAKES} }`,
    what: 'an exported alias of a namespace of types alone',
  },
  {
    source: `${TYPES} namespace N { export import field = Types.Q.T; } namespace N { ${MAKES} }`,
    what: 'an exported alias of a type that a namespace within a namespace holds',
  },
  {
    source: `${TYPES} namespace N { import field = Types.T; ${MAKES} }`,
    what: 'an alias of an interface in the same body',
  },
  {
    source: `namespace N { declare const field: string; ${MAKES} }`,
    what: 'a `declare` constant that its namespace does not export',
  },
  {
    source: `namespace N { declare var field: string; ${MAKES} }`,
    what: 'a `declare` var that its namespace does not export',
  },
  {
    source: `namespace N { declare function field(): void; ${MAKES} }`,
    what: 'a `declare` function that its namespace does not export',
  },
  {
    source: `namespace N { export const field = 'other'; } ${MAKES}`,
    what: 'a File beside the namespace (pin)',
  },
  {
    source: `namespace A { const field = 'other'; } namespace A.B { ${MAKES} }`,
    what: 'a private name of the outer part (pin)',
  },
  {
    source: `namespace A.B { export const field = 'other'; } namespace A.C { ${MAKES} }`,
    what: 'an export of a sibling inner part (pin)',
  },
  {
    source: `namespace Z { export const field = 'other'; } namespace A.B { ${MAKES} }`,
    what: 'an export of another namespace beside a dotted one (pin)',
  },
  {
    source: `namespace A { export type field = string; } namespace A.B { ${MAKES} }`,
    what: 'a type the outer part exports (pin)',
  },
  {
    source: `namespace M.field { export type T = string; } namespace M { ${MAKES} }`,
    what: 'a dotted namespace of types alone (pin)',
  },
  {
    source: `declare namespace N { type field = string; } namespace N { ${MAKES} }`,
    what: 'a type of an ambient namespace (pin)',
  },
  {
    source: `namespace N { export namespace field { export type T = string; } } namespace N { ${MAKES} }`,
    what: 'a namespace of types alone (pin)',
  },
  {
    source: `namespace N { export namespace field { export namespace inner { export interface I {} } } } namespace N { ${MAKES} }`,
    what: 'a namespace of namespaces of types alone (pin)',
  },
  {
    source: `namespace N { export namespace field {} } namespace N { ${MAKES} }`,
    what: 'an empty namespace (pin)',
  },
  {
    source: `namespace N { export namespace field { import T = Types.T; } } namespace N { ${MAKES} }`,
    what: 'a namespace of a private import alias alone (pin)',
  },
  {
    source: `namespace N { export namespace field { import T = Types.T; export type U = T; } } namespace N { ${MAKES} }`,
    what: 'a namespace of a private import alias and a type (pin)',
  },
  {
    source: `namespace N { declare const field: string; } namespace N { ${MAKES} }`,
    what: 'a declared const of a body that is not ambient (pin)',
  },
  {
    source: `namespace N { declare function field(): void; } namespace N { ${MAKES} }`,
    what: 'a declared function of a body that is not ambient (pin)',
  },
  {
    source: `declare namespace N { const field: string; export {}; } namespace N { ${MAKES} }`,
    what: 'a member of an ambient namespace that exports by `export {}` (pin)',
  },
  {
    source: `namespace Z { export namespace N { export const field = 'other'; } } namespace Z { namespace N { ${MAKES} } }`,
    what: 'a private nested namespace beside an exported one (pin)',
  },
  {
    source: `namespace Z { namespace N { export const field = 'other'; } } namespace Z { export namespace N { ${MAKES} } }`,
    what: 'an exported nested namespace beside a private one (pin)',
  },
  {
    source: `declare namespace Z { namespace N { const field: string; } export {}; } namespace Z { export namespace N { ${MAKES} } }`,
    what: 'a nested namespace of an ambient body that exports by `export {}` (pin)',
  },
  {
    source: `declare namespace A { namespace B { namespace N { const field: string; } } export {}; } namespace A { export namespace B { export namespace N { ${MAKES} } } }`,
    what: 'a namespace two levels in that an ambient body keeps private (pin)',
  },
  {
    source: `namespace C { namespace A { export namespace N { export const field = 'other'; } } } namespace C { namespace A { export namespace N { ${MAKES} } } }`,
    what: 'a namespace that two bodies of the outer one each keep private (pin)',
  },
  {
    source: `namespace N { export namespace field { export type T = string; } ${MAKES} }`,
    what: 'a namespace of types alone in the body of the File (pin)',
  },
  {
    source: `namespace N { namespace field { export type T = string; } ${MAKES} }`,
    what: 'a private namespace of types alone in the body of the File (pin)',
  },
  {
    source: `declare module 'field' {} ${MAKES}`,
    what: 'a module the code names by text (pin)',
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

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
 * the other body is ambient and exports by `export {}` or not. So does a write to a name that no
 * value binds: an `import … =` alias of a type (an interface, a type alias, a namespace of types)
 * is a type alone, as is a `declare` statement that its body does not export, which TypeScript
 * erases; and a `var` of a namespace is that namespace's own, not one of the scope around it. The
 * rows marked a pin answer the same before the change as after it.
 */

const OPTIONS = 'const options: { lastModified?: number } = { lastModified: 0 };';
const MADE = "new File([], 'x', options);";
const TYPES =
  'namespace Types { export interface T {} export type U = string; export namespace NI { export interface J {} } export namespace Q { export interface T {} } export const V: { lastModified?: number } = {}; export namespace NV { export const x = 1; } }';

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
    clock: true,
    source: `${TYPES} ${OPTIONS} namespace N { export import options = Types.T; } namespace N { options.lastModified = undefined; } ${MADE}`,
    what: 'a write to an exported alias of an interface',
  },
  {
    clock: true,
    source: `${TYPES} ${OPTIONS} namespace N { export import options = Types.U; } namespace N { options.lastModified = undefined; } ${MADE}`,
    what: 'a write to an exported alias of a type alias',
  },
  {
    clock: true,
    source: `${TYPES} ${OPTIONS} namespace N { export import options = Types.NI; } namespace N { options.lastModified = undefined; } ${MADE}`,
    what: 'a write to an exported alias of a namespace of types alone',
  },
  {
    clock: true,
    source: `${TYPES} ${OPTIONS} namespace N { export import options = Types.Q.T; } namespace N { options.lastModified = undefined; } ${MADE}`,
    what: 'a write to an exported alias of a type that a namespace within a namespace holds',
  },
  {
    clock: true,
    source: `${TYPES} ${OPTIONS} namespace N { import options = Types.T; options.lastModified = undefined; } ${MADE}`,
    what: 'a write to an alias of an interface in the same body',
  },
  {
    clock: true,
    source: `${TYPES} ${OPTIONS} namespace N { import mid = Types; export import options = mid.T; } namespace N { options.lastModified = undefined; } ${MADE}`,
    what: 'a write to an exported alias of an alias of an interface',
  },
  {
    clock: true,
    source: `${OPTIONS} namespace N { import options = Foreign.T; options.lastModified = undefined; } ${MADE}`,
    what: 'a write to an alias of what the file does not declare',
  },
  {
    clock: true,
    source: `${OPTIONS} namespace N { declare const options: { lastModified?: number }; options.lastModified = undefined; } ${MADE}`,
    what: 'a write to a `declare` constant that its namespace does not export',
  },
  {
    clock: true,
    source: `${OPTIONS} namespace A { namespace B { declare const options: { lastModified?: number }; options.lastModified = undefined; } } ${MADE}`,
    what: 'a write to a `declare` constant of a namespace within a namespace',
  },
  {
    clock: true,
    source: `${OPTIONS} namespace N { declare var options: { lastModified?: number }; options.lastModified = undefined; } ${MADE}`,
    what: 'a write to a `declare` var that its namespace does not export',
  },
  {
    clock: true,
    source: `${OPTIONS} namespace B { export var options = {}; } options.lastModified = undefined; ${MADE}`,
    what: 'a write beside a namespace with a `var` of the name (pin)',
  },
  {
    clock: true,
    source: `${OPTIONS} function make() { namespace B { export var options = {}; } options.lastModified = undefined; } ${MADE}`,
    what: 'a write in a function beside a namespace with a `var` of the name',
  },
  {
    clock: true,
    source: `${OPTIONS} namespace A { namespace B { export namespace C { export var options = {}; } } namespace B { namespace C { options.lastModified = undefined; } } } ${MADE}`,
    what: 'a write beside a private namespace that another body keeps a `var` in',
  },
  {
    clock: false,
    source: `${TYPES} ${OPTIONS} namespace N { export import options = Types.V; } namespace N { options.lastModified = undefined; } ${MADE}`,
    what: 'a write to an exported alias of a constant (pin)',
  },
  {
    clock: false,
    source: `${TYPES} ${OPTIONS} namespace N { export import options = Types.NV; } namespace N { options.lastModified = undefined; } ${MADE}`,
    what: 'a write to an exported alias of a namespace of values (pin)',
  },
  {
    clock: false,
    source: `${OPTIONS} namespace Types { export interface T {} export const T: { lastModified?: number } = {}; } namespace N { export import options = Types.T; } namespace N { options.lastModified = undefined; } ${MADE}`,
    what: 'a write to an exported alias of a name that an interface and a constant share (pin)',
  },
  {
    clock: false,
    source: `${OPTIONS} namespace N { export declare const options: { lastModified?: number }; } namespace N { options.lastModified = undefined; } ${MADE}`,
    what: 'a write to a `declare` constant that its namespace exports (pin)',
  },
  {
    clock: false,
    source: `${OPTIONS} namespace B { var options = {}; options.lastModified = undefined; } ${MADE}`,
    what: 'a write to a `var` of the namespace it is in (pin)',
  },
  {
    clock: true,
    source: `var options: { lastModified?: number } = { lastModified: 0 }; namespace N { options.lastModified = undefined; } ${MADE}`,
    what: 'a write within a namespace to options held by a `var` of the file (pin)',
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

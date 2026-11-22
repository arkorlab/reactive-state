import { isIdentifier, isModuleDeclaration, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';
import { handedGlobal } from '../src/compiler/handed-globals.ts';

/**
 * What is ambient — written with `declare`, or within a declaration that is: `declare namespace`,
 * `declare global`, `declare module 'x'` — emits nothing, so no name it gives is a binding that
 * runs, and a read of the name is the global's. `declare namespace process { const own: number }`
 * leaves `process.getBuiltinModule` the function Node has, which loads a module into the
 * authority's Node, and so do `declare const process: unknown` and the other ambient forms. A name
 * is a binding where the code emits one — a constant, a function, a class, an enum, a namespace of
 * a value — and an ambient declaration merged with one leaves the name theirs. Where toolchains
 * differ on whether a bare name is a member of a merged namespace, `N.process`, the compile takes
 * it for the global's. Each row is what `readsCodeGlobal` finds, `line:text`, past what is erased.
 */

const READ = [
  'export function run() {',
  "  return process.getBuiltinModule('node:child_process');",
  '}',
];

/** A declaration of the name elsewhere, which makes the compile resolve each read by its scope. */
const UNRELATED = ['function unrelated(process: unknown) {', '  return process;', '}'];

const FIXED = [
  {
    id: 'namespace-value',
    lines: ['declare namespace process { const own: number; }', ...READ, ...UNRELATED],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient namespace of a constant',
  },
  {
    id: 'namespace-function',
    lines: ['declare namespace process { function own(): void; }', ...READ, ...UNRELATED],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient namespace of a function',
  },
  {
    id: 'namespace-exported',
    lines: ['declare namespace process { export const own: number; }', ...READ, ...UNRELATED],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient namespace of an exported constant',
  },
  {
    id: 'namespace-class',
    lines: ['declare namespace process { class Own {} }', ...READ, ...UNRELATED],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient namespace of a class',
  },
  {
    id: 'namespace-nested',
    lines: [
      'declare namespace process { namespace inner { const own: number; } }',
      ...READ,
      ...UNRELATED,
    ],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient namespace of a namespace of a constant',
  },
  {
    id: 'namespace-dotted',
    lines: ['declare namespace process.inner { const own: number; }', ...READ, ...UNRELATED],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient namespace of a dotted name',
  },
  {
    id: 'namespace-module-keyword',
    lines: ['declare module process { const own: number; }', ...READ, ...UNRELATED],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient module of the name, `module` for `namespace`',
  },
  {
    id: 'namespace-exported-declare',
    lines: ['export declare namespace process { const own: number; }', ...READ, ...UNRELATED],
    reads: ['3:process.getBuiltinModule'],
    what: 'an exported ambient namespace',
  },
  {
    id: 'namespace-over-declared-function',
    lines: [
      'declare function process(): void;',
      'declare namespace process { const own: number; }',
      ...READ,
    ],
    reads: ['4:process.getBuiltinModule'],
    what: 'an ambient namespace merged with an ambient function',
  },
  {
    id: 'namespace-over-declared-class',
    lines: [
      'declare class process {}',
      'declare namespace process { const own: number; }',
      ...READ,
    ],
    reads: ['4:process.getBuiltinModule'],
    what: 'an ambient namespace merged with an ambient class',
  },
  {
    id: 'namespace-over-declared-enum',
    lines: [
      'declare enum process { A }',
      'declare namespace process { const own: number; }',
      ...READ,
    ],
    reads: ['4:process.getBuiltinModule'],
    what: 'an ambient namespace merged with an ambient enum',
  },
  {
    id: 'declare-const',
    lines: ['declare const process: unknown;', ...READ],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient constant',
  },
  {
    id: 'declare-let',
    lines: ['declare let process: unknown;', ...READ],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient `let`',
  },
  {
    id: 'declare-var',
    lines: ['declare var process: unknown;', ...READ],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient `var`',
  },
  {
    id: 'declare-function',
    lines: ['declare function process(): void;', ...READ],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient function',
  },
  {
    id: 'declare-class',
    lines: ['declare class process {}', ...READ],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient class',
  },
  {
    id: 'declare-enum',
    lines: ['declare enum process { A }', ...READ],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient enum',
  },
  {
    id: 'declare-const-enum',
    lines: ['declare const enum process { A }', ...READ],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient constant enum',
  },
  {
    id: 'declare-global-object',
    lines: [
      'declare namespace globalThis { const own: number; }',
      'export function run() {',
      "  return globalThis.process.getBuiltinModule('node:child_process');",
      '}',
      'function unrelated(globalThis: unknown) {',
      '  return globalThis;',
      '}',
    ],
    reads: ['3:globalThis.process.getBuiltinModule'],
    what: 'an ambient namespace of the global object',
  },
  {
    id: 'body-declare-namespace',
    lines: [
      'namespace Inner {',
      '  declare namespace process { const own: number; }',
      "  export const loaded = process.getBuiltinModule('node:child_process');",
      '}',
      ...UNRELATED,
    ],
    reads: ['3:process.getBuiltinModule'],
    what: "an ambient namespace of a namespace's body",
  },
  {
    id: 'body-declare-const',
    lines: [
      'namespace Inner {',
      '  declare const process: unknown;',
      "  export const loaded = process.getBuiltinModule('node:child_process');",
      '}',
    ],
    reads: ['3:process.getBuiltinModule'],
    what: "an ambient constant of a namespace's body",
  },
  {
    id: 'body-declare-var',
    lines: [
      'namespace Inner {',
      '  declare var process: unknown;',
      "  export const loaded = process.getBuiltinModule('node:child_process');",
      '}',
    ],
    reads: ['3:process.getBuiltinModule'],
    what: "an ambient `var` of a namespace's body",
  },
  {
    id: 'body-declare-function',
    lines: [
      'namespace Inner {',
      '  declare function process(): void;',
      "  export const loaded = process.getBuiltinModule('node:child_process');",
      '}',
    ],
    reads: ['3:process.getBuiltinModule'],
    what: "an ambient function of a namespace's body",
  },
  {
    id: 'body-exported-declare-const',
    lines: [
      'namespace Inner {',
      '  export declare const process: unknown;',
      "  export const loaded = process.getBuiltinModule('node:child_process');",
      '}',
    ],
    reads: ['3:process.getBuiltinModule'],
    what: "an exported ambient constant of a namespace's body, which a toolchain may leave bare",
  },
  {
    id: 'merged-ambient-member',
    lines: [
      'declare namespace Inner { const process: unknown; }',
      'namespace Inner {',
      "  export const loaded = process.getBuiltinModule('node:child_process');",
      '}',
    ],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient member of another body of the namespace, which a toolchain may leave bare',
  },
  {
    id: 'block-declare-const',
    lines: [
      'export function run() {',
      '  declare const process: unknown;',
      "  return process.getBuiltinModule('node:child_process');",
      '}',
    ],
    reads: ['3:process.getBuiltinModule'],
    what: "an ambient constant of a function's body, which TypeScript refuses and strips",
  },
  {
    id: 'block-declare-var',
    lines: [
      'export function run() {',
      '  declare var process: unknown;',
      "  return process.getBuiltinModule('node:child_process');",
      '}',
    ],
    reads: ['3:process.getBuiltinModule'],
    what: "an ambient `var` of a function's body",
  },
  {
    id: 'block-declare-function',
    lines: [
      'export function run() {',
      '  declare function process(): void;',
      "  return process.getBuiltinModule('node:child_process');",
      '}',
    ],
    reads: ['3:process.getBuiltinModule'],
    what: "an ambient function of a function's body",
  },
  {
    id: 'block-declare-class',
    lines: [
      'export function run() {',
      '  if (true) {',
      '    declare class process {}',
      "    return process.getBuiltinModule('node:child_process');",
      '  }',
      '}',
    ],
    reads: ['4:process.getBuiltinModule'],
    what: 'an ambient class of a block',
  },
  {
    id: 'function-code-global',
    lines: [
      'declare namespace Function { const own: number; }',
      'export function run(source: string) {',
      '  return Function(source)();',
      '}',
      'function unrelated(Function: unknown) {',
      '  return Function;',
      '}',
    ],
    reads: ['3:Function'],
    what: 'an ambient namespace of the name `Function`',
  },
] as const;

const PINS = [
  {
    id: 'ambient-global-namespace',
    lines: [
      'export {};',
      'declare global { namespace process { const own: number; } }',
      ...READ,
      ...UNRELATED,
    ],
    reads: ['4:process.getBuiltinModule'],
    what: 'an ambient namespace written under `declare global`',
  },
  {
    id: 'ambient-global-var',
    lines: ['export {};', 'declare global { var process: unknown; }', ...READ, ...UNRELATED],
    reads: ['4:process.getBuiltinModule'],
    what: 'an ambient `var` written under `declare global`',
  },
  {
    id: 'ambient-module-namespace',
    lines: [
      "declare module 'other' { namespace process { const own: number; } }",
      ...READ,
      ...UNRELATED,
    ],
    reads: ['3:process.getBuiltinModule'],
    what: "an ambient namespace written in an ambient module's body",
  },
  {
    id: 'types-only-namespace',
    lines: ['declare namespace process { interface Own {} }', ...READ, ...UNRELATED],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient namespace of types alone (a pin)',
  },
  {
    id: 'nested-ambient-namespace',
    lines: [
      'declare namespace Outer { namespace process { const own: number; } }',
      ...READ,
      ...UNRELATED,
    ],
    reads: ['3:process.getBuiltinModule'],
    what: 'an ambient namespace of another name, with the name below it (a pin)',
  },
  {
    id: 'value-namespace',
    lines: ['namespace process { export const own = 1; }', ...READ, ...UNRELATED],
    reads: [],
    what: 'a namespace that holds a value (a pin)',
  },
  {
    id: 'value-namespace-dotted',
    lines: ['namespace process.inner { export const own = 1; }', ...READ, ...UNRELATED],
    reads: [],
    what: 'a dotted namespace that holds a value (a pin)',
  },
  {
    id: 'value-namespace-declared-member',
    lines: ['namespace process { declare const own: number; }', ...READ, ...UNRELATED],
    reads: [],
    what: 'a namespace whose only value is a `declare`d one, which TypeScript emits (a pin)',
  },
  {
    id: 'value-namespace-over-declared-function',
    lines: [
      'declare function process(): void;',
      'namespace process { export const own = 1; }',
      ...READ,
    ],
    reads: [],
    what: 'a namespace of a value merged with an ambient function (a pin)',
  },
  {
    id: 'function-over-ambient-namespace',
    lines: ['function process() {}', 'declare namespace process { const own: number; }', ...READ],
    reads: [],
    what: 'an ambient namespace merged with a function (a pin)',
  },
  {
    id: 'class-over-ambient-namespace',
    lines: ['class process {}', 'declare namespace process { const own: number; }', ...READ],
    reads: [],
    what: 'an ambient namespace merged with a class (a pin)',
  },
  {
    id: 'enum-over-ambient-namespace',
    lines: ['enum process { A }', 'declare namespace process { const own: number; }', ...READ],
    reads: [],
    what: 'an ambient namespace merged with an enum (a pin)',
  },
  {
    id: 'function-with-ambient-var',
    lines: ['function process() {}', 'declare var process: unknown;', ...READ],
    reads: [],
    what: 'an ambient `var` beside a function of the name (a pin)',
  },
  {
    id: 'constant',
    lines: ['const process = { getBuiltinModule: (name: string) => name };', ...READ],
    reads: [],
    what: 'a constant (a pin)',
  },
  {
    id: 'function',
    lines: ['function process() {}', ...READ],
    reads: [],
    what: 'a function (a pin)',
  },
  {
    id: 'body-value-namespace',
    lines: [
      'namespace Inner {',
      '  namespace process { export const own = 1; }',
      "  export const loaded = process.getBuiltinModule('node:child_process');",
      '}',
      ...UNRELATED,
    ],
    reads: [],
    what: "a namespace of a value in a namespace's body (a pin)",
  },
  {
    id: 'body-constant',
    lines: [
      'namespace Inner {',
      '  const process = { getBuiltinModule: (name: string) => name };',
      "  export const loaded = process.getBuiltinModule('node:child_process');",
      '}',
    ],
    reads: [],
    what: "a constant of a namespace's body (a pin)",
  },
  {
    id: 'merged-body-member',
    lines: [
      'namespace Inner { export const process = { getBuiltinModule: (name: string) => name }; }',
      'namespace Inner {',
      "  export const loaded = process.getBuiltinModule('node:child_process');",
      '}',
    ],
    reads: [],
    what: 'a member another body of the namespace exports, which it is there (a pin)',
  },
  {
    id: 'block-constant',
    lines: [
      'export function run() {',
      '  const process = { getBuiltinModule: (name: string) => name };',
      "  return process.getBuiltinModule('node:child_process');",
      '}',
    ],
    reads: [],
    what: "a constant of a function's body (a pin)",
  },
  {
    id: 'parameter',
    lines: [
      'export function run(process: { getBuiltinModule(name: string): unknown }) {',
      "  return process.getBuiltinModule('node:child_process');",
      '}',
    ],
    reads: [],
    what: "a function's parameter (a pin)",
  },
] as const;

describe('a name an ambient declaration gives, beside a global of its name', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /**
   * Where `found` says a node of the module `lines` reads what it looks for, `line:text`, walked
   * as a shared module's checks walk it: past what is erased (`isErased`).
   */
  function foundIn(lines: readonly string[], found: (node: Node) => boolean): readonly string[] {
    const source = `${lines.join('\n')}\n`;
    using parsed = api.createSourceFile('ambient.ts', source);
    const { sourceFile } = parsed;
    const reads: string[] = [];
    const visit = (node: Node): void => {
      // A namespace's own name, `process` of `declare namespace process`, is no read of it.
      if (
        isErased(node) ||
        (isIdentifier(node) && isModuleDeclaration(node.parent) && node.parent.name === node)
      ) {
        return;
      }
      if (found(node)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        reads.push(`${String(line + 1)}:${source.slice(node.getStart(sourceFile), node.end)}`);
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    return reads;
  }

  it.each(FIXED)('reads the global past $id: $what', ({ lines, reads }) => {
    expect(foundIn(lines, (node) => readsCodeGlobal(node))).toStrictEqual(reads);
  });

  it.each(PINS)('reads $id as the module reads it: $what', ({ lines, reads }) => {
    expect(foundIn(lines, (node) => readsCodeGlobal(node))).toStrictEqual(reads);
  });

  it('hands on a global of the name an ambient declaration gives', () => {
    const lines = [
      'declare const Math: unknown;',
      "export const pick = () => Reflect.get(Math, 'random');",
    ];
    const reached = new Set(['Math.random']);

    expect(foundIn(lines, (node) => handedGlobal(node, reached) !== undefined)).toStrictEqual([
      '2:Math',
    ]);
  });

  it('does not hand on the global where a constant of the name stands', () => {
    const lines = [
      'const Math = { random: () => 4 };',
      "export const pick = () => Reflect.get(Math, 'random');",
    ];
    const reached = new Set(['Math.random']);

    expect(foundIn(lines, (node) => handedGlobal(node, reached) !== undefined)).toStrictEqual([]);
  });
});

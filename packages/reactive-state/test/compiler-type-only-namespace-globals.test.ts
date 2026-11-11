import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * A namespace of types alone — interfaces, aliases, namespaces of them, an empty body — emits no
 * value, so the name it shares with a value is that value's: with a declaration of the name
 * elsewhere in the module, which makes the compile resolve each read by its scope, a global's read
 * in a namespace of the name is still the global's. A namespace that declares a value of its own
 * hides the global, as a function of the name does.
 */

const UNRELATED = ['function unrelated(Function: unknown) {', '  return Function;', '}'];

const CASES = [
  {
    lines: [
      'namespace Inner {',
      '  namespace Function {',
      '    export type T = string;',
      '  }',
      '  export const made = (text: string) => Function(text)();',
      '}',
      ...UNRELATED,
    ],
    reads: ['5:Function'],
    what: 'a namespace of a type alone',
  },
  {
    lines: [
      'namespace Inner {',
      '  namespace Function {}',
      '  export const made = (text: string) => Function(text)();',
      '}',
      ...UNRELATED,
    ],
    reads: ['3:Function'],
    what: 'an empty namespace',
  },
  {
    lines: [
      'namespace Inner {',
      '  namespace Function.Deep {',
      '    export interface I {}',
      '  }',
      '  export const made = (text: string) => Function(text)();',
      '}',
      ...UNRELATED,
    ],
    reads: ['5:Function'],
    what: 'a namespace of a dotted name that holds types alone',
  },
  {
    lines: [
      'namespace Types {',
      '  export type T = string;',
      '}',
      'namespace Inner {',
      '  namespace Function {',
      '    import T = Types.T;',
      '  }',
      '  export const made = (text: string) => Function(text)();',
      '}',
      ...UNRELATED,
    ],
    reads: ['8:Function'],
    what: 'a namespace of an alias it does not export',
  },
  {
    lines: [
      'namespace Inner {',
      '  namespace Function {',
      '    export const own = 1;',
      '  }',
      '  export const made = (text: string) => Function(text);',
      '}',
      ...UNRELATED,
    ],
    reads: [],
    what: 'a namespace that declares a value of its own',
  },
] as const;

describe('a namespace of types alone, beside a global of its name', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Where a node of the module `lines` reads what makes code of text, `line:text`, past what is erased. */
  function codeReadsIn(lines: readonly string[]): readonly string[] {
    const source = `${lines.join('\n')}\n`;
    using parsed = api.createSourceFile('namespaces.ts', source);
    const { sourceFile } = parsed;
    const reads: string[] = [];
    const visit = (node: Node): void => {
      if (isErased(node)) {
        return;
      }
      if (readsCodeGlobal(node)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        reads.push(`${String(line + 1)}:${source.slice(node.getStart(sourceFile), node.end)}`);
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    return reads;
  }

  it.each(CASES)('reads a global past $what', ({ lines, reads }) => {
    expect(codeReadsIn(lines)).toStrictEqual(reads);
  });
});

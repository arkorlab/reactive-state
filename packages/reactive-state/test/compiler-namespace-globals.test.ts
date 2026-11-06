import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * A namespace's code reads a global where no declaration in scope gives the name, as the module's
 * other code does: neither what the namespace's body declares, nor what the bodies it merges with
 * export, nor the module's own. A declaration elsewhere in the module — another function's
 * parameter, a `var` of a namespace's body, which is that body's — hides the global from no read
 * of it.
 */

const UNRELATED = ['function unrelated(Function: unknown) {', '  return Function;', '}'];

const CASES = [
  {
    lines: [
      'namespace Inner {',
      '  export const made = (text: string) => Function(text)();',
      '}',
      ...UNRELATED,
    ],
    reads: ['2:Function'],
    what: "a namespace's read",
  },
  {
    lines: [
      'namespace Outer {',
      '  export namespace Inner {',
      '    export const made = (text: string) => Function(text)();',
      '  }',
      '}',
      ...UNRELATED,
    ],
    reads: ['3:Function'],
    what: "a nested namespace's read",
  },
  {
    lines: [
      'namespace Outer.Inner {',
      '  export const made = (text: string) => Function(text)();',
      '}',
      ...UNRELATED,
    ],
    reads: ['2:Function'],
    what: "a dotted namespace's read",
  },
  {
    lines: [
      'namespace Inner {',
      '  const Function = (text: string) => text;',
      '}',
      'namespace Inner {',
      '  export const made = (text: string) => Function(text)();',
      '}',
    ],
    reads: ['5:Function'],
    what: "another body's own constant",
  },
  {
    lines: [
      'namespace Inner {',
      '  var Function = 1;',
      '}',
      'export function run(source: string) {',
      '  return Function(source)();',
      '}',
    ],
    reads: ['5:Function'],
    what: "a namespace's var, outside",
  },
  {
    lines: [
      'namespace Inner {',
      '  const Function = (text: string) => text;',
      '  export const made = (text: string) => Function(text);',
      '}',
    ],
    reads: [],
    what: "the namespace's constant",
  },
  {
    lines: [
      'namespace Inner {',
      '  export const Function = (text: string) => text;',
      '}',
      'namespace Inner {',
      '  export const made = (text: string) => Function(text);',
      '}',
    ],
    reads: [],
    what: "a merged body's export",
  },
  {
    lines: [
      'namespace Inner {',
      '  {',
      '    var Function = (text: string) => text;',
      '  }',
      '  export const made = (text: string) => Function(text);',
      '}',
    ],
    reads: [],
    what: "a var of the namespace's block",
  },
] as const;

describe('a global read in a namespace where another declaration gives its name', () => {
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

  it.each(CASES)('$what', ({ lines, reads }) => {
    expect(codeReadsIn(lines)).toStrictEqual(reads);
  });
});

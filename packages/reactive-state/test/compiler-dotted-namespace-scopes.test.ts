import {
  isArrowFunction,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  type Node,
} from 'typescript/ast';
import { API, ScriptKind } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserOnlyIn } from '../src/compiler/browser-only.ts';
import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * `namespace Outer.Inner {}` is `namespace Outer { export namespace Inner {} }`: within it a name is
 * what its own body declares, what the bodies of `Inner` that merge with it export, what the bodies
 * of `Outer` export — which are not its own body's, for it has none but `Inner` — and then the
 * module's. A function `Outer` exports hides an import of its name, or a global's, from `Inner`'s
 * reads, as a function the body of `namespace Outer { export namespace Inner {} }` is nested in
 * does; one `Outer` keeps to itself, or another namespace's, hides nothing.
 */

const REACT = "import { useEffect } from 'react';";
const OWN = ['  export function useEffect(run: () => void) {', '    run();', '  }'];
const RENDER = [
  '  export function render() {',
  '    useEffect(() => marker());',
  '    return <p>fixed</p>;',
  '  }',
];

const HOOKS = [
  {
    lines: [REACT, 'namespace Outer {', ...OWN, '}', 'namespace Outer.Inner {', ...RENDER, '}'],
    skipped: false,
    what: "a function the outer namespace exports, read in a dotted one's body",
  },
  {
    lines: [REACT, 'namespace Outer.Inner {', ...RENDER, '}', 'namespace Outer {', ...OWN, '}'],
    skipped: false,
    what: 'a function a later body of the outer namespace exports',
  },
  {
    lines: [REACT, 'namespace Outer {', ...OWN, '}', 'namespace Outer.Mid.Inner {', ...RENDER, '}'],
    skipped: false,
    what: 'a function the outermost namespace exports, in a body of three names',
  },
  {
    lines: [
      REACT,
      'namespace Outer.Mid {',
      ...OWN,
      '}',
      'namespace Outer.Mid.Inner {',
      ...RENDER,
      '}',
    ],
    skipped: false,
    what: 'a function the middle namespace exports, in a body of three names',
  },
  {
    lines: [
      REACT,
      'namespace Outer {',
      '  export namespace Mid {',
      '  export function useEffect(run: () => void) {',
      '    run();',
      '  }',
      '  }',
      '}',
      'namespace Outer.Mid.Inner {',
      ...RENDER,
      '}',
    ],
    skipped: false,
    what: 'a function a namespace nested in the outer one exports, in a body of three names',
  },
  {
    lines: [
      REACT,
      'namespace Outer {',
      '  function useEffect(run: () => void) {',
      '    run();',
      '  }',
      '}',
      'namespace Outer.Inner {',
      ...RENDER,
      '}',
    ],
    skipped: true,
    what: 'a function the outer namespace keeps to itself',
  },
  {
    lines: [REACT, 'namespace Outer {', ...OWN, '}', 'namespace Other.Inner {', ...RENDER, '}'],
    skipped: true,
    what: "another namespace's exported function",
  },
  {
    lines: [REACT, 'namespace Outer.Inner {', ...RENDER, '}'],
    skipped: true,
    what: 'an effect of React, in a dotted namespace',
  },
] as const;

const GLOBALS = [
  {
    lines: [
      'namespace Outer {',
      '  export const Function = (text: string) => text;',
      '}',
      'namespace Outer.Inner {',
      '  export const made = (text: string) => Function(text);',
      '}',
    ],
    reads: [],
    what: 'a constant the outer namespace exports, read in a dotted one',
  },
  {
    lines: [
      'namespace Outer.Inner {',
      '  export const made = (text: string) => Function(text);',
      '}',
      'namespace Outer {',
      '  export const Function = (text: string) => text;',
      '}',
    ],
    reads: [],
    what: 'a constant a later body of the outer namespace exports',
  },
  {
    lines: [
      'namespace Outer {',
      '  const Function = (text: string) => text;',
      '}',
      'namespace Outer.Inner {',
      '  export const made = (text: string) => Function(text)();',
      '}',
    ],
    reads: ['5:Function'],
    what: 'a constant the outer namespace keeps to itself',
  },
] as const;

describe('a name read in a namespace of a dotted name', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `browserOnlyIn` skips the function `() => marker()` of the Client Component's module `lines`. */
  function skipsMarked(lines: readonly string[]): boolean {
    const source = `'use client';\n${lines.join('\n')}\n`;
    using parsed = api.createSourceFile('widget.tsx', source, { scriptKind: ScriptKind.TSX });
    let marked: Node | undefined;
    const visit = (node: Node): void => {
      if (
        (isArrowFunction(node) || isFunctionExpression(node)) &&
        isCallExpression(node.body) &&
        isIdentifier(node.body.expression) &&
        node.body.expression.text === 'marker'
      ) {
        marked = node;
      }
      node.forEachChild(visit);
    };
    parsed.sourceFile.forEachChild(visit);
    if (marked === undefined) {
      throw new Error('No function `() => marker()` is written.');
    }
    return browserOnlyIn(parsed.sourceFile)(marked);
  }

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

  it.each(HOOKS)('skips the callback of an effect of $what', ({ lines, skipped }) => {
    expect(skipsMarked(lines)).toBe(skipped);
  });

  it.each(GLOBALS)('reads a global past $what', ({ lines, reads }) => {
    expect(codeReadsIn(lines)).toStrictEqual(reads);
  });
});

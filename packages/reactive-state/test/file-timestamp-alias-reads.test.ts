import { type Identifier, isIdentifier, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalPathOf } from '../src/compiler/code-globals.ts';
import { fileReferenceReadsClock } from '../src/compiler/file-timestamps.ts';

/** How many reads of names no declaration answers a module has, in each row of the first test. */
const READS = [500, 1000, 2000, 4000] as const;

/** Following a File's constant alias through the module takes less than this, whatever the reads. */
const BUDGET_MS = 1000;

/** The module: the alias, its construction, and `reads` reads of names nothing declares. */
function moduleOf(reads: number, beside: string): string {
  return [
    'declare function use(value: unknown): void;',
    "const Make = File; new Make([], 'x', { lastModified: 0 });",
    ...Array.from({ length: reads }, (_, at) => `use(read${String(at)});`),
    beside,
  ].join('\n');
}

/**
 * A File a constant aliases is followed to the reads of that constant, each resolved to the
 * declaration it reads, of its own name alone: a module of thousands of reads of other names is not
 * walked again for each. The rows marked a pin answer the same before the change as after it.
 */
describe('the reads of a constant that aliases a File', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the global File of `source` can escape construction, and how long that took to tell. */
  function followed(source: string): { readonly escapes: boolean; readonly took: number } {
    using parsed = api.createSourceFile('file-alias.ts', source);
    let file: Identifier | undefined;
    const find = (node: Node): void => {
      if (file === undefined && isIdentifier(node) && globalPathOf(node)?.join('.') === 'File') {
        file = node;
      }
      node.forEachChild(find);
    };
    find(parsed.sourceFile);
    if (file === undefined) throw new Error('No global File is read.');
    const started = performance.now();
    const escapes = fileReferenceReadsClock(file);
    return { escapes, took: performance.now() - started };
  }

  it.each(READS)('follows its alias through %i reads of other names in time', (reads) => {
    const { escapes, took } = followed(moduleOf(reads, ''));

    expect(escapes).toBe(false);
    // Each read walked the module's statements anew: seconds, thousands of reads at a time.
    expect(took).toBeLessThan(BUDGET_MS);
  });

  it.each([
    { beside: 'use(Make);', escapes: true, what: 'handed on, a read among the others' },
    {
      beside: 'const Again = Make; use(Again);',
      escapes: true,
      what: 'handed on by a second alias',
    },
    { beside: 'use(Make instanceof Function);', escapes: true, what: 'handed on by a comparison' },
    {
      beside: 'function other(Make: unknown) { use(Make); }',
      escapes: false,
      what: 'shadowed (pin)',
    },
    {
      beside: 'const Other = Make; new Other([], "y", { lastModified: 1 });',
      escapes: false,
      what: 'dated, by an alias (pin)',
    },
  ])('answers as before, $what', ({ beside, escapes }) => {
    expect(followed(moduleOf(1000, beside)).escapes).toBe(escapes);
  });
});

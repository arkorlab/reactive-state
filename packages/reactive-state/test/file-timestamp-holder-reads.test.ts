import { isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasFileTimestamp } from '../src/compiler/file-timestamps.ts';

/** Reads of other names in a module, each of which no declaration in it answers. */
const READS = { count: 4000 } as const;

/** A whole check of a File, however many names the module reads, takes less than this. */
const BUDGET_MS = 2000;

/**
 * Whether a constant of a File's options is used only by the File is read of the uses of its own
 * name: a module that reads thousands of other names, globals among them, takes no longer for it.
 */
describe('the uses of a constant of File options', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the File the module makes last shows its timestamp, and how long the check took. */
  function checked(source: string): { readonly dated: boolean; readonly took: number } {
    using parsed = api.createSourceFile('file-timestamp-holders.ts', source);
    let made: NewExpression | undefined;
    const visit = (node: Node): void => {
      if (isNewExpression(node)) {
        made = node;
      }
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (made === undefined) {
      throw new Error('The module makes no File.');
    }
    const started = performance.now();
    const dated = hasFileTimestamp(made);
    return { dated, took: performance.now() - started };
  }

  it('reads only the uses of the holder’s name', () => {
    const reads = Array.from({ length: READS.count }, (_, at) => `use(read${String(at)});`);
    const { dated, took } = checked(
      [
        'declare function use(value: unknown): void;',
        'const options = { lastModified: 0 };',
        ...reads,
        "new File([], 'x', options);",
      ].join('\n'),
    );

    expect(dated).toBe(true);
    // Each read resolved its binding of the whole module once: seconds, a thousand reads at a time.
    expect(took).toBeLessThan(BUDGET_MS);
  });

  it('still reads a write of the holder (pin)', () => {
    const { dated } = checked(
      [
        'const options = { lastModified: 0 };',
        'options.lastModified = undefined as never;',
        "new File([], 'x', options);",
      ].join('\n'),
    );

    expect(dated).toBe(false);
  });
});

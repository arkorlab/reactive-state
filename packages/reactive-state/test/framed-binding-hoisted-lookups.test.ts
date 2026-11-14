import { type Identifier, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { frameDeclarationOf } from '../src/compiler/framed-bindings.ts';

/** Reads of names in a module, each of which no declaration in it answers. */
const READS = { count: 4000 } as const;

/** Looking up every read's declaration takes less than this. */
const BUDGET_MS = 2000;

/**
 * What a scope declares — its statements' declarations and its `var`s — is gathered once for every
 * lookup of a name in it: a module that reads thousands of names no declaration answers looks each
 * up without walking the module's statements again.
 */
describe('the declaration of each of many reads', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The names `use` is called with in `source`, and how many of them a declaration answers. */
  function lookedUp(source: string): { readonly found: number; readonly took: number } {
    using parsed = api.createSourceFile('framed-bindings.ts', source);
    const names: Identifier[] = [];
    const visit = (node: Node): void => {
      const [first] = isCallExpression(node) ? node.arguments : [];
      if (first !== undefined && isIdentifier(first)) names.push(first);
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    const started = performance.now();
    const found = names.filter((name) => frameDeclarationOf(name) !== undefined).length;
    return { found, took: performance.now() - started };
  }

  it('gathers the module’s declarations once for every read', () => {
    const reads = Array.from({ length: READS.count }, (_, at) => `use(read${String(at)});`);
    const { found, took } = lookedUp(
      ['declare function use(value: unknown): void;', ...reads].join('\n'),
    );

    expect(found).toBe(0);
    // Each lookup walked the module's statements anew: seconds, a thousand reads at a time.
    expect(took).toBeLessThan(BUDGET_MS);
  });

  it('still finds a var declared after its reads, in a block (pin)', () => {
    const { found } = lookedUp(
      [
        'declare function use(value: unknown): void;',
        'use(late);',
        'function f() { use(inner); { var inner = 1; } }',
        '{ var late = 1; }',
        'use(after);',
        'const after = 1;',
      ].join('\n'),
    );

    expect(found).toBe(3);
  });
});

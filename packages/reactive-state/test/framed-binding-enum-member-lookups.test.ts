import {
  type Identifier,
  isElementAccessExpression,
  isIdentifier,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { frameDeclarationOf } from '../src/compiler/framed-bindings.ts';

/** How many members an enum has, each of which reads a name, in each row. */
const MEMBERS = [500, 1000, 2000, 4000] as const;

/** Looking up every name an enum's initializers read takes less than this. */
const BUDGET_MS = 1000;

/** An enum of `members` members, each of which reads `key`, after the constant it is. */
function enumOf(members: number, own: string): string {
  const each = Array.from({ length: members }, (_, at) => `m${String(at)} = value[key]`);
  return `declare const value: unknown[]; const key = 1; enum E { ${own}${each.join(', ')} }`;
}

/**
 * The names an enum's members, and those of the enums merged with it, give are gathered once for
 * every name looked up within it: an enum of thousands of members, each of which reads a name,
 * does not search its members again for each. The rows marked a pin answer the same before the
 * change as after it.
 */
describe('the declaration of each name the members of an enum read', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The reads of `key` in `source`, which a declaration answers, and how long they took to look up. */
  function lookedUp(source: string): {
    readonly found: number;
    readonly reads: number;
    readonly took: number;
  } {
    using parsed = api.createSourceFile('framed-bindings.ts', source);
    const reads: Identifier[] = [];
    const visit = (node: Node): void => {
      if (isIdentifier(node) && node.text === 'key' && isElementAccessExpression(node.parent)) {
        reads.push(node);
      }
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    const started = performance.now();
    const found = reads.filter((name) => frameDeclarationOf(name) !== undefined).length;
    return { found, reads: reads.length, took: performance.now() - started };
  }

  it.each(MEMBERS)('looks up the names of %i members in time', (members) => {
    const { found, reads, took } = lookedUp(enumOf(members, ''));

    // Every read is of the constant, which is the name's declaration.
    expect(found).toBe(reads);
    // Each read searched every member: seconds, thousands of members at a time.
    expect(took).toBeLessThan(BUDGET_MS);
  });

  it('still stops at a member of the name, however many follow it (pin)', () => {
    const { found, reads } = lookedUp(enumOf(1000, 'key = 2, '));

    // Every read is of the member, which no declaration answers.
    expect(reads).toBe(1000);
    expect(found).toBe(0);
  });
});

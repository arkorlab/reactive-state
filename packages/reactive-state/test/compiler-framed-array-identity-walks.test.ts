import {
  type Expression,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it, vi } from 'vitest';

import { arrayIdentity } from '../src/compiler/framed-array-own-methods.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Which names a file writes as a whole is one fact of the file, not of each array it names: finding
 * the identity of many arrays walks the file once, so that the work stays in proportion to its size
 * and does not grow with the count of its arrays.
 */
const walks = vi.hoisted(() => ({ visited: 0 }));

vi.mock(import('../src/compiler/framed-written-targets.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    framedWrittenTargets: (node: Node) => {
      walks.visited += 1;
      return actual.framedWrittenTargets(node);
    },
  };
});

describe('the walk that finds the names a file writes as a whole', () => {
  it('visits each node of the file once, however many arrays it names', () => {
    const names = Array.from({ length: 40 }, (_, index) => `values${String(index)}`);
    const source = [
      'function frames(error: Error) {',
      ...names.map((name) => `  const ${name} = [error]; ${name}.join = () => 'safe';`),
      '}',
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'identity-walks.ts', source);

    const receivers: Expression[] = [];
    let nodes = 0;
    const pending: Node[] = [parsed.sourceFile];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      nodes += 1;
      if (isPropertyAccessExpression(node) && isIdentifier(node.expression))
        receivers.push(node.expression);
      node.forEachChild((child) => {
        pending.push(child);
      });
    }
    walks.visited = 0;
    const roots = receivers.map((receiver) => arrayIdentity(receiver));

    expect(receivers).toHaveLength(names.length);
    expect(roots.every((root) => root !== undefined)).toBe(true);
    expect(walks.visited).toBeLessThanOrEqual(nodes);
  });
});

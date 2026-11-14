import {
  type Identifier,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { writtenAsWhole } from '../src/compiler/framed-array-identity.ts';
import { frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The writes of a name as a whole are collected in one walk of the file, each into the list of its
 * name: a name that is assigned many times costs in proportion to the count of its assignments, not
 * to the square of it, as a list rebuilt at each write would.
 */
const WRITES = 60_000;
const SECONDS_PER_RUN = 20_000;

function receiverOf(root: Node): Identifier | undefined {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isPropertyAccessExpression(node) && isIdentifier(node.expression)) return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return undefined;
}

describe('the writes of a name as a whole', () => {
  it(
    'are collected in time proportional to their count',
    () => {
      const source = [
        'function frames() {',
        '  let list = [1];',
        ...Array.from({ length: WRITES }, () => '  list = [2];'),
        "  list.join = () => 'safe';",
        '}',
      ].join('\n');
      using api = openTypeScript();
      using parsed = parseModule(api, 'whole-writes-growth.ts', source);
      const receiver = receiverOf(parsed.sourceFile);

      expect(receiver).toBeDefined();

      const selected = receiver === undefined ? undefined : frameBindingOf(receiver);

      expect(selected).toBeDefined();

      const started = performance.now();
      const written = selected !== undefined && writtenAsWhole(selected.binding);
      const elapsed = performance.now() - started;

      expect(written).toBe(true);
      expect(elapsed).toBeLessThan(2000);
    },
    SECONDS_PER_RUN,
  );
});

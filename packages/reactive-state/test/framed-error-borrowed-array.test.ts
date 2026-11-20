import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { BORROWED_ARRAY_CASES } from './support/framed-borrowed-array-cases.ts';

/** Source observations retain native borrowing and deferred method-selection semantics. */
describe('borrowed array error words', () => {
  it.each(BORROWED_ARRAY_CASES)('$name', ({ source, framed }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'borrowed-array-errors.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(framed);
  });
});

function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

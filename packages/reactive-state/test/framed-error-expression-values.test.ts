import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { framedExpressionCases } from './support/framed-expression-cases.ts';

/** Source result wrappers retain engine-error reads while ordinary data keeps its meaning. */
describe('source expression error receivers', () => {
  it.each(framedExpressionCases)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'source-expression-receivers.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});

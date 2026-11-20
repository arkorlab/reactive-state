import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { framedSourceCases } from './support/framed-source-cases.ts';

describe('source-visible error receiver values', () => {
  it.each(framedSourceCases)('$name', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'error-sources.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(refused);
  });

  it('terminates cyclic immutable constructor aliases', () => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'error-sources.ts',
      'const First = Second; const Second = First; function frames() { return new First().stack; }',
    );

    expect(readsFrames(parsed.sourceFile)).toBe(false);
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

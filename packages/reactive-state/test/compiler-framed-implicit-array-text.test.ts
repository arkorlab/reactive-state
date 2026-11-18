import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Implicit text conversions — untagged template spans and `+` / `+=` — convert array operands
 * through `Array.prototype.toString`, exposing the words of any external `Error` element just as
 * `String([error])` does, while leaving locally constructed errors and plain data unflagged.
 */

const CASES = [
  {
    framed: true,
    id: 'template-literal-error-array',
    source: `function text(error: Error) { return \`\${[error]}\`; }`,
  },
  {
    framed: true,
    id: 'template-nested-spread-error-array',
    source: `function text(error: Error) { const values = [error]; return \`prefix:\${[...values]}\`; }`,
  },
  {
    framed: true,
    id: 'template-typed-error-array',
    source: `function text(errors: Error[]) { return \`\${errors}\`; }`,
  },
  {
    framed: true,
    id: 'plus-right-error-array',
    source: "function text(error: Error) { return '' + [error]; }",
  },
  {
    framed: true,
    id: 'plus-left-error-array',
    source: "function text(error: Error) { return [error] + ''; }",
  },
  {
    framed: true,
    id: 'plus-equals-error-array',
    source: "function text(error: Error) { let out = ''; out += [error] as never; return out; }",
  },
  {
    framed: true,
    id: 'plus-typed-error-array',
    source: "function text(errors: readonly TypeError[]) { return '' + errors; }",
  },
  {
    framed: true,
    id: 'template-direct-error',
    source: `function text(error: Error) { return \`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'template-locally-made-error-array',
    source: `function text() { return \`\${[new Error('ours')]}\`; }`,
  },
  {
    framed: false,
    id: 'plus-locally-made-error-array',
    source: "function text() { return '' + [new Error('ours')]; }",
  },
  {
    framed: false,
    id: 'plus-plain-data-array',
    source: "function text() { return '' + ['plain', { message: 'data' }]; }",
  },
] as const;

describe('implicit text conversions of error arrays', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'implicit-array-text.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(framed);
  });
});

function readsFrames(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isErased(node)) continue;
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

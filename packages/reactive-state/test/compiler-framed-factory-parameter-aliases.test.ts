import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Factory constructor argument checks follow local variable initializers, destructuring bindings,
 * nested helper declarations, `arguments` aliases, and non-quiet parameter defaults back to the
 * factory's parameters whenever call arguments are not quiet primitives, while keeping quiet
 * primitive call arguments, shadowed inner parameters, and unused aliases unflagged.
 */

const CASES = [
  {
    framed: true,
    id: 'const-alias-of-parameter-in-error-message',
    source: `function make(value: unknown) { const alias = value; return new Error(String(alias)); } function text(error: Error) { const local: Error = make([error]); return local.message; }`,
  },
  {
    framed: true,
    id: 'chained-const-aliases-of-parameter-in-error-message',
    source: `function make(value: unknown) { const first = value; const second = first; return new TypeError(String(second)); } function text(error: Error) { const local: Error = make([error]); return String(local); }`,
  },
  {
    framed: true,
    id: 'computed-const-text-from-parameter-passed-to-error',
    source: `function make(value: unknown) { const words = String(value); return new Error(words); } function text(error: Error) { const local: Error = make([error]); return local.message; }`,
  },
  {
    framed: true,
    id: 'object-destructured-parameter-alias-in-error-message',
    source: `function make(box: { readonly item: unknown }) { const { item } = box; return new Error(String(item)); } function text(error: Error) { const local: Error = make({ item: error }); return local.message; }`,
  },
  {
    framed: true,
    id: 'array-destructured-parameter-alias-in-error-message',
    source: `function make(pair: readonly [unknown]) { const [first] = pair; return new RangeError(String(first)); } function text(error: Error) { const local: Error = make([error]); return String(local); }`,
  },
  {
    framed: true,
    id: 'local-helper-function-reading-factory-parameter',
    source: `function make(value: unknown) { function format() { return String(value); } return new Error(format()); } function text(error: Error) { const local: Error = make([error]); return local.message; }`,
  },
  {
    framed: true,
    id: 'factory-reading-own-arguments-object-via-alias',
    source: `function make(_value: unknown) { const args = arguments; return new Error(String(args[0])); } function text(error: Error) { const local: Error = make([error]); return local.message; }`,
  },
  {
    framed: true,
    id: 'non-quiet-parameter-default-omitted-call-arg',
    source: `function run(error: Error) { function make(value: unknown = [error]) { const alias = value; return new Error(String(alias)); } const local: Error = make(); return local.message; }`,
  },
  {
    framed: true,
    id: 'returned-local-error-binding-with-aliased-parameter-arg',
    source: `function make(value: unknown) { const alias = value; const created = new Error(String(alias)); return created; } function text(error: Error) { const local: Error = make([error]); return String(local); }`,
  },
  {
    framed: true,
    id: 'direct-parameter-read-with-non-quiet-arg-pin',
    source: `function make(value: unknown) { return new Error(String(value)); } function text(error: Error) { const local: Error = make([error]); return local.message; }`,
  },
  {
    framed: false,
    id: 'aliased-parameter-with-quiet-primitive-arg-preserved',
    source: `function make(label: string) { const alias = label; return new Error(alias); } function text() { const local: Error = make('fixed'); return local.message; }`,
  },
  {
    framed: false,
    id: 'aliased-parameter-with-quiet-default-omitted-arg-preserved',
    source: `function make(label: string = 'fixed') { const alias = label; return new Error(alias); } function text() { const local: Error = make(); return String(local); }`,
  },
  {
    framed: false,
    id: 'shadowed-inner-callback-parameter-same-name-preserved',
    source: `function make(_value: unknown) { return new Error(((value: string) => value)('fixed')); } function text(error: Error) { const local: Error = make([error]); return local.message; }`,
  },
  {
    framed: false,
    id: 'unused-parameter-alias-with-fixed-error-message-preserved',
    source: `function make(value: unknown) { const alias = value; if (Boolean(alias)) return new Error('one'); return new Error('two'); } function text(error: Error) { const local: Error = make([error]); return local.message; }`,
  },
] as const;

describe('factory parameter alias tracking in written Error constructor arguments', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'factory-parameter-aliases.ts', source);

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

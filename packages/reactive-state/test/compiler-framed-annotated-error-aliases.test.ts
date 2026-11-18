import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Source-written word proofs on local `Error` bindings must follow whole lexical aliases and drop
 * the exemption whenever any reference mutates a member or lets the error object escape.
 */

const CASES = [
  {
    framed: true,
    id: 'reflect-set-message-through-const-alias',
    source: `function text(other: Error) { const error: Error = new Error('fixed'); const alias = error; Reflect.set(alias, 'message', other); return String(error); }`,
  },
  {
    framed: true,
    id: 'direct-member-write-through-chained-alias',
    source: `function text(other: Error) { const error: Error = new Error('fixed'); const first = error; const second = first; second.message = other as unknown as string; return String(error); }`,
  },
  {
    framed: true,
    id: 'object-assign-through-const-alias',
    source: `function text(other: Error) { const error: Error = new Error('fixed'); const alias = error; Object.assign(alias, other); return String(error); }`,
  },
  {
    framed: true,
    id: 'object-define-property-through-alias',
    source: `function text(other: Error) { const error: Error = new Error('fixed'); const alias = error; Object.defineProperty(alias, 'message', { value: other }); return \`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'reassigned-alias-variable-write',
    source: `function text(other: Error) { const error: Error = new Error('fixed'); let alias: Error; alias = error; Reflect.set(alias, 'message', other); return String(error); }`,
  },
  {
    framed: true,
    id: 'helper-call-escaping-annotated-error',
    source: `function overwrite(target: Error, other: Error) { Reflect.set(target, 'message', other); } function text(other: Error) { const error: Error = new Error('fixed'); overwrite(error, other); return String(error); }`,
  },
  {
    framed: true,
    id: 'object-holder-escaping-annotated-error',
    source: `function text(other: Error) { const error: Error = new Error('fixed'); const box = { error }; Reflect.set(box.error, 'message', other); return String(error); }`,
  },
  {
    framed: true,
    id: 'array-holder-escaping-annotated-error',
    source: `function text(other: Error) { const error: Error = new Error('fixed'); const list = [error]; Reflect.set(list[0]!, 'message', other); return String(error); }`,
  },
  {
    framed: true,
    id: 'unannotated-source-mutated-via-alias-into-annotated-binding',
    source: `function text(other: Error) { const first = new Error('fixed'); const alias = first; Reflect.set(alias, 'message', other); const second: Error = first; return String(second); }`,
  },
  {
    framed: true,
    id: 'unannotated-source-mutated-via-alias-into-typed-destructure',
    source: `function text(other: Error) { const error = new Error('fixed'); const alias = error; Reflect.set(alias, 'message', other); const { message }: Error = error; return message; }`,
  },
  {
    framed: false,
    id: 'unmutated-const-alias-string-and-message',
    source: `function text() { const error: Error = new Error('fixed'); const alias = error; return String(alias) + error.message; }`,
  },
  {
    framed: false,
    id: 'unmutated-chained-typed-aliases',
    source: `function text() { const first: Error = new Error('fixed'); const second = first; const third: Error = second; return \`\${third}\`; }`,
  },
  {
    framed: false,
    id: 'annotated-error-strict-guard-and-to-string',
    source: `function text() { const error: Error = new Error('fixed'); return error !== undefined ? error.toString() : ''; }`,
  },
  {
    framed: true,
    id: 'direct-reflect-set-on-annotated-error',
    source: `function text(other: Error) { const error: Error = new Error('fixed'); Reflect.set(error, 'message', other); return String(error); }`,
  },
] as const;

describe('annotated local Error bindings under aliases and escapes', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'annotated-error-aliases.ts', source);

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

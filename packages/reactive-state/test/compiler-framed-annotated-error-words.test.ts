import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Unmutated local `Error` variable bindings initialized with source-written error words keep those
 * known words for `String(error)`, `.message`, destructuring, and array conversions even when the
 * variable carries an explicit `: Error` annotation, while `.stack`, parameter defaults, reassigned
 * bindings, and unproven initializers remain refused.
 */

const CASES = [
  {
    framed: false,
    id: 'annotated-const-error-string-conversion',
    source: `function text() { const error: Error = new Error('fixed'); return String(error); }`,
  },
  {
    framed: false,
    id: 'annotated-const-error-message-read',
    source: `function text() { const error: Error = new Error('fixed'); return error.message; }`,
  },
  {
    framed: false,
    id: 'annotated-const-typeerror-template',
    source: `function text() { const error: TypeError = new TypeError('fixed'); return \`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'annotated-const-error-alias-chain',
    source: `function text() { const first: Error = new Error('fixed'); const second: Error = first; return String(second); }`,
  },
  {
    framed: false,
    id: 'annotated-const-error-from-local-factory',
    source: `function make() { return new Error('fixed'); } function text() { const error: Error = make(); return String(error); }`,
  },
  {
    framed: false,
    id: 'annotated-unreassigned-let-error',
    source: `function text() { let error: Error = new Error('fixed'); return String(error); }`,
  },
  {
    framed: false,
    id: 'annotated-destructured-message-from-annotated-const',
    source: `function text() { const error: Error = new Error('fixed'); const { message }: Error = error; return message; }`,
  },
  {
    framed: false,
    id: 'annotated-const-error-in-array-join',
    source: `function text() { const error: Error = new Error('fixed'); return [error].join(','); }`,
  },
  {
    framed: true,
    id: 'annotated-const-error-stack-still-refused',
    source: `function text() { const error: Error = new Error('fixed'); return error.stack; }`,
  },
  {
    framed: true,
    id: 'annotated-destructured-stack-still-refused',
    source: `function text() { const error: Error = new Error('fixed'); const { stack } = error; return stack; }`,
  },
  {
    framed: true,
    id: 'reassigned-annotated-let-error-refused',
    source: `function text(other: Error) { let error: Error = new Error('fixed'); error = other; return String(error); }`,
  },
  {
    framed: true,
    id: 'annotated-error-parameter-default-refused',
    source: `function text(error: Error = new Error('fixed')) { return String(error); }`,
  },
  {
    framed: true,
    id: 'annotated-const-error-from-unproven-call-refused',
    source: `declare function externalError(): Error; function text() { const error: Error = externalError(); return String(error); }`,
  },
  {
    framed: true,
    id: 'annotated-const-error-assigned-object-mutation-refused',
    source: `function text(other: Error) { const error: Error = new Error('fixed'); Object.assign(error, other); return error.message; }`,
  },
] as const;

describe('annotated local Error bindings with source-written words', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'annotated-error-words.ts', source);

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

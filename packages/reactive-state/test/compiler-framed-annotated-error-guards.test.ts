import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Pure truthiness checks (`if`, `while`, `do ... while`, `for`, `!`, `Boolean`, and `?:`
 * conditions) inspect an annotated local `Error` without exposing or mutating the object, whereas
 * value-yielding logical or conditional branches that escape into variables or calls stay refused.
 */

const CASES = [
  {
    framed: false,
    id: 'if-truthiness-guard-before-message-read',
    source: `function text() { const error: Error = new Error('fixed'); if (error) return error.message; return ''; }`,
  },
  {
    framed: false,
    id: 'while-truthiness-guard-before-string-conversion',
    source: `function text() { const error: Error = new Error('fixed'); while (error) return String(error); return ''; }`,
  },
  {
    framed: false,
    id: 'do-while-truthiness-guard-before-template',
    source: `function text() { const error: Error = new Error('fixed'); let out = ''; do { out = \`\${error}\`; break; } while (error); return out; }`,
  },
  {
    framed: false,
    id: 'for-condition-truthiness-guard',
    source: `function text() { const error: Error = new Error('fixed'); for (; error; ) return error.message; return ''; }`,
  },
  {
    framed: false,
    id: 'boolean-call-truthiness-test',
    source: `function text() { const error: Error = new Error('fixed'); return Boolean(error) ? error.message : ''; }`,
  },
  {
    framed: false,
    id: 'logical-and-inside-if-condition',
    source: `function text(ready: boolean) { const error: Error = new Error('fixed'); if (ready && error) return error.message; return ''; }`,
  },
  {
    framed: false,
    id: 'logical-or-inside-boolean-call',
    source: `function text(ready: boolean) { const error: Error = new Error('fixed'); return Boolean(error || ready) ? String(error) : ''; }`,
  },
  {
    framed: false,
    id: 'conditional-branch-inside-negation',
    source: `function text(ready: boolean) { const error: Error = new Error('fixed'); if (!(ready ? error : false)) return ''; return error.message; }`,
  },
  {
    framed: false,
    id: 'unary-negation-and-ternary-condition-preserved',
    source: `function text() { const error: Error = new Error('fixed'); if (!error) return ''; return error ? error.message : ''; }`,
  },
  {
    framed: true,
    id: 'logical-and-escaping-to-variable-mutated-refused',
    source: `function text(ready: boolean, other: Error) { const error: Error = new Error('fixed'); const leaked = ready && error; if (leaked) Reflect.set(leaked, 'message', other); return String(error); }`,
  },
  {
    framed: true,
    id: 'logical-or-escaping-to-helper-call-refused',
    source: `function overwrite(value: unknown, other: Error) { Reflect.set(value as object, 'message', other); } function text(other: Error) { const error: Error = new Error('fixed'); overwrite(error || null, other); return String(error); }`,
  },
  {
    framed: true,
    id: 'conditional-branch-escaping-to-variable-mutated-refused',
    source: `function text(ready: boolean, other: Error) { const error: Error = new Error('fixed'); const chosen = ready ? error : null; if (chosen) Reflect.set(chosen, 'message', other); return error.message; }`,
  },
  {
    framed: true,
    id: 'shadowed-boolean-helper-escaping-error-refused',
    source: `function text(other: Error) { const Boolean = (target: Error) => { Reflect.set(target, 'message', other); return true; }; const error: Error = new Error('fixed'); return Boolean(error) ? error.message : ''; }`,
  },
] as const;

describe('pure truthiness guards on annotated local Error bindings', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'annotated-error-guards.ts', source);

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

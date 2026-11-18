import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Every reachable value branch and local factory return feeding an annotated `Error` binding must
 * construct an unmutated, non-escaping local known-word `Error` before its `: Error` annotation can
 * be exempted.
 */

const CASES = [
  {
    framed: true,
    id: 'conditional-local-error-and-opaque-helper',
    source: `declare function passThrough(error: Error): Error; function text(local: boolean, external: Error) { const error: Error = local ? new Error('fixed') : passThrough(external); return String(error); }`,
  },
  {
    framed: true,
    id: 'conditional-opaque-helper-and-local-error',
    source: `declare function passThrough(error: Error): Error; function text(local: boolean, external: Error) { const error: Error = local ? passThrough(external) : new Error('fixed'); return error.message; }`,
  },
  {
    framed: true,
    id: 'logical-or-unproven-left-and-local-error',
    source: `declare function maybeExternal(): Error | undefined; function text() { const error: Error = maybeExternal() || new Error('fixed'); return String(error); }`,
  },
  {
    framed: true,
    id: 'nullish-coalescing-unproven-left-and-local-error',
    source: `declare function maybeExternal(): Error | undefined; function text() { const error: Error = maybeExternal() ?? new Error('fixed'); return \`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'logical-and-unproven-left-and-local-error',
    source: `declare function maybeFlag(): unknown; function text() { const error: Error = (maybeFlag() && new Error('fixed')) as Error; return String(error); }`,
  },
  {
    framed: true,
    id: 'factory-decorating-returned-error-via-reflect-set',
    source: `function decorate(target: Error, other: Error) { Reflect.set(target, 'message', other); return 0; } function make(other: Error) { const e = new Error('fixed'); const unused = decorate(e, other); return e; } function text(other: Error) { const error: Error = make(other); return String(error); }`,
  },
  {
    framed: true,
    id: 'factory-mutating-returned-error-via-alias',
    source: `declare function externalWords(): unknown; function make() { const e = new Error('fixed'); const alias = e; const unused = Reflect.set(alias, 'message', externalWords()); return e; } function text() { const error: Error = make(); return error.message; }`,
  },
  {
    framed: true,
    id: 'factory-branching-to-opaque-call',
    source: `declare function externalError(): Error; function make(flag: boolean) { if (flag) return new Error('fixed'); return externalError(); } function text(flag: boolean) { const error: Error = make(flag); return String(error); }`,
  },
  {
    framed: true,
    id: 'factory-returning-shared-outer-binding-mutated-elsewhere',
    source: `function run(other: Error) { const shared = new Error('fixed'); function make() { return shared; } const leaked = make(); Reflect.set(leaked, 'message', other); const error: Error = make(); return String(error); }`,
  },
  {
    framed: true,
    id: 'typed-destructure-from-mixed-conditional-initializer',
    source: `declare function passThrough(error: Error): Error; function text(local: boolean, external: Error) { const { message }: Error = local ? new Error('fixed') : passThrough(external); return message; }`,
  },
  {
    framed: false,
    id: 'conditional-two-local-error-branches-preserved',
    source: `function text(flag: boolean) { const error: Error = flag ? new Error('first') : new TypeError('second'); return String(error); }`,
  },
  {
    framed: false,
    id: 'nullish-coalescing-literal-null-and-local-error',
    source: `function text() { const error: Error = null ?? new Error('fixed'); return error.message; }`,
  },
  {
    framed: false,
    id: 'comma-and-parenthesized-assertion-local-error',
    source: `function text() { const error: Error = (0, (new RangeError('fixed') as Error)); return String(error); }`,
  },
  {
    framed: false,
    id: 'local-factory-returning-unmutated-local-binding',
    source: `function make(flag: boolean) { if (flag) { const first = new Error('one'); return first; } const second = new TypeError('two'); return second; } function text(flag: boolean) { const error: Error = make(flag); return String(error); }`,
  },
  {
    framed: true,
    id: 'recursive-local-factory-terminates-conservatively',
    source: `function make(depth: number): Error { if (depth > 0) return make(depth - 1); return new Error('fixed'); } function text(depth: number) { const error: Error = make(depth); return String(error); }`,
  },
] as const;

describe('universal initializer and factory proofs on annotated Error bindings', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'annotated-error-initializers.ts', source);

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

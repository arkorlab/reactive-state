import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Native text concatenation converts error arguments, while arrays and own methods keep values. */
describe('string concat error words', () => {
  it.each([
    {
      name: 'literal caught argument',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { return "".concat(error as never); } }',
      framed: true,
    },
    {
      name: 'bracket caught argument',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { return ""["concat"](error as never); } }',
      framed: true,
    },
    {
      name: 'constant text alias',
      source:
        'function frames() { const prefix = "problem: "; try { JSON.parse("bad"); } catch(error) { return prefix.concat(error as never); } }',
      framed: true,
    },
    {
      name: 'explicit string receiver',
      source:
        'function frames(prefix: string, error: Error) { return prefix.concat(error as never); }',
      framed: true,
    },
    {
      name: 'native String receiver',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { return String("").concat(error as never); } }',
      framed: true,
    },
    {
      name: 'template receiver',
      source: `function frames(label: string, error: Error) { return \`\${label}: \`.concat(error as never); }`,
      framed: true,
    },
    {
      name: 'constant method key',
      source:
        'function frames(error: Error) { const key = "concat"; return ""[key](error as never); }',
      framed: true,
    },
    {
      name: 'constant receiver alias chain',
      source:
        'const first = ""; const second = first; function frames(error: Error) { return second.concat(error as never); }',
      framed: true,
    },
    {
      name: 'array concat keeps error value',
      source: 'function frames(error: Error) { return ([] as unknown[]).concat(error).length; }',
      framed: false,
    },
    {
      name: 'own concat method',
      source:
        'function frames(error: Error) { const own = {concat(value: unknown) { return value === undefined ? "empty" : "data"; }}; return own.concat(error); }',
      framed: false,
    },
    {
      name: 'typed own concat method',
      source:
        'function frames(own: {concat(value: unknown): string}, error: Error) { return own.concat(error); }',
      framed: false,
    },
    {
      name: 'ordinary text argument',
      source: 'function frames() { return "first".concat("second"); }',
      framed: false,
    },
    {
      name: 'locally written error words',
      source: 'function frames() { return "".concat(new Error("ours") as never); }',
      framed: false,
    },
    {
      name: 'shadowed String custom result',
      source:
        'function frames(error: Error) { const String = () => ({concat(value: unknown) { return value === undefined ? "empty" : "data"; }}); return String().concat(error); }',
      framed: false,
    },
    {
      name: 'cyclic receiver aliases terminate',
      source:
        'const first = second; const second = first; function frames(error: Error) { return first.concat(error); }',
      framed: false,
    },
  ])('$name', ({ source, framed }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'error-string-concat.ts', source);

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

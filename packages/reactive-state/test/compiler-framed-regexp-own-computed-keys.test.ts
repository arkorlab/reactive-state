import { isCallExpression, isReturnStatement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedOwnRegExpMethod } from '../src/compiler/framed-regexp-methods.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A preceding own callable on an unexposed local pattern replaces the called method only when both
 * accesses resolve to the same constant member name; two unread computed keys do not match.
 */
const CASES = [
  {
    id: 'distinct-unresolved-parameter-keys',
    body: 'const pattern = /fixed/; pattern[writeKey] = () => false; return pattern[readKey](input);',
    own: false,
  },
  {
    id: 'let-key-and-parameter-key',
    body: "let localKey = 'test'; const pattern = new RegExp('fixed'); pattern[localKey] = () => false; return pattern[readKey](input);",
    own: false,
  },
  {
    id: 'same-unresolved-parameter-key',
    body: 'const pattern = /fixed/; pattern[readKey] = () => false; return pattern[readKey](input);',
    own: false,
  },
  {
    id: 'computed-call-expression-keys',
    body: 'const pattern = /fixed/; pattern[pick()] = () => false; return pattern[pick()](input);',
    own: false,
  },
  {
    id: 'folded-const-computed-key',
    body: "const method = 'exec'; const pattern = /fixed/; pattern[method] = () => null; return pattern[method](input);",
    own: true,
  },
  {
    id: 'bracket-string-literal-and-dot-call',
    body: "const pattern = /fixed/; pattern['test'] = () => false; return pattern.test(input);",
    own: true,
  },
  {
    id: 'dot-write-and-folded-const-call',
    body: "const method = 'test'; const pattern = new RegExp('fixed'); pattern.test = () => false; return pattern[method](input);",
    own: true,
  },
  {
    id: 'unresolved-write-and-dot-call',
    body: 'const pattern = /fixed/; pattern[writeKey] = () => false; return pattern.exec(input);',
    own: false,
  },
  {
    id: 'distinct-known-method-names',
    body: 'const pattern = /fixed/; pattern.test = () => false; return pattern.exec(input);',
    own: false,
  },
] as const;

describe('own pattern method proofs with computed keys', () => {
  it.each(CASES)('$id', ({ body, own }) => {
    expect(provesOwnMethod(body)).toBe(own);
  });
});

function provesOwnMethod(body: string): boolean {
  using api = openTypeScript();
  const source = [
    'declare function pick(): "exec" | "test";',
    'function frames(input: string, writeKey: "exec" | "test", readKey: "exec" | "test") {',
    body,
    '}',
  ].join('\n');
  using parsed = parseModule(api, 'regexp-own-computed-keys.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isReturnStatement(node) && node.expression !== undefined) {
      const returned = unwrapped(node.expression);
      if (isCallExpression(returned)) return framedOwnRegExpMethod(returned);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('missing return call');
}

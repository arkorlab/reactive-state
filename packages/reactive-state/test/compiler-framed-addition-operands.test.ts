import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A `+` operand and a template span check the elements of an array they can follow: a literal, its
 * constant aliases, a written array type, what is written into it, what a name is given where it is
 * assigned. A name they cannot follow, a parameter assigned as a whole (`count += 1`), a name a swap,
 * `[a, b] = [b, a]`, or a loop, `for (last of words)`, writes, an array written through one of its
 * elements, is read as the program shows it: an operand is far oftener text or a number than a list.
 * `String(name)` keeps reading every array, and refuses such a name as it did.
 */

const CASES = [
  {
    framed: false,
    id: 'swapped-names-added',
    source:
      "export function p(): string { let a = 'x'; let b = 'y'; [a, b] = [b, a]; return a + b; }",
  },
  {
    framed: false,
    id: 'swapped-names-in-template',
    source: `export function p(): string { let a = 'x'; let b = 'y'; [a, b] = [b, a]; return \`\${a}\${b}\`; }`,
  },
  {
    framed: false,
    id: 'assigned-loop-name-added',
    source:
      "export function p(): string { const words = ['a', 'b']; let last = ''; for (last of words) { break; } return 'w:' + last; }",
  },
  {
    framed: false,
    id: 'text-parameter-added-to',
    source: "export function p(text: string): string { text += 'a'; return text; }",
  },
  {
    framed: false,
    id: 'number-parameter-added-to',
    source: 'export function p(count: number): number { count += 1; return count; }',
  },
  {
    framed: false,
    id: 'copy-of-text-parameter-added-to',
    source: "export function p(text: string): string { let out = text; out += 'a'; return out; }",
  },
  {
    framed: false,
    id: 'array-written-through-an-element-member',
    source: `export function p(): string { const dates = [new Date(0)]; dates[0]!.toString = () => 'fixed'; return \`\${dates}\`; }`,
  },
  {
    framed: true,
    id: 'swapped-name-string-refused-before',
    source:
      "export function p(): string { let a = 'x'; let b = 'y'; [a, b] = [b, a]; return String(a); }",
  },
  {
    framed: true,
    id: 'assigned-text-parameter-string-refused-before',
    source: "export function p(text: string): string { text += 'a'; return String(text); }",
  },
  {
    framed: true,
    id: 'alias-of-error-array-added',
    source:
      "export function p(error: Error): string { const values = [error]; return '' + values; }",
  },
  {
    framed: true,
    id: 'alias-of-error-array-in-template',
    source: `export function p(error: Error): string { const values = [error]; return \`\${values}\`; }`,
  },
  {
    framed: true,
    id: 'array-given-an-error-where-assigned',
    source:
      "export function p(error: Error): string { let list = [1]; list = [error]; return '' + list; }",
  },
  {
    framed: true,
    id: 'unknown-name-given-an-error-array',
    source:
      "export function p(error: Error): string { let value: unknown = 'x'; value = [error]; return '' + value; }",
  },
  {
    framed: true,
    id: 'error-pushed-into-array',
    source:
      "export function p(error: Error): string { const list = [1]; list.push(error as never); return '' + list; }",
  },
  {
    framed: true,
    id: 'error-assigned-to-element',
    source:
      "export function p(error: Error): string { const list = [1] as unknown[]; list[0] = error; return '' + list; }",
  },
  {
    framed: true,
    id: 'typed-error-array-copied-then-added',
    source:
      "export function p(errors: Error[]): string { const copy = [...errors]; return '' + copy; }",
  },
] as const;

describe('implicit text conversions of names and arrays the compile can and cannot follow', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'addition-operands.ts', source);

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

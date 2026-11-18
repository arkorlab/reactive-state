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

/**
 * A name that is given a value where it is assigned, other than one the compile reads to a literal
 * or a scalar, may hold an array by then: a call result, a copy of an array of errors, is refused.
 */
const ASSIGNED_ARRAY_ROUTES = [
  {
    id: 'slice-given-after-a-literal',
    start: 'let list = [1];',
    assign: 'list = errors.slice() as never;',
  },
  {
    id: 'slice-given-to-a-typed-name',
    start: 'let list: unknown[] = [1];',
    assign: 'list = errors.slice();',
  },
  { id: 'slice-given-to-an-evolving-name', start: 'let list;', assign: 'list = errors.slice();' },
  {
    id: 'concat-given-to-a-typed-name',
    start: 'let list: unknown[] = [];',
    assign: 'list = list.concat(errors);',
  },
  {
    id: 'array-from-given-to-a-typed-name',
    start: 'let list: unknown[] = [];',
    assign: 'list = Array.from(errors);',
  },
  {
    id: 'spread-given-after-a-literal',
    start: 'let list = [1];',
    assign: 'list = [...errors] as never;',
  },
] as const;

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
  ...ASSIGNED_ARRAY_ROUTES.flatMap(({ assign, id, start }) => {
    return [
      {
        framed: true,
        id: `${id}-added`,
        source: `export function p(errors: Error[]): string { ${start} ${assign} return '' + list; }`,
      },
      {
        framed: true,
        id: `${id}-in-template`,
        source: `export function p(errors: Error[]): string { ${start} ${assign} return \`\${list}\`; }`,
      },
    ];
  }),
  {
    framed: false,
    id: 'name-given-a-number',
    source: "export function p(): string { let n = 1; n = 2; return '' + n; }",
  },
  {
    framed: false,
    id: 'name-given-its-own-text-and-more',
    source: "export function p(text: string): string { text = text + 'a'; return text; }",
  },
  {
    framed: false,
    id: 'name-given-a-scalar-choice',
    source:
      "export function p(flag: boolean): string { let n = 1; n = flag ? 2 : 3; return '' + n; }",
  },
  {
    framed: false,
    id: 'text-name-given-a-call-result',
    source:
      "export function p(value: unknown): string { let text = ''; text = JSON.stringify(value); return text + '!'; }",
  },
  {
    framed: false,
    id: 'text-name-given-a-joined-array-in-template',
    source: `export function p(names: string[]): string { let label = ''; label = names.join(', '); return \`\${label}!\`; }`,
  },
  {
    framed: false,
    id: 'text-parameter-given-a-call-result',
    source: "export function p(text: string): string { text = text.trim(); return text + '!'; }",
  },
  {
    framed: false,
    id: 'number-name-given-a-call-result',
    source:
      "export function p(values: string[]): string { let count = 0; count = values.length; return '' + count; }",
  },
  {
    framed: true,
    id: 'unknown-typed-name-given-an-error-array-copy',
    source:
      "export function p(errors: Error[]): string { let value: unknown = 'x'; value = errors.slice(); return '' + value; }",
  },
  {
    framed: true,
    id: 'error-pushed-after-a-whole-reassignment-in-template',
    source: `export function p(error: Error): string { let list: unknown[] = []; list = []; list.push(error); return \`\${list}\`; }`,
  },
  {
    framed: true,
    id: 'error-pushed-after-a-whole-reassignment-added',
    source:
      "export function p(error: Error): string { let list: unknown[] = []; list = []; list.push(error); return '' + list; }",
  },
  {
    framed: true,
    id: 'error-assigned-to-an-element-after-a-whole-reassignment',
    source:
      "export function p(error: Error): string { let list: unknown[] = [1]; list = [2]; list[0] = error; return '' + list; }",
  },
  {
    framed: true,
    id: 'empty-object-name-given-an-error-array',
    source: `export function p(error: Error): string { let value = {}; value = [error]; return \`\${value}\`; }`,
  },
  {
    framed: true,
    id: 'null-name-given-an-error-array',
    source:
      "export function p(error: Error): string { let value = null; value = [error]; return '' + value; }",
  },
  {
    framed: true,
    id: 'function-name-given-an-error-array',
    source:
      "export function p(error: Error): string { let value: unknown = () => 1; value = [error]; return '' + value; }",
  },
  {
    framed: true,
    id: 'error-pushed-into-a-list-initialized-by-assignment',
    source:
      "export function p(error: Error): string { let list: unknown[]; list = []; list.push(error); return '' + list; }",
  },
  {
    framed: true,
    id: 'name-given-an-error-array-by-a-loop-head',
    source:
      "export function p(lists: Error[][]): string { let list; for (list of lists) { break; } return '' + list; }",
  },
  {
    framed: true,
    id: 'name-given-an-error-array-by-a-pattern',
    source:
      "export function p(error: Error): string { let list; [list] = [[error]]; return '' + list; }",
  },
  {
    framed: true,
    id: 'name-started-as-an-any-addition-given-an-error-array',
    source:
      "export function p(error: Error): string { let value = JSON.parse('0') + 1; value = [error]; return '' + value; }",
  },
  {
    framed: false,
    id: 'name-started-as-an-addition-of-scalars',
    source:
      "export function p(): string { let total = 1 + 2; total = total + 3; return '' + total; }",
  },
  {
    framed: false,
    id: 'text-name-annotated-by-a-local-alias-given-a-call-result',
    source:
      "type Label = string; export function p(): string { let label: Label = 'abc'; label = label.slice(1); return 'prefix:' + label; }",
  },
  {
    framed: false,
    id: 'name-annotated-by-literal-types-given-a-call-result',
    source:
      "export function p(pick: () => 'a' | 'b'): string { let mode: 'a' | 'b' = 'a'; mode = pick(); return '' + mode; }",
  },
  {
    framed: false,
    id: 'name-annotated-by-a-scalar-or-undefined-given-a-call-result',
    source:
      "type Count = number | undefined; export function p(items: string[]): string { let count: Count = 0; count = items.length; return '' + count; }",
  },
  {
    framed: true,
    id: 'name-annotated-by-an-alias-of-unknown-given-an-error-array',
    source:
      "type Mixed = unknown; export function p(error: Error): string { let value: Mixed = 'x'; value = [error]; return '' + value; }",
  },
  {
    framed: true,
    id: 'name-annotated-by-a-generic-alias-given-an-error-array',
    source:
      "type Same<T> = T; export function p(error: Error): string { let value: Same<unknown> = 'x'; value = [error]; return '' + value; }",
  },
  {
    framed: true,
    id: 'name-annotated-by-a-union-with-an-array-given-an-error-array',
    source:
      "export function p(error: Error): string { let value: string | unknown[] = 'x'; value = [error]; return '' + value; }",
  },
  {
    framed: true,
    id: 'typed-error-list-given-to-a-helper-that-pushes',
    source:
      "function add(out: Error[], error: Error): void { out.push(error); } export function p(error: Error): string { const list: Error[] = []; add(list, error); return '' + list; }",
  },
  {
    framed: true,
    id: 'error-pushed-into-a-list-a-native-mutator-writes',
    source:
      "export function p(error: Error): string { const list: unknown[] = []; Object.assign(list, { label: 'items' }); list.push(error); return '' + list; }",
  },
  {
    framed: true,
    id: 'error-array-written-to-a-member-then-destructured',
    source:
      "export function p(error: Error): string { const box: { value: unknown } = { value: 'pending' }; box.value = [error]; const { value } = box; return '' + value; }",
  },
  {
    framed: true,
    id: 'cast-text-name-given-an-error-array',
    source:
      "export function p(error: Error): string { let value = 'x' as unknown; value = [error]; return '' + value; }",
  },
  {
    framed: true,
    id: 'array-of-text-pushed-after-a-whole-reassignment',
    source:
      "export function p(): string { let list: unknown[] = []; list = []; list.push('a'); return '' + list; }",
  },
  {
    framed: true,
    id: 'name-given-an-array-of-text',
    source: "export function p(): string { let list = ['a']; list = ['b']; return '' + list; }",
  },
  {
    framed: true,
    id: 'name-given-an-alias-of-an-array-of-text',
    source:
      "export function p(): string { const base = ['a']; let list = ['b']; list = base; return '' + list; }",
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

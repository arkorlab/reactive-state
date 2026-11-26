import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * `String(name)` reads the elements of an array, an error among them by its message, so a name
 * written again as a whole is refused where it may hold a list. A name the code writes as a text, a
 * number, a boolean or a bigint holds none, whatever it is given afterwards: a counter that is added
 * to and a text that is trimmed are converted as the scalars they are. Every name whose written type
 * says less (an array, an object, `unknown`, `any`, a type parameter, an alias that is not followed)
 * stays refused.
 */
interface Row {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly reader: boolean;
}

const scalars: readonly Row[] = [
  {
    id: 'number-parameter-added-to',
    source: 'function frames(count: number) { count += 1; return String(count); }',
    invocation: 'frames(value.length)',
    reader: false,
  },
  {
    id: 'string-parameter-trimmed',
    source: 'function frames(text: string) { text = text.trim(); return String(text); }',
    invocation: 'frames(value)',
    reader: false,
  },
  {
    id: 'unannotated-let-of-a-string-name',
    source:
      "function frames(name: string) { let text = name; text = 'fixed'; return String(text); }",
    invocation: 'frames(value)',
    reader: false,
  },
  {
    id: 'annotated-let-given-a-call',
    source:
      'function frames(name: string) { let text: string = name; text = name.trim(); return String(text); }',
    invocation: 'frames(value)',
    reader: false,
  },
  {
    id: 'let-of-a-literal-given-a-call',
    source:
      "function frames(name: string) { let text = ''; text = name.trim(); return String(text); }",
    invocation: 'frames(value)',
    reader: false,
  },
  {
    id: 'literal-union-parameter-toggled',
    source:
      "function frames(order: 'asc' | 'desc') { order = order === 'asc' ? 'desc' : 'asc'; return String(order); }",
    invocation: "frames(value === 'done' ? 'asc' : 'desc')",
    reader: false,
  },
  {
    id: 'optional-number-given-a-default',
    source: 'function frames(count: number | undefined) { count ??= 0; return String(count); }',
    invocation: 'frames(value.length)',
    reader: false,
  },
  {
    id: 'local-alias-of-a-string',
    source:
      'type Label = string; function frames(label: Label) { label = label.trim(); return String(label); }',
    invocation: 'frames(value)',
    reader: false,
  },
  {
    id: 'boolean-parameter-negated',
    source: 'function frames(done: boolean) { done = !done; return String(done); }',
    invocation: "frames(value === 'done')",
    reader: false,
  },
  {
    id: 'bigint-parameter-multiplied',
    source: 'function frames(total: bigint) { total *= 2n; return String(total); }',
    invocation: 'frames(BigInt(value.length))',
    reader: false,
  },
  {
    id: 'string-parameter-a-var-writes-again',
    source: "function frames(text: string) { var text = 'fixed'; return String(text); }",
    invocation: 'frames(value)',
    reader: false,
  },
  {
    id: 'number-parameter-own-to-string',
    source: 'function frames(count: number) { count += 1; return count.toString(); }',
    invocation: 'frames(value.length)',
    reader: false,
  },
  {
    id: 'string-name-swapped-with-a-string',
    source:
      'function frames(first: string, second: string) { [first, second] = [second, first]; return String(first); }',
    invocation: "frames(value, 'fixed')",
    reader: false,
  },
];

const lists: readonly Row[] = [
  {
    id: 'array-parameter-sliced',
    source:
      'function frames(error: Error, values: unknown[]) { values = [error, ...values]; return String(values); }',
    invocation: 'frames(new Error("ours"), [value])',
    reader: true,
  },
  {
    id: 'unknown-parameter-given-an-error-list',
    source: 'function frames(error: Error, text: unknown) { text = [error]; return String(text); }',
    invocation: 'frames(new Error("ours"), value)',
    reader: true,
  },
  {
    id: 'unknown-parameter-given-a-text',
    source: "function frames(text: unknown) { text = 'fixed'; return String(text); }",
    invocation: 'frames(value)',
    reader: true,
  },
  {
    id: 'any-parameter-given-a-text',
    source: "function frames(text: any) { text = 'fixed'; return String(text); }",
    invocation: 'frames(value)',
    reader: true,
  },
  {
    id: 'type-parameter-given-itself',
    source: 'function frames<T>(text: T, other: T) { text = other; return String(text); }',
    invocation: "frames(value, 'fixed')",
    reader: true,
  },
  {
    id: 'scalar-type-parameter-given-itself',
    source:
      'function frames<T extends string>(text: T, other: T) { text = other; return String(text); }',
    invocation: "frames(value, 'fixed')",
    reader: true,
  },
  {
    id: 'string-or-list-parameter',
    source:
      'function frames(text: string | readonly unknown[]) { text = text.slice(1); return String(text); }',
    invocation: 'frames(value)',
    reader: true,
  },
  {
    id: 'string-or-error-parameter',
    source:
      'function frames(text: string | Error, other: string | Error) { text = other; return String(text); }',
    invocation: "frames(value, 'fixed')",
    reader: true,
  },
  {
    id: 'interface-typed-parameter',
    source:
      'interface Label { readonly length: number } function frames(text: Label, other: Label) { text = other; return String(text); }',
    invocation: 'frames(value, [value])',
    reader: true,
  },
  {
    id: 'generic-alias-of-a-string',
    source:
      'type Boxed<T> = T; function frames(text: Boxed<string>, other: Boxed<string>) { text = other; return String(text); }',
    invocation: "frames(value, 'fixed')",
    reader: true,
  },
  {
    id: 'alias-of-a-list',
    source:
      'type Labels = readonly string[]; function frames(text: Labels, other: Labels) { text = other; return String(text); }',
    invocation: 'frames([value], [value])',
    reader: true,
  },
  {
    id: 'unannotated-let-of-an-unknown-name',
    source:
      "function frames(input: unknown) { let text = input; text = 'fixed'; return String(text); }",
    invocation: 'frames(value)',
    reader: true,
  },
  {
    id: 'unannotated-let-of-a-call',
    source:
      "function frames(name: string) { let text = name.split(','); text = []; return String(text); }",
    invocation: 'frames(value)',
    reader: true,
  },
  {
    id: 'string-name-then-an-error-list',
    source:
      'function frames(error: Error, name: string) { let text: unknown = name; text = [error]; return String(text); }',
    invocation: 'frames(new Error("ours"), value)',
    reader: true,
  },
  {
    id: 'string-parameter-given-a-cast-list',
    source:
      'function frames(error: Error, text: string) { text = [error] as never; return String(text); }',
    invocation: 'frames(new Error("ours"), value)',
    reader: true,
  },
  {
    id: 'string-let-given-a-cast-list-name',
    source:
      "function frames(error: Error) { const list = [error]; let text = 'safe'; text = list as never; return String(text); }",
    invocation: 'frames(new Error("ours"))',
    reader: true,
  },
  {
    id: 'part-of-a-string-typed-pattern',
    source:
      'function frames(name: string) { const { length }: string = name; let text = length; text = 0; return String(text); }',
    invocation: 'frames(value)',
    reader: true,
  },
  {
    id: 'rest-parameter-whatever-it-says',
    source:
      'function frames(error: Error, ...texts: string) { texts = texts; return String(texts); }',
    invocation: 'frames(new Error("ours"), value)',
    reader: true,
  },
];

const taken: readonly Row[] = [
  {
    id: 'defaulted-parameter-added-to',
    source: 'function frames(count = 0) { count += 1; return String(count); }',
    invocation: 'frames(value.length)',
    reader: false,
  },
  {
    id: 'number-parameter-not-written-again',
    source: 'function frames(count: number) { return String(count); }',
    invocation: 'frames(value.length)',
    reader: false,
  },
  {
    id: 'number-parameter-in-a-template',
    source: `function frames(count: number) { count += 1; return \`\${count}\`; }`,
    invocation: 'frames(value.length)',
    reader: false,
  },
  {
    id: 'number-parameter-in-an-addition',
    source: "function frames(count: number) { count += 1; return '' + count; }",
    invocation: 'frames(value.length)',
    reader: false,
  },
  {
    id: 'let-of-a-literal-given-a-literal',
    source: "function frames() { let text = 'first'; text = 'second'; return String(text); }",
    invocation: 'frames()',
    reader: false,
  },
];

describe('text of a rewritten name', () => {
  const { apps, compile } = compilerApplications();

  it.each([...scalars, ...lists, ...taken])('$id reader', (row) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'rewritten-scalars.ts', row.source);

    expect(readsFrames(parsed.sourceFile)).toBe(row.reader);
  });

  it.each([...scalars, ...lists, ...taken])('$id actual shared', async (row) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        row.source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${row.invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = row.reader ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});

function readsFrames(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

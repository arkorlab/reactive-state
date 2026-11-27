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
  {
    id: 'string-names-swapped-under-a-tuple-assertion',
    source:
      'function frames(first: string, second: string) { [first, second] = [second, first] as [string, string]; return String(first); }',
    invocation: "frames(value, 'fixed')",
    reader: false,
  },
  {
    id: 'number-parameter-asserted-and-added-to',
    source: 'function frames(count: number) { (count as number) += 1; return String(count); }',
    invocation: 'frames(value.length)',
    reader: false,
  },
  {
    id: 'string-or-null-given-a-default',
    source: "function frames(text: string | null) { text ??= 'fixed'; return String(text); }",
    invocation: 'frames(value)',
    reader: false,
  },
  {
    id: 'number-or-null-or-undefined-defaulted',
    source:
      'function frames(count: number | null | undefined) { count ??= 0; return String(count); }',
    invocation: 'frames(value.length)',
    reader: false,
  },
  {
    id: 'alias-of-names-given-scalars',
    source:
      "function frames(name: string) { let first = ''; let second = ''; second = name.trim(); let text = first; text = second; return String(text); }",
    invocation: 'frames(value)',
    reader: false,
  },
  {
    id: 'three-names-given-scalars',
    source:
      "function frames(name: string) { let first = ''; first = name.trim(); let second = ''; second = first; let text = ''; text = second; return String(text); }",
    invocation: 'frames(value)',
    reader: false,
  },
  {
    id: 'choice-of-scalars-given',
    source:
      "function frames(name: string, flag: boolean) { let text = ''; text = flag ? name.trim() : 'fixed'; return String(text); }",
    invocation: "frames(value, value === 'done')",
    reader: false,
  },
  {
    id: 'call-on-an-asserted-name-given',
    source:
      "function frames(input: unknown) { let text = ''; text = (input as string).trim(); return String(text); }",
    invocation: 'frames(value)',
    reader: false,
  },
  {
    id: 'element-given-under-a-non-null-mark',
    source:
      "function frames(name: string) { let text = ''; text = name.split(',')[0]!; return String(text); }",
    invocation: 'frames(value)',
    reader: false,
  },
  {
    id: 'asserted-assignment-of-a-literal-given',
    source:
      "function frames(name: string) { let cached = name; let text = ''; text = (cached = 'fixed') as string; return String(text) + cached; }",
    invocation: 'frames(value)',
    reader: false,
  },
  {
    id: 'checked-name-given',
    source:
      "function frames(name: string) { let text = ''; text = name satisfies string; return String(text); }",
    invocation: 'frames(value)',
    reader: false,
  },
];

const lists: readonly Row[] = [
  {
    id: 'asserted-assignment-of-a-list-given',
    source:
      'function frames(error: Error, text: string) { let cached: unknown; text = (cached = [error]) as never; return String(text); }',
    invocation: 'frames(new Error("ours"), value)',
    reader: true,
  },
  {
    id: 'asserted-sequence-ending-at-an-assignment',
    source:
      'function frames(error: Error, text: string) { let cached: unknown; text = (0, (cached = [error])) as never; return String(text); }',
    invocation: 'frames(new Error("ours"), value)',
    reader: true,
  },
  {
    id: 'asserted-assignment-in-a-choice',
    source:
      "function frames(error: Error, text: string, flag: boolean) { let cached: unknown; text = flag ? ((cached = [error]) as never) : 'fixed'; return String(text); }",
    invocation: 'frames(new Error("ours"), value, value === \'done\')',
    reader: true,
  },
  {
    id: 'asserted-logical-assignment-of-a-list',
    source:
      'function frames(error: Error, text: string) { let cached: unknown; text = (cached ??= [error]) as never; return String(text); }',
    invocation: 'frames(new Error("ours"), value)',
    reader: true,
  },
  {
    id: 'asserted-call-result-given',
    source:
      'function listed(error: Error) { return [error]; } function frames(error: Error, text: string) { text = listed(error) as never; return String(text); }',
    invocation: 'frames(new Error("ours"), value)',
    reader: true,
  },
  {
    id: 'asserted-member-given',
    source:
      'function frames(bag: { errors: Error[] }, text: string) { text = bag.errors as never; return String(text); }',
    invocation: 'frames({ errors: [new Error("ours")] }, value)',
    reader: true,
  },
  {
    id: 'angle-asserted-list-given',
    source:
      'function frames(error: Error, text: string) { text = <never>[error]; return String(text); }',
    invocation: 'frames(new Error("ours"), value)',
    reader: true,
  },
  {
    id: 'part-of-an-asserted-pattern-source',
    source:
      'function frames(error: Error, text: string) { const pair = [[error]]; [text] = pair as never; return String(text); }',
    invocation: 'frames(new Error("ours"), value)',
    reader: true,
  },
  {
    id: 'asserted-target-given-a-member',
    source:
      "function frames(bag: { errors: Error[] }) { let text = ''; (text as unknown) = bag.errors; return String(text); }",
    invocation: 'frames({ errors: [new Error("ours")] })',
    reader: true,
  },
  {
    id: 'asserted-target-of-a-logical-assignment',
    source:
      "function frames(bag: { errors: Error[] }) { let text = ''; (text as unknown) ??= bag.errors; return String(text); }",
    invocation: 'frames({ errors: [new Error("ours")] })',
    reader: true,
  },
  {
    id: 'asserted-target-in-a-pattern-given-a-member',
    source:
      "function frames(bag: { errors: Error[] }) { let text = ''; [(text as unknown)] = [bag.errors]; return String(text); }",
    invocation: 'frames({ errors: [new Error("ours")] })',
    reader: true,
  },
  {
    id: 'part-of-an-asserted-list-source',
    source:
      "function frames(bag: { errors: Error[] }) { let text = ''; [text] = [bag.errors] as unknown as [string]; return String(text); }",
    invocation: 'frames({ errors: [new Error("ours")] })',
    reader: true,
  },
  {
    id: 'part-an-object-pattern-gives',
    source:
      "function frames() { let pick = 'first'; ({ pick } = { pick: 'second' }); return String(pick); }",
    invocation: 'frames()',
    reader: true,
  },
  {
    id: 'part-a-loop-head-gives',
    source:
      "function frames(name: string) { let last = ''; for (last of name.split(',')) { if (last === '') break; } return String(last); }",
    invocation: 'frames(value)',
    reader: true,
  },
  {
    id: 'asserted-parsed-text-given',
    source:
      "function frames(raw: string) { let text = ''; text = JSON.parse(raw) as string; return String(text); }",
    invocation: 'frames(value)',
    reader: true,
  },
  {
    id: 'alias-of-a-name-given-a-cast-list',
    source:
      "function frames(error: Error) { let first = ''; let second = ''; second = [error] as never; let text = first; text = second; return String(text); }",
    invocation: 'frames(new Error("ours"))',
    reader: true,
  },
  {
    id: 'alias-starting-as-a-cast-list-name',
    source:
      "function frames(error: Error) { let first = ''; first = [error] as never; let second = ''; let text = first; text = second; return String(text); }",
    invocation: 'frames(new Error("ours"))',
    reader: true,
  },
  {
    id: 'three-names-to-a-cast-list',
    source:
      "function frames(error: Error) { let first = ''; first = [error] as never; let second = ''; second = first; let third = ''; let text = third; text = second; return String(text); }",
    invocation: 'frames(new Error("ours"))',
    reader: true,
  },
  {
    id: 'pattern-part-of-a-cast-list-name',
    source:
      "function frames(error: Error) { let second = ''; second = [error] as never; const [part] = [second]; let text = ''; text = part; return String(text); }",
    invocation: 'frames(new Error("ours"))',
    reader: true,
  },
  {
    id: 'cast-list-in-a-choice',
    source:
      "function frames(error: Error, flag: boolean) { let text: string = 'safe'; text = flag ? ([error] as never) : 'fixed'; return String(text); }",
    invocation: 'frames(new Error("ours"), value === \'done\')',
    reader: true,
  },
  {
    id: 'cast-list-in-a-choice-of-an-alias',
    source:
      "function frames(error: Error, flag: boolean) { let second = ''; second = flag ? ([error] as never) : 'fixed'; let text = ''; text = second; return String(text); }",
    invocation: 'frames(new Error("ours"), value === \'done\')',
    reader: true,
  },
  {
    id: 'cast-list-beside-a-logical-or',
    source:
      "function frames(error: Error, name: string) { let text = ''; text = name || ([error] as never); return String(text); }",
    invocation: 'frames(new Error("ours"), value)',
    reader: true,
  },
  {
    id: 'cast-list-choice-a-typed-name-starts-as',
    source:
      "function frames(error: Error, flag: boolean) { let text: string = flag ? ([error] as never) : 'safe'; text = 'fixed'; return String(text); }",
    invocation: 'frames(new Error("ours"), value === \'done\')',
    reader: true,
  },
  {
    id: 'string-name-given-an-unknown-name',
    source:
      "function frames(input: unknown) { let text = ''; if (typeof input === 'string') text = input; return String(text); }",
    invocation: 'frames(value)',
    reader: true,
  },
  {
    id: 'string-or-null-or-error-list',
    source:
      "function frames(text: string | null | Error[]) { text ??= 'fixed'; return String(text); }",
    invocation: 'frames(value)',
    reader: true,
  },
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
    id: 'asserted-literal-and-sum-given',
    source:
      "function frames(count: number, flag: boolean) { let text = ''; text = flag ? ('fixed' as string) : (String(count + 1) + '!' as string); return String(text); }",
    invocation: "frames(value.length, value === 'done')",
    reader: false,
  },
  {
    id: 'asserted-target-given-a-literal',
    source: "function frames() { let text = ''; (text as string) = 'fixed'; return String(text); }",
    invocation: 'frames()',
    reader: false,
  },
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

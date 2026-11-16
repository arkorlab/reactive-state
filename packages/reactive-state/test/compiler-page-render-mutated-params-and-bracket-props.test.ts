import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pageRenderOf } from '../src/compiler/page-render.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A route parameter mapped onto the reactive root must still hold the route's original value when
 * the root renders: mutating a catch-all array parameter (or an alias of it) or handing it off to
 * an arbitrary callable invalidates that mapping, while read-only indexing, `.length`, `.join()`,
 * untagged templates and pure string coercions keep it intact. Likewise, a page taking its props as
 * one identifier resolves literal bracket and template keys on `props` (`props['searchParams']`,
 * `props['params']`) and refuses opaque or dynamic uses of `props` that could hide `searchParams`.
 */

const ROOT = './root.reactive';

interface RenderSummary {
  readonly blocking: boolean;
  readonly given: readonly string[];
  readonly props: Readonly<Record<string, string>>;
  readonly searched: boolean;
  readonly specifier: string;
}

interface Case {
  readonly expected: RenderSummary | undefined;
  readonly id: string;
  readonly lines: readonly string[];
}

const SLUG_BLOCKING: RenderSummary = {
  blocking: true,
  given: [],
  props: { slug: 'slug' },
  searched: false,
  specifier: ROOT,
};

const CASES: readonly Case[] = [
  {
    expected: undefined,
    id: 'param-array-pop-in-const',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const { slug } = await params;',
      '  const last = slug.pop();',
      '  return <main title={last}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'param-array-element-write',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const { slug } = await params;',
      "  const written = (slug[0] = 'x');",
      '  return <main title={written}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'param-array-destructuring-write',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const { slug } = await params;',
      "  const written = ([slug[0]] = ['x'])[0];",
      '  return <main title={written}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'param-array-object-assign',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const { slug } = await params;',
      "  const merged = Object.assign(slug, ['x']);",
      '  return <main data-len={merged.length}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'param-array-call-handoff',
    lines: [
      `import Root from '${ROOT}';`,
      'declare function mutate(parts: string[]): string;',
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const { slug } = await params;',
      '  const label = mutate(slug);',
      '  return <main title={label}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'param-array-jsx-sibling-mutation',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const { slug } = await params;',
      '  return <main title={slug.pop()}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'param-alias-mutated-before-root',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const { slug } = await params;',
      '  const alias = slug;',
      '  const first = alias.shift();',
      '  return <main title={first}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: {
      blocking: true,
      given: [],
      props: {},
      searched: true,
      specifier: ROOT,
    },
    id: 'whole-props-bracket-await-search-jsx',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page(props: { searchParams: Promise<{ q?: string }> }) {',
      "  return <main data-q={(await props['searchParams']).q}><Root /></main>;",
      '}',
    ],
  },
  {
    expected: {
      blocking: true,
      given: ['q'],
      props: {},
      searched: true,
      specifier: ROOT,
    },
    id: 'whole-props-template-key-await-search',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page(props: { searchParams: Promise<{ q?: string }> }) {',
      '  const { q } = await props[`searchParams`];',
      '  return <Root q={q} />;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'whole-props-bracket-await-params',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page(props: { params: Promise<{ slug: string[] }> }) {',
      "  const { slug } = await props['params'];",
      '  return <main><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'whole-props-dynamic-bracket-key',
    lines: [
      `import Root from '${ROOT}';`,
      "declare const key: 'params' | 'searchParams';",
      "export default async function Page(props: Record<'params' | 'searchParams', Promise<{ q?: string }>>) {",
      '  const q = (await props[key]).q;',
      '  return <main data-q={q}><Root /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'whole-props-call-handoff',
    lines: [
      `import Root from '${ROOT}';`,
      'declare function readQuery(props: { searchParams: Promise<{ q?: string }> }): Promise<string>;',
      'export default async function Page(props: { searchParams: Promise<{ q?: string }> }) {',
      '  const q = await readQuery(props);',
      '  return <main data-q={q}><Root /></main>;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'param-safe-index-length-and-join-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const { slug } = await params;',
      '  const first = slug[0];',
      '  const count = slug.length;',
      "  const joined = slug.join('/');",
      '  return <main data-first={first} data-count={count} data-joined={joined}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: {
      blocking: true,
      given: [],
      props: { id: 'id' },
      searched: false,
      specifier: ROOT,
    },
    id: 'param-safe-template-and-encode-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ id: string }> }) {',
      '  const { id } = await params;',
      `  const href = \`/p/\${encodeURIComponent(id)}\`;`,
      '  return <main data-href={href} title={id}><Root id={id} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'whole-props-destructured-computed-const-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page(props: { searchParams: Promise<{ q?: string }> }) {',
      "  const { ['searchParams']: sp } = props;",
      '  const q = (await sp).q;',
      '  return <main data-q={q}><Root /></main>;',
      '}',
    ],
  },
  {
    expected: {
      blocking: true,
      given: ['q'],
      props: { slug: 'slug' },
      searched: true,
      specifier: ROOT,
    },
    id: 'whole-props-dot-search-and-params-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page(props: {',
      '  params: Promise<{ slug: string[] }>;',
      '  searchParams: Promise<{ q?: string }>;',
      '}) {',
      '  const { slug } = await props.params;',
      '  const { q } = await props.searchParams;',
      '  return <Root slug={slug} q={q} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'param-mutated-in-earlier-arrow-closure',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const mutate = () => slug.pop();',
      '  const { slug } = await params;',
      '  const ignored = mutate();',
      '  return <main title={ignored}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'param-alias-mutated-in-earlier-nested-function',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const mutate = () => {',
      '    return run();',
      '    function run() {',
      '      return alias.shift();',
      '    }',
      '  };',
      '  const { slug } = await params;',
      '  const alias = slug;',
      '  const first = mutate();',
      '  return <main title={first}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'params-source-alias-mutated-in-earlier-closure',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const mutate = async () => (await routeParams).slug.pop();',
      '  const routeParams = params;',
      '  const { slug } = await routeParams;',
      '  const last = await mutate();',
      '  return <main title={last}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'param-mutated-via-search-default-arrow-param-default',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({',
      '  params,',
      '  searchParams,',
      '}: {',
      '  params: Promise<{ slug: string[] }>;',
      '  searchParams: Promise<{ fn?: (input: { items?: string[] }) => string | undefined }>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { fn = ({ items = slug }: { items?: string[] }) => items.pop() } = await searchParams;',
      '  const popped = fn({});',
      '  return <main title={popped}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'whole-props-unawaited-dynamic-awaited-in-earlier-closure',
    lines: [
      `import Root from '${ROOT}';`,
      "declare const key: 'params' | 'searchParams';",
      "export default async function Page(props: Record<'params' | 'searchParams', Promise<{ q?: string }>>) {",
      '  const sneak = async () => (await query).q;',
      '  const query = props[key];',
      '  const q = await sneak();',
      '  return <main data-q={q}><Root /></main>;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'parenthesized-await-params-destructure',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const { slug } = (await params);',
      '  return <Root slug={slug} />;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'type-asserted-and-satisfies-await-params-destructure',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const { slug } = ((await (params as Promise<{ slug: string[] }>)) satisfies {',
      '    slug: string[];',
      '  }) as { slug: string[] };',
      '  return <Root slug={slug} />;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'parenthesized-and-cast-params-source-alias',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const routeParams = (params) as Promise<{ slug: string[] }>;',
      '  const { slug } = (await (routeParams))!;',
      '  return <Root slug={slug} />;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'whole-props-cast-params-source-alias',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page(props: { params: Promise<{ slug: string[] }> }) {',
      "  const routeParams = (props['params']) as Promise<{ slug: string[] }>;",
      '  const { slug } = await routeParams;',
      '  return <Root slug={slug} />;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'earlier-closure-safe-read-and-shadowed-param-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      "  const format = () => slug.join('/');",
      '  const popLocal = (slug: string[]) => slug.pop();',
      '  const { slug } = await params;',
      '  const joined = format();',
      "  const local = popLocal(['a', 'b']);",
      '  return <main data-joined={joined} data-local={local}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'wrapped-await-params-extra-handoff-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'declare function inspect(value: { slug: string[] }): string;',
      'export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {',
      '  const { slug } = (await params);',
      '  const note = inspect((await params));',
      '  return <main title={note}><Root slug={slug} /></main>;',
      '}',
    ],
  },
];

describe('pageRenderOf when initializers mutate params or read whole props by brackets', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  function summaryOf(lines: readonly string[]): RenderSummary | undefined {
    using parsed = parseModule(api, 'page.tsx', `${lines.join('\n')}\n`);
    const found = pageRenderOf(parsed.sourceFile, (specifier) => specifier === ROOT);
    if (found === undefined) {
      return undefined;
    }
    const { blocking, given, props, searched, specifier } = found;
    return { blocking, given, props, searched, specifier };
  }

  it.each(CASES)('$id', ({ expected, lines }) => {
    expect(summaryOf(lines)).toStrictEqual(expected);
  });
});

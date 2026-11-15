import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pageRenderOf } from '../src/compiler/page-render.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Destructuring `await searchParams` binds search-derived values only when its computed property
 * keys and default initializers themselves read nothing beyond search params and constants: a
 * default or computed key that reads a route param, calls a module function or references an
 * uninitialized binding in the same pattern taints that binding so the root cannot accept it.
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

const CASES: readonly Case[] = [
  {
    expected: undefined,
    id: 'search-default-computed-from-param',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ q?: string }>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { q = slug.toUpperCase() } = await searchParams;',
      '  return <Root value={q} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'search-default-bare-param',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ q?: string }>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { q = slug } = await searchParams;',
      '  return <Root slug={slug} q={q} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'search-default-derived-then-transformed',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ q?: string }>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { q = slug } = await searchParams;',
      '  return <Root slug={slug} q={q.trim()} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'search-default-module-call',
    lines: [
      "import { fallbackQuery } from './query';",
      `import Root from '${ROOT}';`,
      'export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {',
      '  const { q = fallbackQuery() } = await searchParams;',
      '  return <Root q={q} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'search-computed-property-key-from-param',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<Record<string, string | undefined>>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { [slug]: q } = await searchParams;',
      '  return <Root slug={slug} q={q} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'search-rest-after-computed-param-key',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<Record<string, string | undefined>>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { [slug]: omitted, ...rest } = await searchParams;',
      '  return <main data-omitted={omitted}><Root slug={slug} q={rest.q} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'search-nested-object-default-from-param',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ filter?: { q?: string } }>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { filter: { q = slug } = {} } = await searchParams;',
      '  return <Root slug={slug} q={q} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'search-nested-array-default-from-param',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ tags?: string[] }>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { tags: [first = slug] = [] } = await searchParams;',
      '  return <Root slug={slug} tag={first} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'search-default-forward-tdz-over-module-constant',
    lines: [
      `import Root from '${ROOT}';`,
      "const q = 'safe';",
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ a?: string; q?: string }>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { a = q, q = slug } = await searchParams;',
      '  return <Root slug={slug} a={a} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'inner-helper-search-default-from-param',
    lines: [
      "import { Suspense } from 'react';",
      `import Root from '${ROOT}';`,
      'type Props = {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ q?: string }>;',
      '};',
      'async function Inner({ params, searchParams }: Props) {',
      '  const { slug } = await params;',
      '  const { q = slug.toUpperCase() } = await searchParams;',
      '  return <Root slug={slug} q={q} />;',
      '}',
      'export default function Page(props: Props) {',
      '  return <Suspense fallback={null}><Inner {...props} /></Suspense>;',
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
    id: 'search-default-string-literal-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ q?: string }>;',
      '}) {',
      '  const { slug } = await params;',
      "  const { q = 'all' } = await searchParams;",
      '  return <Root slug={slug} q={q} />;',
      '}',
    ],
  },
  {
    expected: {
      blocking: true,
      given: ['tab'],
      props: {},
      searched: true,
      specifier: ROOT,
    },
    id: 'search-default-module-literal-pin',
    lines: [
      `import Root from '${ROOT}';`,
      "const DEFAULT_TAB = 'overview';",
      'export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {',
      '  const { tab = DEFAULT_TAB } = await searchParams;',
      '  return <Root tab={tab} />;',
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
    id: 'search-default-earlier-search-binding-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ searchParams }: {',
      '  searchParams: Promise<{ raw?: string; q?: string }>;',
      '}) {',
      "  const { raw, q = raw?.trim() ?? 'all' } = await searchParams;",
      '  return <Root q={q} />;',
      '}',
    ],
  },
  {
    expected: {
      blocking: true,
      given: ['q', 'sort'],
      props: {},
      searched: true,
      specifier: ROOT,
    },
    id: 'search-computed-literal-key-and-rest-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ searchParams }: {',
      '  searchParams: Promise<Record<string, string | undefined>>;',
      '}) {',
      "  const { ['q']: q = 'all', ...rest } = await searchParams;",
      '  return <Root q={q} sort={rest.sort} />;',
      '}',
    ],
  },
  {
    expected: {
      blocking: true,
      given: [],
      props: { slug: 'slug' },
      searched: true,
      specifier: ROOT,
    },
    id: 'search-tainted-default-not-passed-to-root-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ q?: string }>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { q = slug.toUpperCase() } = await searchParams;',
      '  return <main data-q={q}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'params-destructuring-default-refused-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug?: string }> }) {',
      "  const { slug = 'home' } = await params;",
      '  return <Root slug={slug} />;',
      '}',
    ],
  },
];

describe('pageRenderOf when search-param bindings declare defaults or computed keys', () => {
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

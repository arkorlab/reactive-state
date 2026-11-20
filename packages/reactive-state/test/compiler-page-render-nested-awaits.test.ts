import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pageRenderOf } from '../src/compiler/page-render.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Any `await` a page or an unsuspended helper function runs before returning its JSX — including one
 * nested inside a property read, a JSX attribute, a conditional spread or a computed member name —
 * blocks outside `<Suspense>`, while an `await` inside a `<Suspense>` child helper or inside a
 * function value that runs only when called does not.
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
    expected: {
      blocking: true,
      given: ['q'],
      props: {},
      searched: true,
      specifier: ROOT,
    },
    id: 'const-property-access-await-search',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {',
      '  const q = (await searchParams).q;',
      '  return <Root q={q} />;',
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
    id: 'jsx-prop-inline-await-search',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {',
      '  return <Root q={(await searchParams).q} />;',
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
    id: 'jsx-conditional-spread-await-search',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {',
      "  return <Root {...((await searchParams).q ? { q: 'yes' } : {})} />;",
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
    id: 'jsx-wrapper-attribute-await-search',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {',
      '  return <main data-q={(await searchParams).q}><Root /></main>;',
      '}',
    ],
  },
  {
    expected: {
      blocking: true,
      given: [],
      props: {},
      searched: false,
      specifier: ROOT,
    },
    id: 'jsx-wrapper-nested-await-params',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  return <main data-slug={(await params).slug}><Root /></main>;',
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
    id: 'whole-props-nested-await-search',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page(props: { searchParams: Promise<{ q?: string }> }) {',
      '  const q = (await props.searchParams).q;',
      '  return <main data-q={q}><Root /></main>;',
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
    id: 'suspense-fallback-await-search',
    lines: [
      "import { Suspense } from 'react';",
      `import Root from '${ROOT}';`,
      'async function Inner({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Root slug={slug} />;',
      '}',
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ q?: string }>;',
      '}) {',
      '  return <Suspense fallback={<p>{(await searchParams).q}</p>}><Inner params={params} /></Suspense>;',
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
    id: 'unsuspended-inner-nested-await-search',
    lines: [
      `import Root from '${ROOT}';`,
      'async function Inner({ searchParams }: { searchParams: Promise<{ q?: string }> }) {',
      '  const q = (await searchParams).q;',
      '  return <Root q={q} />;',
      '}',
      'export default function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {',
      '  return <Inner searchParams={searchParams} />;',
      '}',
    ],
  },
  {
    expected: {
      blocking: true,
      given: [],
      props: {},
      searched: false,
      specifier: ROOT,
    },
    id: 'const-arbitrary-await-before-return',
    lines: [
      `import Root from '${ROOT}';`,
      'declare function loadBanner(): Promise<string>;',
      'export default async function Page() {',
      '  const banner = await loadBanner();',
      '  return <main data-banner={banner}><Root /></main>;',
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
    id: 'method-computed-key-await-search',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ searchParams }: { searchParams: Promise<{ k?: string }> }) {',
      "  const table = { async [(await searchParams).k ?? 'x']() {} };",
      '  return <main data-ok={Boolean(table)}><Root /></main>;',
      '}',
    ],
  },
  {
    expected: {
      blocking: false,
      given: ['q'],
      props: {},
      searched: true,
      specifier: ROOT,
    },
    id: 'suspended-inner-nested-await-search-pin',
    lines: [
      "import { Suspense } from 'react';",
      `import Root from '${ROOT}';`,
      'async function Inner({ searchParams }: { searchParams: Promise<{ q?: string }> }) {',
      '  const q = (await searchParams).q;',
      '  return <Root q={q} />;',
      '}',
      'export default function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {',
      '  return <Suspense fallback={null}><Inner searchParams={searchParams} /></Suspense>;',
      '}',
    ],
  },
  {
    expected: {
      blocking: false,
      given: [],
      props: { slug: 'slug' },
      searched: false,
      specifier: ROOT,
    },
    id: 'deferred-arrow-await-pin',
    lines: [
      "import { Suspense } from 'react';",
      `import Root from '${ROOT}';`,
      'async function Inner({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Root slug={slug} />;',
      '}',
      'export default function Page({ params }: { params: Promise<{ slug: string }> }) {',
      "  const load = async () => await Promise.resolve('x');",
      '  return <Suspense fallback={<p data-fn={Boolean(load)} />}><Inner params={params} /></Suspense>;',
      '}',
    ],
  },
  {
    expected: {
      blocking: false,
      given: [],
      props: { slug: 'slug' },
      searched: false,
      specifier: ROOT,
    },
    id: 'deferred-method-body-await-pin',
    lines: [
      "import { Suspense } from 'react';",
      `import Root from '${ROOT}';`,
      'async function Inner({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Root slug={slug} />;',
      '}',
      'export default function Page({ params }: { params: Promise<{ slug: string }> }) {',
      "  const handlers = { async run() { return await Promise.resolve('x'); } };",
      '  return <Suspense fallback={<p data-fn={Boolean(handlers)} />}><Inner params={params} /></Suspense>;',
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
    id: 'direct-await-params-and-search-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ q?: string }>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { q } = await searchParams;',
      '  return <Root slug={slug} q={q} />;',
      '}',
    ],
  },
];

describe('pageRenderOf when awaits appear inside expressions', () => {
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

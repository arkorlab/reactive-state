import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pageRenderOf } from '../src/compiler/page-render.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A page's or helper function's parameter holds the props it was given only as a plain identifier
 * (the props object whole) or an object pattern of named properties without rest elements or
 * defaults: `{ ...params }` copies the outer props object rather than reading `props.params`,
 * `...props` collects an arguments array, and a parameter default may replace what was handed.
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
    id: 'page-object-rest-params',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ ...params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <main><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'page-object-rest-search-params',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params, ...searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ q?: string }>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { q } = await searchParams;',
      '  return <Root slug={slug} q={q} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'inner-object-rest-params',
    lines: [
      "import { Suspense } from 'react';",
      `import Root from '${ROOT}';`,
      'type Props = { params: Promise<{ slug: string }> };',
      'export default function Page(props: Props) {',
      '  return <Suspense fallback={null}><Inner {...props} /></Suspense>;',
      '}',
      'async function Inner({ ...params }: Props) {',
      '  const { slug } = await params;',
      '  return <Root slug={slug} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'page-rest-parameter-props',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page(...props: readonly [{ params: Promise<{ slug: string }> }]) {',
      '  const { slug } = await props.params;',
      '  return <main><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'page-rest-parameter-spread-inner',
    lines: [
      "import { Suspense } from 'react';",
      `import Root from '${ROOT}';`,
      'type Props = { params: Promise<{ slug: string }> };',
      'export default function Page(...props: readonly [Props]) {',
      '  return <Suspense fallback={null}><Inner {...props} /></Suspense>;',
      '}',
      'async function Inner(props: Props) {',
      '  const { slug } = await props.params;',
      '  return <Root slug={slug} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'inner-parameter-default-value',
    lines: [
      `import Root from '${ROOT}';`,
      'type Props = { params: Promise<{ slug: string }> };',
      'declare const fallback: Props;',
      'export default function Page({ params }: Props) {',
      '  return <Inner params={params} />;',
      '}',
      'async function Inner(props: Props = fallback) {',
      '  const { slug } = await props.params;',
      '  return <Root slug={slug} />;',
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
    id: 'page-named-params-and-search-pin',
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
  {
    expected: SLUG_BLOCKING,
    id: 'page-renamed-params-prop-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params: routeParams }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await routeParams;',
      '  return <main><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: { ...SLUG_BLOCKING, blocking: false },
    id: 'page-whole-props-spread-inner-pin',
    lines: [
      "import { Suspense } from 'react';",
      `import Root from '${ROOT}';`,
      'type Props = { params: Promise<{ slug: string }> };',
      'export default function Page(props: Props) {',
      '  return <Suspense fallback={null}><Inner {...props} /></Suspense>;',
      '}',
      'async function Inner({ params }: Props) {',
      '  const { slug } = await params;',
      '  return <Root slug={slug} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'page-element-default-refused-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'declare const fallback: Promise<{ slug: string }>;',
      'export default async function Page({ params = fallback }: { params?: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <main><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'page-computed-key-refused-pin',
    lines: [
      `import Root from '${ROOT}';`,
      "export default async function Page({ ['params']: params }: { params: Promise<{ slug: string }> }) {",
      '  const { slug } = await params;',
      '  return <main><Root slug={slug} /></main>;',
      '}',
    ],
  },
];

describe('pageRenderOf when mapping page and helper parameter sources', () => {
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

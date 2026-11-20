import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pageRenderOf } from '../src/compiler/page-render.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A JSX tag in a page or in a function of the page's file names the file's imported reactive root,
 * a top-level helper function, or `react`'s `Suspense` only where no declaration in scope around the
 * tag gives that name again, and only where the tag itself reads a binding rather than an intrinsic
 * browser element.
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
    id: 'page-const-shadows-root',
    lines: [
      `import Root from '${ROOT}';`,
      'declare function Other(props: { slug: string }): unknown;',
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  const Root = Other;',
      '  return <Root slug={slug} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'page-awaited-param-shadows-root',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ Root: () => unknown }> }) {',
      '  const { Root } = await params;',
      '  return <Root />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'page-parameter-shadows-root',
    lines: [
      `import { default as Root } from '${ROOT}';`,
      'export default function Page(Root: () => unknown) {',
      '  return <Root />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'inner-const-shadows-root',
    lines: [
      `import Root from '${ROOT}';`,
      'declare function Other(props: { slug: string }): unknown;',
      'export default function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  return <Inner params={params} />;',
      '}',
      'async function Inner({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  const Root = Other;',
      '  return <Root slug={slug} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'page-const-shadows-inner',
    lines: [
      `import Root from '${ROOT}';`,
      'declare function Other(props: { params: Promise<{ slug: string }> }): unknown;',
      'async function Inner({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Root slug={slug} />;',
      '}',
      'export default function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const Inner = Other;',
      '  return <Inner params={params} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'page-parameter-shadows-inner',
    lines: [
      `import Root from '${ROOT}';`,
      'function Inner() {',
      '  return <Root id="fixed" />;',
      '}',
      'export default function Page(Inner: (props: unknown) => unknown) {',
      '  return <Inner {...Inner} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'page-const-shadows-suspense',
    lines: [
      "import { Suspense } from 'react';",
      `import Root from '${ROOT}';`,
      'declare function Frame(props: { children: unknown; fallback: null }): unknown;',
      'async function Inner({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Root slug={slug} />;',
      '}',
      'export default function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const Suspense = Frame;',
      '  return <Suspense fallback={null}><Inner params={params} /></Suspense>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'page-const-shadows-react-suspense',
    lines: [
      "import * as React from 'react';",
      `import Root from '${ROOT}';`,
      'declare function Frame(props: { children: unknown; fallback: null }): unknown;',
      'async function Inner({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Root slug={slug} />;',
      '}',
      'export default function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const React = { Suspense: Frame };',
      '  return <React.Suspense fallback={null}><Inner params={params} /></React.Suspense>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'lowercase-default-import-intrinsic',
    lines: [
      `import section from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <section id={slug} />;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'callback-parameter-shadows-root',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  const render = (Root: () => unknown) => <Root />;',
      '  return <main data-has={Boolean(render)}><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'unshadowed-default-root-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <main><Root slug={slug} /></main>;',
      '}',
    ],
  },
  {
    expected: { ...SLUG_BLOCKING, blocking: false },
    id: 'unshadowed-suspense-inner-pin',
    lines: [
      "import { Suspense } from 'react';",
      `import Root from '${ROOT}';`,
      'async function Inner({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Root slug={slug} />;',
      '}',
      'export default function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  return <Suspense fallback={null}><Inner params={params} /></Suspense>;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'sibling-function-shadows-root-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'function unrelated(Root: () => unknown) {',
      '  return <Root />;',
      '}',
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <main data-fn={Boolean(unrelated)}><Root slug={slug} /></main>;',
      '}',
    ],
  },
];

describe('pageRenderOf when local declarations shadow JSX tag names', () => {
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

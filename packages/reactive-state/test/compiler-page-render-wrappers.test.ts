import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pageRenderOf } from '../src/compiler/page-render.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Only JSX wrappers guaranteed to render their children on every path — intrinsic browser tags,
 * `<>…</>`, and unshadowed `Fragment` or `Suspense` from `'react'` — count as unconditional
 * containers around the reactive root or around a helper function of the page's file; imported or
 * unanalyzed custom wrapper components may omit `children` and are refused.
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
    id: 'default-imported-wrapper-around-root',
    lines: [
      "import Gate from './gate';",
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Gate><Root slug={slug} /></Gate>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'named-imported-wrapper-around-root',
    lines: [
      "import { Gate } from './gate';",
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Gate><Root slug={slug} /></Gate>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'namespace-member-wrapper-around-root',
    lines: [
      "import * as UI from './ui';",
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <UI.Gate><Root slug={slug} /></UI.Gate>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'wrapper-inside-suspense-around-inner',
    lines: [
      "import { Suspense } from 'react';",
      "import { Gate } from './gate';",
      `import Root from '${ROOT}';`,
      'async function Inner({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Root slug={slug} />;',
      '}',
      'export default function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  return <Suspense fallback={null}><Gate><Inner params={params} /></Gate></Suspense>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'wrapper-around-root-inside-inner',
    lines: [
      "import { Suspense } from 'react';",
      "import { Gate } from './gate';",
      `import Root from '${ROOT}';`,
      'async function Inner({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Gate><Root slug={slug} /></Gate>;',
      '}',
      'export default function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  return <Suspense fallback={null}><Inner params={params} /></Suspense>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'conditional-branch-with-imported-wrapper',
    lines: [
      "import { Gate } from './gate';",
      `import Root from '${ROOT}';`,
      'export default async function Page({ params, searchParams }: {',
      '  params: Promise<{ slug: string }>;',
      '  searchParams: Promise<{ gated?: string }>;',
      '}) {',
      '  const { slug } = await params;',
      '  const { gated } = await searchParams;',
      '  return gated ? <Gate><Root slug={slug} /></Gate> : <Root slug={slug} />;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'non-react-fragment-import',
    lines: [
      "import { Fragment } from './custom';",
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Fragment><Root slug={slug} /></Fragment>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'shadowed-react-fragment',
    lines: [
      "import { Fragment } from 'react';",
      `import Root from '${ROOT}';`,
      'declare function Gate(props: { children: unknown }): unknown;',
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  const Fragment = Gate;',
      '  return <Fragment><Root slug={slug} /></Fragment>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'shadowed-react-namespace-fragment',
    lines: [
      "import * as React from 'react';",
      `import Root from '${ROOT}';`,
      'declare function Gate(props: { children: unknown }): unknown;',
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  const React = { Fragment: Gate };',
      '  return <React.Fragment><Root slug={slug} /></React.Fragment>;',
      '}',
    ],
  },
  {
    expected: undefined,
    id: 'type-only-react-fragment-over-global',
    lines: [
      "import type { Fragment } from 'react';",
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Fragment><Root slug={slug} /></Fragment>;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'intrinsic-html-wrappers-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <main><section><Root slug={slug} /></section></main>;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'custom-element-and-namespaced-wrappers-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <stamp-shell><svg:g><Root slug={slug} /></svg:g></stamp-shell>;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'short-jsx-fragment-wrapper-pin',
    lines: [
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <><Root slug={slug} /></>;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'react-named-fragment-wrapper-pin',
    lines: [
      "import { Fragment } from 'react';",
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Fragment><Root slug={slug} /></Fragment>;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'react-aliased-fragment-wrapper-pin',
    lines: [
      "import { Fragment as Group } from 'react';",
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <Group><Root slug={slug} /></Group>;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'react-namespace-fragment-wrapper-pin',
    lines: [
      "import * as React from 'react';",
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <React.Fragment><Root slug={slug} /></React.Fragment>;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'react-default-fragment-wrapper-pin',
    lines: [
      "import React from 'react';",
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <React.Fragment><Root slug={slug} /></React.Fragment>;',
      '}',
    ],
  },
  {
    expected: SLUG_BLOCKING,
    id: 'sibling-custom-component-beside-root-pin',
    lines: [
      "import { Banner } from './banner';",
      `import Root from '${ROOT}';`,
      'export default async function Page({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params;',
      '  return <main><Banner /><Root slug={slug} /></main>;',
      '}',
    ],
  },
];

describe('pageRenderOf when JSX elements wrap the root or inner helper', () => {
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

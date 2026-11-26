import { describe, expect, it } from 'vitest';

import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Mutable native Date arrays retain their original consumer inputs and source boundaries. */
const CASES = [
  {
    id: 'native-tag-literal',
    source: `export function Widget(){return <p>{String.raw\`\${[new Date(0)]}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-tag-const',
    source: `export function Widget(){const dates=[new Date(0)];return <p>{String.raw\`\${dates}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-tag-let',
    source: `export function Widget(){let dates=[new Date(0)];return <p>{String.raw\`\${dates}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-tag-alias',
    source: `export function Widget(){const raw=String.raw;const dates=[new Date(0)];return <p>{raw\`\${dates}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-tag-alias-chain',
    source: `export function Widget(){const first=String.raw;const raw=first;return <p>{raw\`\${[new Date(0)]}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-tag-element',
    source: `export function Widget(){return <p>{String['raw']\`\${[new Date(0)]}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-tag-globalThis',
    source: `export function Widget(){return <p>{globalThis.String.raw\`\${[new Date(0)]}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-tag-later-quiet',
    source: `export function Widget(){return <p>{String.raw\`\${[new Date(0)]}\${'x'}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-tag-earlier-quiet',
    source: `export function Widget(){return <p>{String.raw\`\${'x'}\${[new Date(0)]}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-tag-two-date-arrays',
    source: `export function Widget(){return <p>{String.raw\`\${[new Date(0)]}\${[new Date(1)]}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-tag-nested-spread',
    source: `export function Widget(){return <p>{String.raw\`\${[[...[new Date(0)]]]}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-call-const',
    source: `export function Widget(){const dates=[new Date(0)];return <p>{String.raw({raw:['','']},dates)}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-call-let',
    source: `export function Widget(){let dates=[new Date(0)];return <p>{String.raw({raw:['','']},dates)}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-call-unused',
    source: `export function Widget(){let dates=[new Date(0)];return <p>{String.raw({raw:['fixed']},dates)}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'native-tag-scalars',
    source: `export function Widget(){return <p>{String.raw\`\${[1,'x',true]}\`}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'native-tag-iso',
    source: `export function Widget(){return <p>{String.raw\`\${[new Date(0).toISOString()]}\`}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'native-tag-invalid',
    source: `export function Widget(){return <p>{String.raw\`\${[new Date(NaN)]}\`}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'native-tag-empty',
    source: `export function Widget(){return <p>{String.raw\`\${[]}\`}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'application-tag',
    source: `export function Widget(){const tag=(_strings:TemplateStringsArray,..._values:unknown[])=>'fixed';return <p>{tag\`\${[new Date(0)]}\`}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'shadowed-String',
    source: `export function Widget(){const String={raw:(_strings:TemplateStringsArray,..._values:unknown[])=>'fixed'};return <p>{String.raw\`\${[new Date(0)]}\`}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'later-own-date-conversion',
    source: `export function Widget(){const dates=[new Date(0)];return <p>{String.raw\`\${dates}\${(dates[0]!.toString=()=> 'fixed','')}\`}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'later-prototype-conversion',
    source: `export function Widget(){return <p>{String.raw\`\${[new Date(0)]}\${(Date.prototype.toString=()=> 'fixed','')}\`}</p>;}`,
    input: true,
    owner: false,
    private: true,
  },
  {
    id: 'earlier-unknown-coercion',
    source: `export function Widget(){const first={toString(){Date.prototype.toString=()=>'fixed';return '';}};return <p>{String.raw\`\${first}\${[new Date(0)]}\`}</p>;}`,
    input: true,
    owner: false,
    private: true,
  },
  {
    id: 'prior-own-array-join',
    source: `export function Widget(){const dates=[new Date(0)];dates.join=()=> 'fixed';return <p>{String.raw\`\${dates}\`}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'prior-native-raw-replacement',
    source: `export function Widget(){String.raw=()=> 'fixed';return <p>{String.raw\`\${[new Date(0)]}\`}</p>;}`,
    input: false,
    owner: false,
    private: true,
  },
  {
    id: 'captured-Date-array',
    source: `const dates=[new Date(0)];export function Widget(){return <p>{String.raw\`\${dates}\`}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'native-tag-scalar',
    source: `export function Widget(){return <p>{String.raw\`\${new Date(0)}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'native-call-scalar',
    source: `export function Widget(){return <p>{String.raw({raw:['','']},new Date(0))}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
] as const;

describe('native raw tag Date array owner boundaries', () => {
  it.each(CASES)('$id', ({ source, owner }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-assignment-owner.tsx', source);
    const read = firstIn(
      [parsed.sourceFile],
      (node) => renderDateConversion(node),
      () => false,
    );

    expect(read !== undefined).toBe(owner);
  });
});

describe('native raw tag Date array readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-addition.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('native raw tag Date array route renders', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, private: privateRender }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${source}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');
    const found = {
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    };
    const expected = { refusals: [], shared: !privateRender, private: privateRender };

    expect(found).toStrictEqual(expected);
  });
});

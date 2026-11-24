import { describe, expect, it } from 'vitest';

import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Mutable native Date arrays retain their original consumer inputs and source boundaries. */
const CASES = [
  {
    id: 'tag-empty-earlier-array',
    source: `export function Widget(){return <p>{String.raw\`\${[]}\${[new Date(0)]}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'tag-scalar-earlier-array',
    source: `export function Widget(){return <p>{String.raw\`\${[1,'x']}\${[new Date(0)]}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'tag-nested-spread-earlier-array',
    source: `export function Widget(){return <p>{String.raw\`\${[...[1],[]]}\${[new Date(0)]}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'tag-const-earlier-array',
    source: `export function Widget(){const prefix=[1];return <p>{String.raw\`\${prefix}\${[new Date(0)]}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'tag-let-earlier-array',
    source: `export function Widget(){let prefix=[1];return <p>{String.raw\`\${prefix}\${[new Date(0)]}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'call-earlier-array-existing-private',
    source: `export function Widget(){return <p>{String.raw({raw:['','','']},[1],[new Date(0)])}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'tag-existing-private',
    source: `export function Widget(){const dates=[new Date(0)];return <p>{String.raw\`\${dates}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'call-existing-private',
    source: `export function Widget(){const dates=[new Date(0)];return <p>{String.raw({raw:['','']},dates)}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'tag-scalar-arrays-fixed',
    source: `export function Widget(){return <p>{String.raw\`\${[1]}\${['x']}\`}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'application-tag-fixed',
    source: `export function Widget(){const tag=(_strings:TemplateStringsArray,..._values:unknown[])=>'fixed';return <p>{tag\`\${[]}\${[new Date(0)]}\`}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'earlier-unknown-coercion',
    source: `export function Widget(){const first={toString(){Date.prototype.toString=()=> 'fixed';return '';}};return <p>{String.raw\`\${first}\${[new Date(0)]}\`}</p>;}`,
    input: true,
    owner: false,
    private: true,
  },
  {
    id: 'later-own-date-conversion',
    source: `export function Widget(){const dates=[new Date(0)];return <p>{String.raw\`\${[]}\${dates}\${(dates[0]!.toString=()=> 'fixed','')}\`}</p>;}`,
    input: false,
    owner: false,
    private: false,
  },
] as const;

describe('native raw earlier array Date owner boundaries', () => {
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

describe('native raw earlier array Date readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-addition.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('native raw earlier array Date route renders', () => {
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

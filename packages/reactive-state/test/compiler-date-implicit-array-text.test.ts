import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Untagged template array substitutions retain source-known native Date text in render order. */
const CASES = [
  {
    id: 'reported-template-Date-array',
    source: `export function Widget(){return <p>{\`\${[new Date(0)]}\`}</p>;}`,
    input: true,
    private: true,
  },
  {
    id: 'primitive-earlier-substitution',
    source: `export function Widget(){return <p>{\`before:\${0}:\${[new Date(0)]}\`}</p>;}`,
    input: true,
    private: true,
  },
  {
    id: 'stored-array-whole-alias',
    source: `export function Widget(){const original=[new Date(0)];const dates=original;return <p>{\`\${dates}\`}</p>;}`,
    input: true,
    private: true,
  },
  {
    id: 'nested-finite-array-template',
    source: `export function Widget(){return <p>{\`\${[[new Date(0)]]}\`}</p>;}`,
    input: true,
    private: true,
  },
  {
    id: 'later-call-after-Date-conversion',
    source: `export function Widget(){function fixed(){return "fixed";}return <p>{\`\${[new Date(0)]}\${fixed()}\`}</p>;}`,
    input: true,
    private: true,
  },
  {
    id: 'earlier-substitution-repairs-Date',
    source: `export function Widget(){const date=new Date(0);const head={toString(){date.toString=()=>"fixed";return "";}};return <p>{\`\${head}\${[date]}\`}</p>;}`,
    input: false,
    private: false,
  },
  {
    id: 'own-array-toString-data',
    source: `export function Widget(){const dates=[new Date(0)];dates.toString=()=>"fixed";return <p>{\`\${dates}\`}</p>;}`,
    input: false,
    private: false,
  },
  {
    id: 'invalid-Date-array-data',
    source: `export function Widget(){return <p>{\`\${[new Date(1e20)]}\`}</p>;}`,
    input: false,
    private: false,
  },
  {
    id: 'ISO-Date-text-array-data',
    source: `export function Widget(){return <p>{\`\${[new Date(0).toISOString()]}\`}</p>;}`,
    input: false,
    private: false,
  },
  {
    id: 'own-Date-toString-data',
    source: `export function Widget(){const date=new Date(0);date.toString=()=>"fixed";return <p>{\`\${[date]}\`}</p>;}`,
    input: false,
    private: false,
  },
  {
    id: 'application-tag-keeps-array-data',
    source: `export function Widget(){function tag(_strings:TemplateStringsArray,..._values:unknown[]){return "fixed";}return <p>{tag\`\${[new Date(0)]}\`}</p>;}`,
    input: false,
    private: false,
  },
  {
    id: 'event-only-implicit-array-text',
    source: `export function Widget(){return <button onClick={()=>{\`\${[new Date(0)]}\`;}}>fixed</button>;}`,
    input: null,
    private: false,
  },
] as const;

describe('date implicit array conversion readers', () => {
  it.each(CASES.filter((row) => row.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'date-local-conversions.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('date implicit array conversion route renders', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, private: privateRender }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${source}`,
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { Widget } from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){',
        'return <section><Widget />{children}</section>;',
        '}',
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

import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Quiet binary addition retains native Date array text after both operands evaluate. */
const CASES = [
  {
    id: 'reported-string-plus-Date-array',
    source: "export function Widget(){return <p>{'' + [new Date(0)]}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'Date-array-plus-string',
    source: "export function Widget(){return <p>{[new Date(0)] + ''}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'constant-array-and-primitive-aliases',
    source:
      'export function Widget(){const head="prefix:";const initial=[new Date(0)];const dates=initial;return <p>{head + dates}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'nested-finite-spread-array-addition',
    source: "export function Widget(){return <p>{'' + [[new Date(0)],...[0]]}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'right-expression-repairs-left-Date',
    source:
      'export function Widget(){const date=new Date(0);function fix(){date.toString=()=>"fixed";return "";}return <p>{[date] + fix()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'left-conversion-repairs-right-Date',
    source:
      'export function Widget(){const date=new Date(0);const head={toString(){date.toString=()=>"fixed";return "";}};return <p>{(head as unknown as string) + [date]}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'earlier-array-element-conversion-repairs-Date',
    source:
      'export function Widget(){const date=new Date(0);const head={toString(){date.toString=()=>"fixed";return "";}};return <p>{\'\' + [head,date]}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'own-array-join-data',
    source:
      'export function Widget(){const dates=[new Date(0)];dates.join=()=>"fixed";return <p>{\'\' + dates}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'invalid-Date-addition-data',
    source: "export function Widget(){return <p>{'' + [new Date(1e20)]}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'local-Date-constructor-data',
    source:
      'export function Widget(){class Date{constructor(_milliseconds:number){}toString(){return "fixed";}}return <p>{\'\' + [new Date(0)]}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'right-expression-throws-before-coercion',
    source:
      'export function Widget(){function fail():string{throw new Error("stop");}return <p>{[new Date(0)] + fail()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'event-only-Date-array-addition',
    source:
      "export function Widget(){return <button onClick={()=>{'' + [new Date(0)];}}>fixed</button>;}",
    input: null,
    private: false,
  },
] as const;

describe('date binary array conversion readers', () => {
  it.each(CASES.filter((row) => row.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'date-local-conversions.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('date binary array conversion route renders', () => {
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

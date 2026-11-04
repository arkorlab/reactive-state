import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native String array conversions retain only source-known Date text at a rendered use. */
const CASES = [
  {
    id: 'reported-String-Date-array',
    source: 'export function Widget(){return <p>{String([new Date(0)])}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'globalThis-String-fixed-ISO-array',
    source:
      'export function Widget(){return <p>{globalThis.String([new Date("1970-01-01T00:00:00Z")])}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'native-String-whole-alias',
    source: 'export function Widget(){const Text=String;return <p>{Text([new Date(0)])}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'boxed-String-Date-array',
    source: 'export function Widget(){return <p>{new String([new Date(0)]).valueOf()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'nested-native-Date-array',
    source: 'export function Widget(){return <p>{String([[new Date(0)]])}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'stored-array-whole-alias',
    source:
      'export function Widget(){const original=[new Date(0)];const dates=original;return <p>{String(dates)}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'direct-String-Date-existing-pin',
    source: 'export function Widget(){return <p>{String(new Date(0))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'array-toString-existing-pin',
    source: 'export function Widget(){return <p>{[new Date(0)].toString()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'own-Date-toString-keeps-data',
    source:
      'export function Widget(){const date=new Date(0);date.toString=()=>"fixed";return <p>{String([date])}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'own-array-toString-keeps-data',
    source:
      'export function Widget(){const dates=[new Date(0)];dates.toString=()=>"fixed";return <p>{String(dates)}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'own-array-join-keeps-data',
    source:
      'export function Widget(){const dates=[new Date(0)];dates.join=()=>"fixed";return <p>{String(dates)}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'invalid-Date-array-keeps-data',
    source: 'export function Widget(){return <p>{String([new Date(1e20)])}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'UTC-text-array-keeps-data',
    source: 'export function Widget(){return <p>{String([new Date(0).toUTCString()])}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'ISO-text-array-keeps-data',
    source: 'export function Widget(){return <p>{String([new Date(0).toISOString()])}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'evaluated-tail-repair-keeps-boundary',
    source:
      'export function Widget(){const date=new Date(0);const Text=String as(...values:unknown[])=>string;return <p>{Text([date],date.toString=()=>"fixed")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'earlier-element-repair-keeps-boundary',
    source:
      'export function Widget(){const date=new Date(0);const head={toString(){date.toString=()=>"fixed";return "";}};return <p>{String([head,date])}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'prior-call-repair-keeps-boundary',
    source:
      'export function Widget(){function prepare(){date.toString=()=>"fixed";}const date=new Date(0);prepare();return <p>{String([date])}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'ordinary-array-keeps-data',
    source: 'export function Widget(){return <p>{String(["fixed",0,null])}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'event-only-native-array-conversion',
    source:
      'export function Widget(){return <button onClick={()=>{String([new Date(0)]);}}>fixed</button>;}',
    input: null,
    private: false,
  },
  {
    id: 'effect-only-boxed-array-conversion',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{new String([new Date(0)]).valueOf();},[]);return <p>fixed</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'quiet-ignored-tail-keeps-Date-input',
    source:
      'export function Widget(){const Text=String as(...values:unknown[])=>string;return <p>{Text([new Date(0)],0)}</p>;}',
    input: true,
    private: true,
  },
] as const;

describe('date String array conversion readers', () => {
  it.each(CASES.filter((row) => row.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'date-local-conversions.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('date String array conversion route renders', () => {
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

import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native String scalar calls preserve the Date render input and existing opacity. */
const CASES = [
  {
    id: 'reported-native-String-alias',
    source: 'export function Widget(){const text=String;return <p>{text(new Date(0))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'native-String-alias-chain',
    source:
      'export function Widget(){const original=String;const text=original;return <p>{text(new Date(0))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'native-globalThis-String-alias',
    source:
      'export function Widget(){const text=globalThis.String;return <p>{text(new Date(0))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'stored-Date-native-alias',
    source:
      'export function Widget(){const date=new Date(0);const text=String;return <p>{text(date)}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'stored-holder-Date-native-alias',
    source:
      'export function Widget(){const box={date:new Date(0)};const text=String;return <p>{text(box.date)}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'bracket-global-String-alias',
    source:
      "export function Widget(){const text=globalThis['String'];return <p>{text(new Date(0))}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'asserted-native-String-call',
    source:
      'export function Widget(){const text=String;return <p>{(text as (value:unknown)=>string)(new Date(0))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'native-alias-quiet-ignored-tail',
    source:
      'export function Widget(){const text=String as(...args:unknown[])=>string;return <p>{text(new Date(0),0)}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'direct-native-String-pin',
    source: 'export function Widget(){return <p>{String(new Date(0))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'new-native-String-alias-pin',
    source:
      'export function Widget(){const Text=String;return <p>{new Text(new Date(0)).valueOf()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'native-array-String-alias-pin',
    source: 'export function Widget(){const text=String;return <p>{text([new Date(0)])}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'invalid-Date-fixed-text',
    source: 'export function Widget(){const text=String;return <p>{text(new Date(1e20))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'explicit-UTC-text',
    source:
      'export function Widget(){const text=String;return <p>{text(new Date(0).toUTCString())}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'own-Date-text',
    source:
      'export function Widget(){const date=new Date(0);date.toString=()=>"fixed";const text=String;return <p>{text(date)}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'local-text-function',
    source:
      'export function Widget(){const text=(_value:unknown)=>"fixed";return <p>{text(new Date(0))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'replaced-text-binding',
    source:
      'export function Widget(){let text: (value:unknown)=>string=String;text=()=>"fixed";return <p>{text(new Date(0))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'ordinary-native-text',
    source: 'export function Widget(){const text=String;return <p>{text("fixed")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'event-only-native-alias',
    source:
      'export function Widget(){const text=String;return <button onClick={()=>{text(new Date(0));}}>fixed</button>;}',
    input: null,
    private: false,
  },
  {
    id: 'effect-only-native-alias',
    source:
      'import {useEffect} from "react";export function Widget(){const text=String;useEffect(()=>{text(new Date(0));},[]);return <p>fixed</p>;}',
    input: null,
    private: false,
  },
] as const;

describe('native String Date alias readers', () => {
  it.each(CASES.filter((row) => row.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-string-date-alias.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('native String Date alias route renders', () => {
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

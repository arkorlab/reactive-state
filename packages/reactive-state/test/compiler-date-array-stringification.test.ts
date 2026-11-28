import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native fresh-array stringification retains source-known Date text and its original guards. */
const CASES = [
  {
    id: 'reported-fresh-toString',
    source: 'export function Widget(){return <p>{[new Date(0)].toString()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'computed-toString',
    source: 'export function Widget(){return <p>{[new Date(0)]["toString"]()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'nested-toString',
    source: 'export function Widget(){return <p>{[[new Date(0)]].toString()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'stored-array-toString',
    source: 'export function Widget(){const dates=[new Date(0)];return <p>{dates.toString()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'whole-array-alias-toString',
    source:
      'export function Widget(){const original=[new Date(0)];const dates=original;return <p>{dates.toString()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'stored-Date-toString',
    source: 'export function Widget(){const date=new Date(0);return <p>{[date].toString()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'finite-spread-toString',
    source: 'export function Widget(){return <p>{[...[new Date(0)]].toString()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'mixed-hole-toString',
    source: 'export function Widget(){return <p>{[null,new Date(0),,undefined].toString()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'ordinary-array-data',
    source: 'export function Widget(){return <p>{["fixed",0,null].toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'empty-array-data',
    source: 'export function Widget(){return <p>{[].toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'invalid-Date-data',
    source: 'export function Widget(){return <p>{[new Date(1e20)].toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'ISO-text-data',
    source:
      'export function Widget(){const date=new Date(0);return <p>{[date.toISOString()].toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'own-Date-text-data',
    source:
      'export function Widget(){const date=new Date(0);date.toString=()=>"fixed";return <p>{[date].toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'own-array-text-data',
    source:
      'export function Widget(){const dates=[new Date(0)];dates.toString=()=>"fixed";return <p>{dates.toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'own-array-join-data',
    source:
      'export function Widget(){const dates=[new Date(0)];dates.join=()=>"fixed";return <p>{dates.toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'noncallable-array-join-data',
    source:
      'export function Widget(){const dates=[new Date(0)];dates.join=0 as never;return <p>{dates.toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'replaced-array-element-data',
    source:
      'export function Widget(){const dates:[Date|string]=[new Date(0)];dates[0]="fixed";return <p>{dates.toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'shadowed-Date-data',
    source:
      'export function Widget(){class Date{constructor(_value:number){}toString(){return "fixed";}}return <p>{[new Date(0)].toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'ordinary-object-data',
    source:
      'export function Widget(){const dates={toString:()=>"fixed"};return <p>{dates.toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'earlier-element-conversion-data',
    source:
      'export function Widget(){const date=new Date(0);const head={toString(){date.toString=()=>"fixed";return "";}};return <p>{[head,date].toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'prior-call-own-Date-data',
    source:
      'export function Widget(){function prepare(){date.toString=()=>"fixed";}const date=new Date(0);prepare();return <p>{[date].toString()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'captured-own-Date-data',
    source:
      'export function Widget(){const dates=[new Date(0)];function text(prepare:()=>void){prepare();return dates.toString();}return <p>{text(()=>{dates[0]!.toString=()=>"fixed";})}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'existing-explicit-join-private',
    source: 'export function Widget(){return <p>{[new Date(0)].join()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'deferred-toString-data',
    source:
      'export function Widget(){const unused=()=>[new Date(0)].toString();return <p>{"fixed"}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'event-toString-data',
    source:
      'export function Widget(){return <button onClick={()=>{[new Date(0)].toString();}}>fixed</button>;}',
    input: null,
    private: false,
  },
  {
    id: 'effect-toString-data',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{[new Date(0)].toString();},[]);return <p>fixed</p>;}',
    input: null,
    private: false,
  },
  // String reads its first argument alone; those after it the compile cannot read leave it to decide.
  {
    id: 'String-unread-tail',
    source:
      'export function Widget(){const render=(extra:readonly never[])=>String([new Date(0)],...extra);return <p>{render([])}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'String-unread-tail-data',
    source:
      "export function Widget(){const render=(extra:readonly never[])=>String(['x'],...extra);return <p>{render([])}</p>;}",
    input: false,
    private: false,
  },
  // An argument toString or String ignores takes no Date text away from what they convert.
  {
    id: 'toString-coowned-call-argument',
    source:
      "export function Widget(){const sep=()=>'-';return <p>{[new Date(0)].toString(sep() as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'String-coowned-call-tail',
    source:
      "export function Widget(){const sep=()=>'-';return <p>{String([new Date(0)],sep() as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'String-coowned-call-tail-data',
    source:
      "export function Widget(){const sep=()=>'-';return <p>{String(['x'],sep() as never)}</p>;}",
    input: false,
    private: false,
  },
] as const;

describe('date array stringification readers', () => {
  it.each(CASES.filter((row) => row.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'date-array-stringification.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('date array stringification route renders', () => {
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

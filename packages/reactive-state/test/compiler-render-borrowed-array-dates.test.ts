import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Borrowed native array conversion keeps source-known Date text and original evaluation guards. */
const CASES = [
  {
    id: 'reported-join-call',
    source:
      "export function Widget(){return <p>{Array.prototype.join.call([new Date(0)],'')}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'join-apply',
    source:
      "export function Widget(){return <p>{Array.prototype.join.apply([new Date(0)],[''])}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'Reflect-join',
    source:
      "export function Widget(){return <p>{Reflect.apply(Array.prototype.join,[new Date(0)],[''])}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'join-default-separator',
    source: 'export function Widget(){return <p>{Array.prototype.join.call([new Date(0)])}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'native-join-alias',
    source:
      "export function Widget(){const join=Array.prototype.join;return <p>{join.call([new Date(0)],'')}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'receiver-alias',
    source:
      "export function Widget(){const dates=[new Date(0)];return <p>{Array.prototype.join.call(dates,'')}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'nested-Date-array',
    source:
      "export function Widget(){return <p>{Array.prototype.join.call([[new Date(0)]],'')}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'Date-separator-empty',
    source:
      'export function Widget(){return <p>{Array.prototype.join.call([],new Date(0) as never)}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'Date-array-separator-empty',
    source:
      'export function Widget(){return <p>{Array.prototype.join.call([],[new Date(0)] as never)}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'native-toString-call',
    source:
      'export function Widget(){return <p>{Array.prototype.toString.call([new Date(0)])}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'native-toString-apply',
    source:
      'export function Widget(){return <p>{Array.prototype.toString.apply([new Date(0)],[])}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'immediate-bound-join',
    source:
      "export function Widget(){return <p>{Array.prototype.join.bind([new Date(0)],'')()}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'saved-bound-join',
    source:
      "export function Widget(){const join=Array.prototype.join.bind([new Date(0)],'');return <p>{join()}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'borrowed-join-ISO',
    source:
      "export function Widget(){return <p>{Array.prototype.join.call([new Date(0).toISOString()],'')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'borrowed-join-UTC',
    source:
      "export function Widget(){return <p>{Array.prototype.join.call([new Date(0).toUTCString()],'')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'borrowed-join-scalars',
    source: "export function Widget(){return <p>{Array.prototype.join.call(['a',0,'b'],':')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'borrowed-empty-join',
    source: "export function Widget(){return <p>{Array.prototype.join.call([],'')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'borrowed-invalid-Date',
    source:
      "export function Widget(){return <p>{Array.prototype.join.call([new Date(1e20)],'')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'local-Array-shadow',
    source:
      'export function Widget(){const Array={prototype:{join:{call:(_receiver:unknown,_separator:unknown)=>"fixed"}}};return <p>{Array.prototype.join.call([new Date(0)],\'\')}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'own-local-join',
    source:
      'export function Widget(){const own={join(){return"fixed";}};return <p>{own.join.call([new Date(0)])}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'defined-own-call',
    source:
      'export function Widget(){const join=Array.prototype.join;Object.defineProperty(join,"call",{value:()=>"fixed"});return <p>{join.call([new Date(0)],\'\')}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'changed-receiver',
    source:
      'export function Widget(){const dates:(Date|string)[]=[new Date(0)];dates[0]="fixed";return <p>{Array.prototype.join.call(dates,\'\')}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'ignored-call-tail-rewrites-Date',
    source:
      'export function Widget(){const date=new Date(0);const dates=[date];return <p>{(Array.prototype.join.call as (...args:unknown[])=>string)(dates,\'\',date.toString=()=>"fixed")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'toString-retains-own-join',
    source:
      'export function Widget(){const dates=[new Date(0)];dates.join=()=>"fixed";return <p>{Array.prototype.toString.call(dates)}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'bound-scalar-control',
    source:
      "export function Widget(){const join=Array.prototype.join.bind(['fixed'],'');return <p>{join()}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'local-Date-shadow',
    source:
      'export function Widget(){class Date{constructor(_value:number){}toString(){return"fixed";}}return <p>{Array.prototype.join.call([new Date(0)],\'\')}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'locale-existing-private-pin',
    source:
      'export function Widget(){return <p>{Array.prototype.toLocaleString.call([new Date(0)],"en-US")}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'event-only-borrowed-join',
    source:
      "export function Widget(){return <button onClick={()=>{Array.prototype.join.call([new Date(0)],'');}}>fixed</button>;}",
    input: null,
    private: false,
  },
  {
    id: 'effect-only-borrowed-join',
    source:
      "import {useEffect} from 'react';export function Widget(){useEffect(()=>{Array.prototype.join.call([new Date(0)],'');},[]);return <p>fixed</p>;}",
    input: null,
    private: false,
  },
  {
    id: 'bound-join-ignored-tail-rewrite',
    source:
      'export function Widget(){const date=new Date(0);const join=Array.prototype.join.bind([date],\'\');return <p>{(join as (...args:unknown[])=>string)(date.toString=()=>"fixed")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'String-call-Date',
    source: 'export function Widget(){return <p>{String.call(null,new Date(0))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'String-apply-Date',
    source: 'export function Widget(){return <p>{String.apply(null,[new Date(0)])}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'Reflect-String-Date',
    source: 'export function Widget(){return <p>{Reflect.apply(String,null,[new Date(0)])}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'bound-String-Date',
    source: 'export function Widget(){return <p>{String.bind(null,new Date(0))()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'String-call-Date-array',
    source: 'export function Widget(){return <p>{String.call(null,[new Date(0)])}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'String-ignored-this-Date',
    source: "export function Widget(){return <p>{String.call(new Date(0),'fixed')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'String-quiet-data',
    source: "export function Widget(){return <p>{String.apply(null,['fixed'])}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'bound-String-ignored-tail-rewrite',
    source:
      'export function Widget(){const date=new Date(0);const string=String.bind(null,date);return <p>{(string as (...args:unknown[])=>string)(date.toString=()=>"fixed")}</p>;}',
    input: false,
    private: false,
  },
] as const;

describe('borrowed array Date conversion readers', () => {
  it.each(CASES.filter((row) => row.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'borrowed-array-date.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('borrowed array Date conversion route renders', () => {
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

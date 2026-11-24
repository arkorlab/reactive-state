import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Rendered locale operations retain local inputs while callbacks and written data keep their meaning. */
const CASES = [
  {
    id: 'reflected-hours',
    source:
      "export function Widget(){return <p>{String(Reflect.get(new Date(0),'getHours').call(new Date(0)))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'reflected-offset',
    source:
      "export function Widget(){return <p>{String(Reflect.get(new Date(0),'getTimezoneOffset').call(new Date(0)))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'reflected-date-text',
    source:
      "export function Widget(){return <p>{String(Reflect.get(new Date(0),'toDateString').call(new Date(0)))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'alias-reflected-hours',
    source:
      "export function Widget(){const date=new Date(0);return <p>{String(Reflect.get(date,'getHours').call(date))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'constant-reflected-key',
    source:
      "export function Widget(){const key='getHours';return <p>{String(Reflect.get(new Date(0),key).call(new Date(0)))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'reflected-utc-hours',
    source:
      "export function Widget(){return <p>{String(Reflect.get(new Date(0),'getUTCHours').call(new Date(0)))}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'reflected-epoch-time',
    source:
      "export function Widget(){return <p>{String(Reflect.get(new Date(0),'getTime').call(new Date(0)))}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'reflected-iso-text',
    source:
      "export function Widget(){return <p>{String(Reflect.get(new Date(0),'toISOString').call(new Date(0)))}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'ordinary-reflected-data',
    source:
      "export function Widget(){return <p>{String(Reflect.get({getHours:()=>7},'getHours')())}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'shadowed-reflect-data',
    source:
      "export function Widget(){const Reflect={get:(_target:unknown,_key:string)=>()=>7};return <p>{String(Reflect.get(new Date(0),'getHours')())}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'own-reflected-date-data',
    source:
      "export function Widget(){const date=new Date(0);date.getHours=()=>7;return <p>{String(Reflect.get(date,'getHours')())}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'shadowed-date-data',
    source:
      "export function Widget(){class Date{constructor(_value:number){}getHours(){return 7;}}return <p>{String(Reflect.get(new Date(0),'getHours')())}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'alias-reflect-hours',
    source:
      "export function Widget(){const get=Reflect.get;return <p>{String(get(new Date(0),'getHours').call(new Date(0)))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'alias-chain-reflect-hours',
    source:
      "export function Widget(){const read=Reflect.get;const get=read;const date=new Date(0);return <p>{String(get(date,'getHours').call(date))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'borrowed-call-reflect-hours',
    source:
      "export function Widget(){return <p>{String(Reflect.get.call(undefined,new Date(0),'getHours').call(new Date(0)))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'borrowed-apply-reflect-hours',
    source:
      "export function Widget(){return <p>{String(Reflect.get.apply(undefined,[new Date(0),'getHours']).call(new Date(0)))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'reflect-apply-get-hours',
    source:
      "export function Widget(){return <p>{String(Reflect.apply(Reflect.get,undefined,[new Date(0),'getHours']).call(new Date(0)))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'alias-reflect-locale-text',
    source:
      "export function Widget(){const get=Reflect.get;return <p>{String(get(new Date(0),'toLocaleString').call(new Date(0)))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'alias-reflect-unknown-key',
    source:
      'export function Widget({name}:{name:string}){const get=Reflect.get;return <p>{String(typeof get(new Date(0),name))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'written-reflect-unknown-key',
    source:
      'export function Widget({name}:{name:string}){return <p>{String(typeof Reflect.get(new Date(0),name))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'alias-reflect-utc-hours',
    source:
      "export function Widget(){const get=Reflect.get;return <p>{String(get(new Date(0),'getUTCHours').call(new Date(0)))}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'alias-reflect-iso-text',
    source:
      "export function Widget(){const get=Reflect.get;return <p>{String(get(new Date(0),'toISOString').call(new Date(0)))}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'alias-ordinary-reflected-data',
    source:
      "export function Widget(){const get=Reflect.get;return <p>{String(get({getHours:()=>7},'getHours')())}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'alias-own-reflected-date-data',
    source:
      "export function Widget(){const get=Reflect.get;const date=new Date(0);date.getHours=()=>7;return <p>{String(get(date,'getHours')())}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'shadowed-reflect-alias-data',
    source:
      "export function Widget(){const Reflect={get:(_target:unknown,_key:string)=>()=>7};const get=Reflect.get;return <p>{String(get(new Date(0),'getHours')())}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'mutable-reflect-alias-data',
    source:
      "export function Widget(){let get=Reflect.get;get=(_target:object,_key:PropertyKey)=>()=>7;return <p>{String(get(new Date(0),'getHours')())}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'reflect-date-event-only',
    source:
      "export function Widget(){return <button onClick={()=>console.log(Reflect.get(new Date(0),'getHours').call(new Date(0)))}>fixed</button>;}",
    refused: false,
    reader: false,
  },
  {
    id: 'reflect-date-effect-only',
    source:
      "import {useEffect} from 'react';export function Widget(){useEffect(()=>{console.log(Reflect.get(new Date(0),'getHours').call(new Date(0)));},[]);return <p>fixed</p>;}",
    refused: false,
    reader: false,
  },
] as const;

describe('reflected date readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-locale.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(refused);
  });
});

describe('reflected date route inputs', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused }) => {
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
    const expected = { refusals: [], shared: !refused, private: refused };

    expect(found).toStrictEqual(expected);
  });
});

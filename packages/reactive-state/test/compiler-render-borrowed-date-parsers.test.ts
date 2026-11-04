import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Borrowed native Date parsing retains source-known local text and the original evaluation boundary. */
const CASES = [
  {
    id: 'reported-native-call',
    source:
      'export function Widget(){return <p>{String(Date.parse.call(null,"2020-01-01T00:00"))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'literal-bracket-call',
    source:
      'export function Widget(){return <p>{String(Date.parse["call"](null,"2020-01-01T00:00"))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'constant-key-call',
    source:
      'export function Widget(){const key="call";return <p>{String(Date.parse[key](null,"2020-01-01T00:00"))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'native-apply-list',
    source:
      'export function Widget(){return <p>{String(Date.parse.apply(null,["2020-01-01T00:00"]))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'native-Reflect-apply',
    source:
      'export function Widget(){return <p>{String(Reflect.apply(Date.parse,null,["2020-01-01T00:00"]))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'whole-parser-alias-call',
    source:
      'export function Widget(){const parse=Date.parse;return <p>{String(parse.call(null,"2020-01-01T00:00"))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'whole-parser-chain-apply',
    source:
      'export function Widget(){const original=Date.parse;const parse=original;return <p>{String(parse.apply(null,["2020-01-01T00:00"]))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'globalThis-Reflect-apply',
    source:
      'export function Widget(){return <p>{String(globalThis.Reflect.apply(globalThis.Date.parse,null,["2020-01-01T00:00"]))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'text-alias-call',
    source:
      'export function Widget(){const text="2020-01-01T00:00";return <p>{String(Date.parse.call(null,text))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'stored-list-apply',
    source:
      'export function Widget(){const args:[string]=["2020-01-01T00:00"];return <p>{String(Date.parse.apply(null,args))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'call-literal-spread',
    source:
      'export function Widget(){return <p>{String(Date.parse.call(...[null,"2020-01-01T00:00"] as [null,string]))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'apply-list-spread',
    source:
      'export function Widget(){return <p>{String(Date.parse.apply(null,[...["2020-01-01T00:00"] as [string]]))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'Reflect-prefix-spread',
    source:
      'export function Widget(){return <p>{String(Reflect.apply(...[Date.parse,null,["2020-01-01T00:00"]] as [typeof Date.parse,null,[string]]))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'Reflect-target-alias',
    source:
      'export function Widget(){const parse=Date.parse;return <p>{String(Reflect.apply(parse,null,["2020-01-01T00:00"]))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'immediate-bind-runtime-input',
    source:
      'export function Widget(){return <p>{String(Date.parse.bind(null)("2020-01-01T00:00"))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'immediate-bind-fixed-input',
    source:
      'export function Widget(){return <p>{String(Date.parse.bind(null,"2020-01-01T00:00")())}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'saved-bind-input',
    source:
      'export function Widget(){const parse=Date.parse.bind(null,"2020-01-01T00:00");return <p>{String(parse())}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'saved-bind-alias-chain',
    source:
      'export function Widget(){const native=Date.parse.bind(null);const parse=native;const text="2020-01-01T00:00";return <p>{String(parse(text))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'bound-quiet-ignored-tail',
    source:
      'export function Widget(){return <p>{String((Date.parse.bind(null,"2020-01-01T00:00") as (...args:unknown[])=>number)(0))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'call-quiet-ignored-tail',
    source:
      'export function Widget(){return <p>{String((Date.parse as (...args:unknown[])=>number).call(null,"2020-01-01T00:00",0))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'apply-wrapper-ignored-tail',
    source:
      'export function Widget(){return <p>{String((Date.parse.apply as (...args:unknown[])=>number)(null,["2020-01-01T00:00"],0))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'Reflect-wrapper-ignored-tail',
    source:
      'export function Widget(){return <p>{String((Reflect.apply as (...args:unknown[])=>number)(Date.parse,null,["2020-01-01T00:00"],0))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'call-explicit-UTC',
    source:
      'export function Widget(){return <p>{String(Date.parse.call(null,"2020-01-01T00:00Z"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'apply-explicit-offset',
    source:
      'export function Widget(){return <p>{String(Date.parse.apply(null,["2020-01-01T00:00+02:00"]))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'Reflect-date-only',
    source:
      'export function Widget(){return <p>{String(Reflect.apply(Date.parse,null,["2020-01-01"]))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'bound-fixed-UTC',
    source:
      'export function Widget(){return <p>{String(Date.parse.bind(null,"2020-01-01T00:00Z")())}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'local-Date-shadow',
    source:
      'export function Widget(){const Date={parse:(_text:string)=>7};return <p>{String(Date.parse.call(null,"2020-01-01T00:00"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'local-Reflect-shadow',
    source:
      'export function Widget(){const Reflect={apply:(_target:unknown,_self:unknown,_args:unknown)=>7};return <p>{String(Reflect.apply(Date.parse,null,["2020-01-01T00:00"]))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'local-parser-call',
    source:
      'export function Widget(){const parse=(_text:string)=>7;return <p>{String(parse.call(null,"2020-01-01T00:00"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'replaced-parser-binding',
    source:
      'export function Widget(){let parse=Date.parse;parse=(_text:string)=>7;return <p>{String(parse.call(null,"2020-01-01T00:00"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'own-call-replacement',
    source:
      'export function Widget(){const parse=Date.parse;parse.call=()=>7;return <p>{String(parse.call(null,"2020-01-01T00:00"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'changed-apply-list',
    source:
      'export function Widget(){const args:[string]=["2020-01-01T00:00"];args[0]="2020-01-01T00:00Z";return <p>{String(Date.parse.apply(null,args))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'opaque-apply-list',
    source:
      'export function Widget(){function values():[string]{return ["2020-01-01T00:00Z"];}return <p>{String(Date.parse.apply(null,values()))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'prior-parser-replacement',
    source:
      'export function Widget(){function replace(){Date.parse=(_text:string)=>7;}replace();return <p>{String(Date.parse.call(null,"2020-01-01T00:00"))}</p>;}',
    input: false,
    private: true,
  },
  {
    id: 'event-only-borrowed-parse',
    source:
      'export function Widget(){return <button onClick={()=>{Date.parse.call(null,"2020-01-01T00:00");}}>fixed</button>;}',
    input: null,
    private: false,
  },
  {
    id: 'effect-only-borrowed-parse',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{Date.parse.call(null,"2020-01-01T00:00");},[]);return <p>fixed</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'defined-own-call-data',
    source:
      'export function Widget(){const parse=Date.parse;Object.defineProperty(parse,"call",{value:()=>7});return <p>{String(parse.call(null,"2020-01-01T00:00"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'defined-own-apply-data',
    source:
      'export function Widget(){const parse=Date.parse;Object.defineProperty(parse,"apply",{value:()=>7});return <p>{String(parse.apply(null,["2020-01-01T00:00"]))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'defined-own-bind-data',
    source:
      'export function Widget(){Object.defineProperty(Date.parse,"bind",{value:()=>()=>7});return <p>{String(Date.parse.bind(null,"2020-01-01T00:00")())}</p>;}',
    input: false,
    private: true,
  },
  {
    id: 'defined-Reflect-apply-data',
    source:
      'export function Widget(){Object.defineProperty(Reflect,"apply",{value:()=>7});return <p>{String(Reflect.apply(Date.parse,null,["2020-01-01T00:00"]))}</p>;}',
    input: false,
    private: true,
  },
] as const;

describe('borrowed Date parser readers', () => {
  it.each(CASES.filter((row) => row.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'borrowed-date-parser.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('borrowed Date parser route renders', () => {
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

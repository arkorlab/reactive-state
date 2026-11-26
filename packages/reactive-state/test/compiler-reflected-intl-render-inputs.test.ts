import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Reflected native formatter method reads retain the default locale or time zone a member read does. */
const CASES = [
  {
    id: 'reflected-number-format',
    source:
      'export function Widget(){return <p>{String(Reflect.get(new Intl.NumberFormat(),"format")(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'server-reflected-number-format',
    source:
      'export function Widget(){return <p>{String(Reflect.get(new Intl.NumberFormat(),"format")(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: false,
    reader: true,
  },
  {
    id: 'reflected-instance-alias',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat();return <p>{String(Reflect.get(formatter,"format")(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-whole-alias-chain',
    source:
      'export function Widget(){const original=new Intl.NumberFormat();const formatter=original;return <p>{String(Reflect.get(formatter,"format")(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-constructor-alias',
    source:
      'export function Widget(){const Formatter=Intl.NumberFormat;return <p>{String(Reflect.get(new Formatter(),"format")(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-constant-key',
    source:
      'export function Widget(){const key="format";return <p>{String(Reflect.get(new Intl.NumberFormat(),key)(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-get-alias',
    source:
      'export function Widget(){const get=Reflect.get;return <p>{String(get(new Intl.NumberFormat(),"format")(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-get-call',
    source:
      'export function Widget(){return <p>{String(Reflect.get.call(undefined,new Intl.NumberFormat(),"format")(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-get-apply',
    source:
      'export function Widget(){return <p>{String(Reflect.get.apply(undefined,[new Intl.NumberFormat(),"format"])(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflect-apply-get',
    source:
      'export function Widget(){return <p>{String(Reflect.apply(Reflect.get,undefined,[new Intl.NumberFormat(),"format"])(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-spread-arguments',
    source:
      'export function Widget(){return <p>{String(Reflect.get(...[new Intl.NumberFormat(),"format"] as const)(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-default-receiver',
    source:
      'export function Widget(){return <p>{String(Reflect.get(new Intl.NumberFormat("en-US"),"format",new Intl.NumberFormat())(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-stored-formatter',
    source:
      'export function Widget(){const holder={formatter:new Intl.NumberFormat()};return <p>{String(Reflect.get(holder.formatter,"format")(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-collator-compare',
    source:
      'export function Widget(){return <p>{String(Reflect.get(new Intl.Collator(),"compare")("a","b"))}</p>;}',
    input: 'Intl.Collator.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-date-default-zone',
    source:
      'export function Widget(){return <p>{String(Reflect.get(new Intl.DateTimeFormat("en-US"),"format")(0))}</p>;}',
    input: 'Intl.DateTimeFormat.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-segmenter-options',
    source:
      'export function Widget(){const formatter=new Intl.Segmenter();return <p>{String(Reflect.get(formatter,"resolvedOptions").call(formatter).locale)}</p>;}',
    input: 'Intl.Segmenter.locale',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-fixed-locale',
    source:
      'export function Widget(){return <p>{String(Reflect.get(new Intl.NumberFormat("en-US"),"format")(1234.5))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-fixed-receiver',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat("de-DE");return <p>{String(Reflect.get(formatter,"format",formatter)(1234.5))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-fixed-date-zone',
    source:
      'export function Widget(){return <p>{String(Reflect.get(new Intl.DateTimeFormat("en-US",{timeZone:"UTC"}),"format")(0))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-other-key',
    source:
      'export function Widget(){return <p>{String(typeof Reflect.get(new Intl.NumberFormat(),"toString"))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-symbol-key',
    source:
      'export function Widget(){return <p>{String(Reflect.get(new Intl.NumberFormat(),Symbol.toStringTag))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-unknown-key',
    source:
      'export function Widget({name}:{name:string}){return <p>{String(typeof Reflect.get(new Intl.NumberFormat(),name))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-unknown-arguments',
    source:
      'export function Widget({given}:{given:[object,string]}){return <p>{String(typeof Reflect.get(...given))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-ordinary-format',
    source:
      'export function Widget(){return <p>{String(Reflect.get({format:(_value:number)=>"fixed"},"format")(1234.5))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-own-literal-format',
    source:
      'export function Widget(){const formatter=new Intl.ListFormat();formatter.format=()=>"fixed";return <p>{String(Reflect.get(formatter,"format")())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'shadowed-reflect-format',
    source:
      'export function Widget(){const Reflect={get:(_target:unknown,_key:string)=>(_value:number)=>"fixed"};return <p>{String(Reflect.get(new Intl.NumberFormat(),"format")(1234.5))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'shadowed-intl-format',
    source:
      'export function Widget(){const Intl={NumberFormat:class{readonly format=(_value:number)=>"fixed";}};return <p>{String(Reflect.get(new Intl.NumberFormat(),"format")(1234.5))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-format-event-only',
    source:
      'export function Widget(){return <button onClick={()=>console.log(Reflect.get(new Intl.NumberFormat(),"format")(1234.5))}>fixed</button>;}',
    input: null,
    client: true,
    reader: false,
  },
  {
    id: 'reflected-format-effect-only',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{console.log(Reflect.get(new Intl.NumberFormat(),"format")(1234.5));},[]);return <p>fixed</p>;}',
    input: null,
    client: true,
    reader: false,
  },
] as const;

describe('reflected intl formatter readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-intl-reflections.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('reflected intl formatter route renders', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, input, client }) => {
    const app = await application({
      'controls/widget.tsx': client ? `'use client';\n${source}` : source,
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
    const expected = { refusals: [], shared: input === null, private: input !== null };

    expect(found).toStrictEqual(expected);
  });
});

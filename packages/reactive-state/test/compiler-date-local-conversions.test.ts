import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Captured parsing and native Date text conversions retain the render time zone. */
const CASES = [
  {
    id: 'reported-captured-parse',
    source:
      'export function Widget(){const parse=Date.parse;return <p>{String(parse("2020-01-01T00:00"))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'captured-parse-alias',
    source:
      'export function Widget(){const original=Date.parse;const parse=original;return <p>{String(parse("2020-01-01T00:00"))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'captured-parse-input-alias',
    source:
      'export function Widget(){const text="2020-01-01T00:00";const parse=Date.parse;return <p>{String(parse(text))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'captured-parse-assertion',
    source:
      'export function Widget(){const parse=(Date.parse as (text:string)=>number);return <p>{String(parse("2020-01-01T00:00"))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'captured-parse-globalThis',
    source:
      'export function Widget(){const parse=globalThis.Date.parse;return <p>{String(parse("2020-01-01T00:00"))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'captured-parse-quiet-ignored-tail',
    source:
      'export function Widget(){const parse=Date.parse as (...args:unknown[])=>number;return <p>{String(parse("2020-01-01T00:00",0))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'direct-parse-existing',
    source: 'export function Widget(){return <p>{String(Date.parse("2020-01-01T00:00"))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'captured-parse-destructuring-existing',
    source:
      'export function Widget(){const {parse}=Date;return <p>{String(parse("2020-01-01T00:00"))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'captured-parse-explicit-Z',
    source:
      'export function Widget(){const parse=Date.parse;return <p>{String(parse("2020-01-01T00:00Z"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'captured-parse-explicit-offset',
    source:
      'export function Widget(){const parse=Date.parse;return <p>{String(parse("2020-01-01T00:00+02:00"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'captured-parse-date-only',
    source:
      'export function Widget(){const parse=Date.parse;return <p>{String(parse("2020-01-01"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'captured-parse-unused',
    source: 'export function Widget(){const parse=Date.parse;void parse;return <p>{"fixed"}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'local-Date-parser',
    source:
      'export function Widget(){const Date={parse:(_text:string)=>7};const parse=Date.parse;return <p>{String(parse("2020-01-01T00:00"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'local-parser-function',
    source:
      'export function Widget(){const parse=(_text:string)=>7;return <p>{String(parse("2020-01-01T00:00"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'mutable-parser-replaced',
    source:
      'export function Widget(){let parse=Date.parse;parse=(_text:string)=>7;return <p>{String(parse("2020-01-01T00:00"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'parser-object-member-data',
    source:
      'export function Widget(){const box={parse:(_text:string)=>7};return <p>{String(box.parse("2020-01-01T00:00"))}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'reported-new-String-Date',
    source: 'export function Widget(){return <p>{new String(new Date(0)).valueOf()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'new-globalThis-String-Date',
    source:
      'export function Widget(){return <p>{new globalThis.String(new Date(0)).valueOf()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'new-String-constructor-alias',
    source:
      'export function Widget(){const Text=String;return <p>{new Text(new Date(0)).valueOf()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'new-String-stored-Date',
    source:
      'export function Widget(){const date=new Date(0);return <p>{new String(date).valueOf()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'new-String-stored-holder-Date',
    source:
      'export function Widget(){const box={date:new Date(0)};return <p>{new String(box.date).valueOf()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'new-String-fixed-ISO-Date',
    source:
      'export function Widget(){return <p>{new String(new Date("1970-01-01T00:00:00Z")).valueOf()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'new-String-quiet-ignored-tail',
    source:
      'export function Widget(){const Text=String as new(...args:unknown[])=>String;return <p>{new Text(new Date(0),0).valueOf()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'new-String-fixed-data',
    source: 'export function Widget(){return <p>{new String("fixed").valueOf()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'new-String-fixed-number',
    source: 'export function Widget(){return <p>{new String(0).valueOf()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'new-String-invalid-Date-range',
    source: 'export function Widget(){return <p>{new String(new Date(1e20)).valueOf()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'new-String-invalid-Date-ISO',
    source:
      'export function Widget(){return <p>{new String(new Date("2025-13-01T00:00:00Z")).valueOf()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'new-String-own-Date-text',
    source:
      'export function Widget(){const date=new Date(0);date.toString=()=>"fixed";return <p>{new String(date).valueOf()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'new-String-stored-own-Date-text',
    source:
      'export function Widget(){const box={date:new Date(0)};box.date.toString=()=>"fixed";return <p>{new String(box.date).valueOf()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'new-String-ignored-tail-rewrite',
    source:
      'export function Widget(){const date=new Date(0);const Text=String as new(...args:unknown[])=>String;return <p>{new Text(date,date.toString=()=>"fixed").valueOf()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'new-String-local-Date',
    source:
      'export function Widget(){class Date{constructor(_value:number){}toString(){return "fixed";}}return <p>{new String(new Date(0)).valueOf()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'new-String-local-constructor',
    source:
      'export function Widget(){class String{constructor(_value:unknown){}valueOf(){return "fixed";}}return <p>{new String(new Date(0)).valueOf()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'new-String-ISO-text',
    source:
      'export function Widget(){const date=new Date(0);return <p>{new String(date.toISOString()).valueOf()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'reported-array-Date-join',
    source: 'export function Widget(){return <p>{[new Date(0)].join("")}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'stored-array-Date-join',
    source: 'export function Widget(){const dates=[new Date(0)];return <p>{dates.join("")}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'aliased-array-Date-join',
    source:
      'export function Widget(){const original=[new Date(0)];const dates=original;return <p>{dates.join("")}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'nested-array-Date-join',
    source: 'export function Widget(){return <p>{[[new Date(0)]].join("")}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'stored-Date-array-join',
    source:
      'export function Widget(){const date=new Date(0);const dates=[date];return <p>{dates.join("")}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'mixed-primitive-Date-array-join',
    source:
      'export function Widget(){return <p>{["at:",new Date(0),null,undefined].join("")}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'computed-array-join',
    source: 'export function Widget(){return <p>{[new Date(0)]["join"]("")}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'array-Date-default-join',
    source: 'export function Widget(){return <p>{[new Date(0)].join()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'array-data-join',
    source: 'export function Widget(){return <p>{["a",0,"b"].join(":")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'empty-array-join',
    source: 'export function Widget(){return <p>{[].join("")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'array-own-join',
    source:
      'export function Widget(){const dates=[new Date(0)];dates.join=()=>"fixed";return <p>{dates.join("")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'array-own-Date-text',
    source:
      'export function Widget(){const date=new Date(0);date.toString=()=>"fixed";return <p>{[date].join("")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'array-element-replaced',
    source:
      'export function Widget(){const dates:[Date|string]=[new Date(0)];dates[0]="fixed";return <p>{dates.join("")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'array-local-Date',
    source:
      'export function Widget(){class Date{constructor(_value:number){}toString(){return "fixed";}}return <p>{[new Date(0)].join("")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'object-own-join',
    source:
      'export function Widget(){const dates={join:(_separator:string)=>"fixed"};return <p>{dates.join("")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'array-prior-part-rewrite',
    source:
      'export function Widget(){const date=new Date(0);const head={toString(){date.toString=()=>"fixed";return "";}};return <p>{[head,date].join("")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'array-separator-rewrite',
    source:
      'export function Widget(){const date=new Date(0);const separator={toString(){date.toString=()=>"fixed";return "";}};return <p>{[date].join(separator as never)}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'array-ignored-tail-rewrite',
    source:
      'export function Widget(){const date=new Date(0);const dates=[date];return <p>{(dates.join as (...args:unknown[])=>string)("",date.toString=()=>"fixed")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'array-invalid-Date',
    source: 'export function Widget(){return <p>{[new Date(1e20)].join("")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'array-ISO-text',
    source:
      'export function Widget(){const date=new Date(0);return <p>{[date.toISOString()].join("")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'captured-parse-prior-replacement',
    source:
      'export function Widget(){Date.parse=(_text:string)=>7;const parse=Date.parse;return <p>{String(parse("2020-01-01T00:00"))}</p>;}',
    input: false,
    private: true,
  },
  {
    id: 'captured-parse-prior-call-replacement',
    source:
      'export function Widget(){function replace(){Date.parse=(_text:string)=>7;}replace();const parse=Date.parse;return <p>{String(parse("2020-01-01T00:00"))}</p>;}',
    input: false,
    private: true,
  },
  {
    id: 'new-String-prior-call-own-Date',
    source:
      'export function Widget(){function prepare(){date.toString=()=>"fixed";}const date=new Date(0);prepare();return <p>{new String(date).valueOf()}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'new-String-captured-Date',
    source:
      'export function Widget(){const date=new Date(0);function text(prepare:()=>void){prepare();return new String(date).valueOf();}return <p>{text(()=>{date.toString=()=>"fixed";})}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'array-prior-call-own-Date',
    source:
      'export function Widget(){function prepare(){date.toString=()=>"fixed";}const date=new Date(0);prepare();return <p>{[date].join("")}</p>;}',
    input: false,
    private: false,
  },
  {
    id: 'array-captured-own-Date',
    source:
      'export function Widget(){const dates=[new Date(0)];function text(prepare:()=>void){prepare();return dates.join("");}return <p>{text(()=>{dates[0]!.toString=()=>"fixed";})}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'deferred-String-conversion',
    source:
      'export function Widget(){const unused=()=>new String(new Date(0)).valueOf();return <p>{"fixed"}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'deferred-array-conversion',
    source:
      'export function Widget(){const unused=()=>[new Date(0)].join("");return <p>{"fixed"}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'captured-parse-cross-owner-after-replacement',
    source:
      'export function Widget(){function replace(){Date.parse=(_text:string)=>7;}replace();const parse=Date.parse;function read(){return parse("2020-01-01T00:00");}return <p>{String(read())}</p>;}',
    input: false,
    private: true,
  },
  {
    id: 'event-only-String-conversion',
    source:
      'export function Widget(){return <button onClick={()=>{new String(new Date(0)).valueOf();}}>fixed</button>;}',
    input: null,
    private: false,
  },
  {
    id: 'effect-only-String-conversion',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{new String(new Date(0)).valueOf();},[]);return <p>fixed</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'event-only-array-conversion',
    source:
      'export function Widget(){return <button onClick={()=>{[new Date(0)].join("");}}>fixed</button>;}',
    input: null,
    private: false,
  },
  {
    id: 'effect-only-array-conversion',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{[new Date(0)].join("");},[]);return <p>fixed</p>;}',
    input: null,
    private: false,
  },
] as const;

describe('date local conversion readers', () => {
  it.each(CASES.filter((row) => row.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'date-local-conversions.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('date local conversion route renders', () => {
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

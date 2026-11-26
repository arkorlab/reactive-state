import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Stored native Date text retains its local-time input without changing ordinary data. */
const CASES = [
  {
    id: 'reported-object-String',
    source:
      'export function Widget(){const box={date:new Date(0)};return <p>{String(box.date)}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'array-String',
    source:
      'export function Widget(){const dates=[new Date(0)];return <p>{String(dates[0]!)}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'nested-object-array-String',
    source:
      'export function Widget(){const box={dates:[{at:new Date(0)}]};return <p>{String(box.dates[0]!.at)}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'literal-computed-key',
    source:
      'export function Widget(){const box={date:new Date(0)};return <p>{String(box["date"])}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'constant-computed-key',
    source:
      'export function Widget(){const key="date";const box={date:new Date(0)};return <p>{String(box[key])}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'whole-holder-alias',
    source:
      'export function Widget(){const original={date:new Date(0)};const box=original;return <p>{String(box.date)}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'date-constant-stored',
    source:
      'export function Widget(){const date=new Date(0);const box={date};return <p>{String(box.date)}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'template-stored-date',
    source: `export function Widget(){const box={date:new Date(0)};return <p>{\`date:\${box.date}\`}</p>;}`,
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'template-second-span',
    source: `export function Widget(){const box={date:new Date(0)};return <p>{\`\${"date"}:\${box.date}\`}</p>;}`,
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'addition-left-date',
    source: 'export function Widget(){const box={date:new Date(0)};return <p>{box.date+""}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'addition-right-date',
    source: 'export function Widget(){const box={date:new Date(0)};return <p>{""+box.date}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'immediate-object-date',
    source: 'export function Widget(){return <p>{String(({date:new Date(0)}).date)}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'immediate-array-date',
    source: 'export function Widget(){return <p>{String([new Date(0)][0]!)}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'plain-data-toString',
    source:
      'export function Widget(){const box={date:{toString:()=>"fixed"}};return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'local-Date-constructor',
    source:
      'export function Widget(){class Date{constructor(_value:number){}toString(){return "fixed";}}const box={date:new Date(0)};return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'own-date-toString-before-storage',
    source:
      'export function Widget(){const date=new Date(0);date.toString=()=>"fixed";const box={date};return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'stored-own-toString',
    source:
      'export function Widget(){const box={date:new Date(0)};box.date.toString=()=>"fixed";return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'stored-own-toPrimitive',
    source:
      'export function Widget(){const box={date:new Date(0)};Object.defineProperty(box.date,Symbol.toPrimitive,{value:()=>"fixed"});return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'holder-field-replaced',
    source:
      'export function Widget(){const box:{date:{toString:()=>string}}={date:new Date(0)};box.date={toString:()=>"fixed"};return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'holder-alias-own-replacement',
    source:
      'export function Widget(){const box={date:new Date(0)};const alias=box;alias.date.toString=()=>"fixed";return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'stored-getter-data',
    source:
      'export function Widget(){const box={get date(){return{toString:()=>"fixed"};}};return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'later-spread-data-field',
    source:
      'export function Widget(){const original={date:new Date(0)};const box={...original,date:{toString:()=>"fixed"}};return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'unselected-array-field',
    source:
      'export function Widget(){const dates=[new Date(0),{toString:()=>"fixed"}];return <p>{String(dates[1]!)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'mutable-holder-data',
    source:
      'export function Widget(){let box:{date:{toString:()=>string}}={date:new Date(0)};box={date:{toString:()=>"fixed"}};return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'shadowed-String',
    source:
      'export function Widget(){const String=(_value:unknown)=>"fixed";const box={date:new Date(0)};return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'numeric-date-conversion',
    source:
      'export function Widget(){const box={date:new Date(0)};return <p>{String(Number(box.date))}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'ISO-date-text',
    source:
      'export function Widget(){const box={date:new Date(0)};return <p>{box.date.toISOString()}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'String-ignored-tail-rewrite',
    source:
      'export function Widget(){const box={date:new Date(0)};return <p>{(String as(...args:unknown[])=>string)(box.date,box.date.toString=()=>"fixed")}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'binary-right-rewrite',
    source:
      'export function Widget(){const box={date:new Date(0)};return <p>{(box.date as never)+(box.date.toString=()=>"fixed","")}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'earlier-template-rewrite',
    source: `export function Widget(){const box={date:new Date(0)};return <p>{\`\${(box.date.toString=()=>"fixed","")}\${box.date}\`}</p>;}`,
    input: null,
    private: false,
  },
  {
    id: 'unknown-prefix-before-birth',
    source:
      'export function Widget(){function collect(prepare:()=>void){prepare();const box={date:new Date(0)};return String(box.date);}const old=Object.getOwnPropertyDescriptor(Date.prototype,"toString")!;try{return <p>{collect(()=>{Object.defineProperty(Date.prototype,"toString",{value:()=>"fixed",configurable:true});})}</p>;}finally{Object.defineProperty(Date.prototype,"toString",old);}}',
    input: 'Date',
    private: true,
  },
  {
    id: 'invalid-clipped-Date',
    source:
      'export function Widget(){const box={date:new Date(1e20)};return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'invalid-ISO-Date',
    source:
      'export function Widget(){const box={date:new Date("2025-13-01T00:00:00Z")};return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'invalid-undefined-Date',
    source:
      'export function Widget(){const box={date:new Date(undefined as never)};return <p>{String(box.date)}</p>;}',
    input: null,
    private: false,
  },
  {
    id: 'valid-fixed-ISO-Date',
    source:
      'export function Widget(){const box={date:new Date("1970-01-01T00:00:00Z")};return <p>{String(box.date)}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'quiet-ignored-String-tail',
    source:
      'export function Widget(){const box={date:new Date(0)};return <p>{(String as(...args:unknown[])=>string)(box.date,0)}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
  {
    id: 'stored-addition-assignment',
    source:
      'export function Widget(){const box:{date:Date|string}={date:new Date(0)};box.date+="";return <p>{box.date}</p>;}',
    input: 'Date.localTime',
    private: true,
  },
] as const;

describe('stored date text readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'stored-date-text.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('stored date text route renders', () => {
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

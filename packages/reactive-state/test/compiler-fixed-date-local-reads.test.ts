import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Fixed date instances retain local time-zone reads while UTC and data stay tracked. */
const CASES = [
  {
    id: 'fixed-hours',
    source: 'export function Widget(){return <p>{String(new Date(0).getHours())}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'fixed-year',
    source: 'export function Widget(){return <p>{String(new Date(0).getFullYear())}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'fixed-offset',
    source: 'export function Widget(){return <p>{String(new Date(0).getTimezoneOffset())}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'fixed-string',
    source: 'export function Widget(){return <p>{String(new Date(0).toString())}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'fixed-date-string',
    source: 'export function Widget(){return <p>{String(new Date(0).toDateString())}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'fixed-time-string',
    source: 'export function Widget(){return <p>{String(new Date(0).toTimeString())}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'fixed-localized-string',
    source:
      'export function Widget(){return <p>{String(new Date(0).toLocaleString("en-US"))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'constant-date-alias',
    source:
      'export function Widget(){const date=new Date(0);return <p>{String(date.getHours())}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'server-date-hours',
    source: 'export function Widget(){return <p>{String(new Date(0).getHours())}</p>;}',
    input: 'Date.localTime',
    client: false,
    reader: true,
  },
  {
    id: 'utc-hours',
    source: 'export function Widget(){return <p>{String(new Date(0).getUTCHours())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'utc-year',
    source: 'export function Widget(){return <p>{String(new Date(0).getUTCFullYear())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'epoch-time',
    source: 'export function Widget(){return <p>{String(new Date(0).getTime())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'iso-text',
    source: 'export function Widget(){return <p>{String(new Date(0).toISOString())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'epoch-value',
    source: 'export function Widget(){return <p>{String(new Date(0).valueOf())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'ordinary-method-data',
    source:
      'export function Widget(){const data={getHours:()=>7};return <p>{String(data.getHours())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'local-date-class-data',
    source:
      'export function Widget(){class Date{constructor(_value:number){}getHours(){return 7;}}return <p>{String(new Date(0).getHours())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'own-date-method-data',
    source:
      'export function Widget(){const date=new Date(0);date.getHours=()=>7;return <p>{String(date.getHours())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'destructured-hours',
    source:
      'export function Widget(){const date=new Date(0);const {getHours}=date;return <p>{String(getHours.call(date))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'renamed-destructured-hours',
    source:
      'export function Widget(){const date=new Date(0);const {getHours:hours}=date;return <p>{String(hours.call(date))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'computed-destructured-offset',
    source:
      'export function Widget(){const date=new Date(0);const {["getTimezoneOffset"]:offset}=date;return <p>{String(offset.call(date))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'constant-key-destructured-hours',
    source:
      'export function Widget(){const key="getHours";const date=new Date(0);const {[key]:hours}=date;return <p>{String(hours.call(date))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'fresh-destructured-string',
    source:
      'export function Widget(){const {toString:text}=new Date(0);return <p>{text.call(new Date(0))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'assigned-pattern-hours',
    source:
      'export function Widget(){const date=new Date(0);let hours=():number=>0;({getHours:hours}=date);return <p>{String(hours.call(date))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'nested-pattern-hours',
    source:
      'export function Widget(){const box={date:new Date(0)};const {date:{getHours}}=box;return <p>{String(getHours.call(box.date))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'default-target-over-date',
    source:
      'export function Widget(){let hours=():number=>0;({a:{getHours:hours}={getHours:()=>7}}={a:new Date(0)});return <p>{String(hours.call(new Date(0)))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'default-target-over-own-date',
    source:
      'export function Widget(){const own=new Date(0);own.getHours=()=>7;let hours=():number=>0;({a:{getHours:hours}=own}={a:new Date(0)});return <p>{String(hours.call(new Date(0)))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'pattern-default-date',
    source:
      'export function Widget(){const {a:{getHours}=new Date(0)}={} as {a?:Date};return <p>{String(getHours.call(new Date(0)))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'pattern-default-holder',
    source:
      'export function Widget(){const {a:{b:{getHours}}={b:new Date(0)}}={} as {a?:{b:Date}};return <p>{String(getHours.call(new Date(0)))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'default-target-date-default',
    source:
      'export function Widget({holder}:{holder:{a?:Date}}){let hours=():number=>0;({a:{getHours:hours}=new Date(0)}=holder);return <p>{String(hours.call(new Date(0)))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'default-target-plain-data',
    source:
      'export function Widget(){let hours=():number=>0;({a:{getHours:hours}={getHours:()=>7}}={a:{getHours:()=>8}});return <p>{String(hours())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'pattern-default-plain-data',
    source:
      'export function Widget(){const {a:{getHours}={getHours:()=>7}}={} as {a?:{getHours:()=>number}};return <p>{String(getHours())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'default-parameter-hours',
    source:
      'export function Widget(){const hourOf=({getHours}=new Date(0))=>getHours.call(new Date(0));return <p>{String(hourOf())}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'unknown-key-destructured',
    source:
      'export function Widget({name}:{name:string}){const date=new Date(0);const {[name]:read}=date;return <p>{String(read.call(date))}</p>;}',
    input: 'Date.localTime',
    client: true,
    reader: true,
  },
  {
    id: 'server-destructured-hours',
    source:
      'export function Widget(){const date=new Date(0);const {getHours}=date;return <p>{String(getHours.call(date))}</p>;}',
    input: 'Date.localTime',
    client: false,
    reader: true,
  },
  {
    id: 'destructured-utc-hours',
    source:
      'export function Widget(){const date=new Date(0);const {getUTCHours}=date;return <p>{String(getUTCHours.call(date))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'destructured-epoch-time',
    source:
      'export function Widget(){const date=new Date(0);const {getTime}=date;return <p>{String(getTime.call(date))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'destructured-epoch-value',
    source:
      'export function Widget(){const date=new Date(0);const {valueOf}=date;return <p>{String(valueOf.call(date))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'destructured-iso-text',
    source:
      'export function Widget(){const date=new Date(0);const {toISOString}=date;return <p>{toISOString.call(date)}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'assigned-pattern-utc-hours',
    source:
      'export function Widget(){const date=new Date(0);let hours=():number=>0;({getUTCHours:hours}=date);return <p>{String(hours.call(date))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'destructured-rest-data',
    source:
      'export function Widget(){const date=new Date(0);const {...rest}=date;return <p>{String(Object.keys(rest).length)}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'destructured-local-date-class-data',
    source:
      'export function Widget(){class Date{constructor(_value:number){}getHours(){return 7;}}const date=new Date(0);const {getHours}=date;return <p>{String(getHours.call(date))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'destructured-ordinary-method-data',
    source:
      'export function Widget(){const data={getHours:()=>7};const {getHours}=data;return <p>{String(getHours())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'destructured-own-date-method-data',
    source:
      'export function Widget(){const date=new Date(0);date.getHours=()=>7;const {getHours}=date;return <p>{String(getHours())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'event-only-local-date',
    source:
      'export function Widget(){return <button onClick={()=>console.log(new Date(0).getHours())}>fixed</button>;}',
    input: null,
    client: true,
    reader: false,
  },
  {
    id: 'event-only-destructured-date',
    source:
      'export function Widget(){return <button onClick={()=>{const {getHours}=new Date(0);console.log(getHours.call(new Date(0)));}}>fixed</button>;}',
    input: null,
    client: true,
    reader: false,
  },
  {
    id: 'effect-only-local-date',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{console.log(new Date(0).toString());},[]);return <p>fixed</p>;}',
    input: null,
    client: true,
    reader: false,
  },
] as const;

describe('fixed date local-time readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'fixed-local-date.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('fixed date local-time route renders', () => {
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

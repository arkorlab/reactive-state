import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

const LOCAL_TIME = 'Date.localTime';

/** A rendered date made or parsed in the runtime's time zone is an input as a shared module's is. */
const CASES = [
  {
    id: 'local-components-time',
    source: 'export function Widget(){return <p>{String(new Date(2020,0,1).getTime())}</p>;}',
    input: LOCAL_TIME,
    client: true,
    reader: true,
  },
  {
    id: 'server-local-components-time',
    source: 'export function Widget(){return <p>{String(new Date(2020,0,1).getTime())}</p>;}',
    input: LOCAL_TIME,
    client: false,
    reader: true,
  },
  {
    id: 'local-components-iso',
    source: 'export function Widget(){return <p>{new Date(2020,0,1).toISOString()}</p>;}',
    input: LOCAL_TIME,
    client: true,
    reader: true,
  },
  {
    id: 'local-components-utc-hours',
    source: 'export function Widget(){return <p>{String(new Date(2020,0,1).getUTCHours())}</p>;}',
    input: LOCAL_TIME,
    client: true,
    reader: true,
  },
  {
    id: 'local-text-time',
    source:
      'export function Widget(){return <p>{String(new Date("2020-01-01T00:00").getTime())}</p>;}',
    input: LOCAL_TIME,
    client: true,
    reader: true,
  },
  {
    id: 'local-text-constant',
    source:
      'export function Widget(){const text="2020-01-01T00:00:00";return <p>{String(new Date(text).getTime())}</p>;}',
    input: LOCAL_TIME,
    client: true,
    reader: true,
  },
  {
    id: 'legacy-text-time',
    source: 'export function Widget(){return <p>{String(new Date("Jan 1 2020").getTime())}</p>;}',
    input: LOCAL_TIME,
    client: true,
    reader: true,
  },
  {
    id: 'unknown-text-time',
    source:
      'export function Widget({text}:{text:string}){return <p>{String(new Date(text).getTime())}</p>;}',
    input: LOCAL_TIME,
    client: true,
    reader: true,
  },
  {
    id: 'parsed-local-text',
    source: 'export function Widget(){return <p>{String(Date.parse("2020-01-01T00:00"))}</p>;}',
    input: LOCAL_TIME,
    client: true,
    reader: true,
  },
  {
    id: 'parsed-unknown-text',
    source:
      'export function Widget({text}:{text:string}){return <p>{String(Date.parse(text))}</p>;}',
    input: LOCAL_TIME,
    client: true,
    reader: true,
  },
  {
    id: 'clock-construction',
    source: 'export function Widget(){return <p>{String(new Date().getTime())}</p>;}',
    input: 'Date',
    client: true,
    reader: true,
  },
  {
    id: 'spread-construction',
    source:
      'export function Widget(){return <p>{String(new Date(...([2020,0,1] as const)).getTime())}</p>;}',
    input: 'Date',
    client: true,
    reader: true,
  },
  {
    id: 'utc-components-time',
    source:
      'export function Widget(){return <p>{String(new Date(Date.UTC(2020,0,1)).getTime())}</p>;}',
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
    id: 'zoned-text-time',
    source:
      'export function Widget(){return <p>{String(new Date("2020-01-01T00:00:00Z").getTime())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'offset-text-time',
    source:
      'export function Widget(){return <p>{String(new Date("2020-01-01T00:00:00+09:00").getTime())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'date-only-text-time',
    source: 'export function Widget(){return <p>{String(new Date("2020-01-01").getTime())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'parsed-zoned-text',
    source: 'export function Widget(){return <p>{String(Date.parse("2020-01-01T00:00:00Z"))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'utc-components',
    source: 'export function Widget(){return <p>{String(Date.UTC(2020,0,1))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'number-parameter-time',
    source:
      'export function Widget(){const at=(value:number)=>new Date(value).getTime();return <p>{String(at(0))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'shadowed-date-components',
    source:
      'export function Widget(){class Date{constructor(..._parts:number[]){}getTime(){return 7;}}return <p>{String(new Date(2020,0,1).getTime())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'local-components-event-only',
    source:
      'export function Widget(){return <button onClick={()=>console.log(new Date(2020,0,1).getTime())}>fixed</button>;}',
    input: null,
    client: true,
    reader: false,
  },
  {
    id: 'local-components-effect-only',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{console.log(new Date(2020,0,1).getTime());},[]);return <p>fixed</p>;}',
    input: null,
    client: true,
    reader: false,
  },
] as const;

describe('local date construction readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-local-date.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('local date construction route renders', () => {
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

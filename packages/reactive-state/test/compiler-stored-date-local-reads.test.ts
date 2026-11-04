import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Stable stored Date selections retain local time-zone inputs and own data boundaries. */
const CASES = [
  {
    id: 'stored-object-hours',
    source:
      'export function Widget(){const box={date:new Date(0)};return <p>{String(box.date.getHours())}</p>;}',
    runtime: 'function probe(){const box={date:new Date(0)};return String(box.date.getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'stored-array-hours',
    source:
      'export function Widget(){const box=[new Date(0)];return <p>{String(box[0]!.getHours())}</p>;}',
    runtime: 'function probe(){const box=[new Date(0)];return String(box[0]!.getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'stored-nested-path',
    source:
      'export function Widget(){const box={dates:[{at:new Date(0)}]};return <p>{String(box.dates[0]!.at.getHours())}</p>;}',
    runtime:
      'function probe(){const box={dates:[{at:new Date(0)}]};return String(box.dates[0]!.at.getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'stored-computed-literal',
    source:
      'export function Widget(){const box={["date"]:new Date(0)};return <p>{String(box["date"].getHours())}</p>;}',
    runtime:
      'function probe(){const box={["date"]:new Date(0)};return String(box["date"].getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'stored-computed-constant',
    source:
      'export function Widget(){const key="date";const box={date:new Date(0)};return <p>{String(box[key].getHours())}</p>;}',
    runtime:
      'function probe(){const key="date";const box={date:new Date(0)};return String(box[key].getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'stored-holder-alias',
    source:
      'export function Widget(){const original={date:new Date(0)};const box=original;return <p>{String(box.date.getHours())}</p>;}',
    runtime:
      'function probe(){const original={date:new Date(0)};const box=original;return String(box.date.getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'stored-date-alias',
    source:
      'export function Widget(){const date=new Date(0);const box={date};return <p>{String(box.date.getHours())}</p>;}',
    runtime:
      'function probe(){const date=new Date(0);const box={date};return String(box.date.getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'destructured-object-date',
    source:
      'export function Widget(){const {date}={date:new Date(0)};return <p>{String(date.getHours())}</p>;}',
    runtime: 'function probe(){const {date}={date:new Date(0)};return String(date.getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'destructured-renamed-date',
    source:
      'export function Widget(){const box={date:new Date(0)};const {date:when}=box;return <p>{String(when.getHours())}</p>;}',
    runtime:
      'function probe(){const box={date:new Date(0)};const {date:when}=box;return String(when.getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'destructured-array-date',
    source:
      'export function Widget(){const [date]=[new Date(0)];return <p>{String(date!.getHours())}</p>;}',
    runtime: 'function probe(){const [date]=[new Date(0)];return String(date!.getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'destructured-nested-date',
    source:
      'export function Widget(){const {dates:[date]}={dates:[new Date(0)]};return <p>{String(date!.getHours())}</p>;}',
    runtime:
      'function probe(){const {dates:[date]}={dates:[new Date(0)]};return String(date!.getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'immediate-object-date',
    source:
      'export function Widget(){return <p>{String(({date:new Date(0)}).date.getHours())}</p>;}',
    runtime: 'function probe(){return String(({date:new Date(0)}).date.getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'immediate-array-date',
    source: 'export function Widget(){return <p>{String([new Date(0)][0]!.getHours())}</p>;}',
    runtime: 'function probe(){return String([new Date(0)][0]!.getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'reflected-stored-date',
    source:
      'export function Widget(){const box={date:new Date(0)};return <p>{String(Reflect.get(box.date,"getHours").call(box.date))}</p>;}',
    runtime:
      'function probe(){const box={date:new Date(0)};return String(Reflect.get(box.date,"getHours").call(box.date));}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'stored-date-offset',
    source:
      'export function Widget(){const box={date:new Date(0)};return <p>{String(box.date.getTimezoneOffset())}</p>;}',
    runtime:
      'function probe(){const box={date:new Date(0)};return String(box.date.getTimezoneOffset());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'direct-date-native-pin',
    source:
      'export function Widget(){const date=new Date(0);return <p>{String(date.getHours())}</p>;}',
    runtime: 'function probe(){const date=new Date(0);return String(date.getHours());}',
    input: 'Date.localTime',
    reader: true,
    client: true,
    alreadyPassing: true,
  },
  {
    id: 'stored-utc-data',
    source:
      'export function Widget(){const box={date:new Date(0)};return <p>{String(box.date.getUTCHours())}</p>;}',
    runtime:
      'function probe(){const box={date:new Date(0)};return String(box.date.getUTCHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'stored-epoch-data',
    source:
      'export function Widget(){const box=[new Date(0)];return <p>{String(box[0]!.getTime())}</p>;}',
    runtime: 'function probe(){const box=[new Date(0)];return String(box[0]!.getTime());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'stored-iso-data',
    source:
      'export function Widget(){const {date}={date:new Date(0)};return <p>{String(date.toISOString())}</p>;}',
    runtime: 'function probe(){const {date}={date:new Date(0)};return String(date.toISOString());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'stored-ordinary-method-data',
    source:
      'export function Widget(){const box={date:{getHours:()=>7}};return <p>{String(box.date.getHours())}</p>;}',
    runtime:
      'function probe(){const box={date:{getHours:()=>7}};return String(box.date.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'stored-lexical-date-shadow-data',
    source:
      'export function Widget(){class Date{constructor(_value:number){}getHours(){return 7;}}const box={date:new Date(0)};return <p>{String(box.date.getHours())}</p>;}',
    runtime:
      'function probe(){class Date{constructor(_value:number){}getHours(){return 7;}}const box={date:new Date(0)};return String(box.date.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'own-date-before-storage-data',
    source:
      'export function Widget(){const date=new Date(0);date.getHours=()=>7;const box={date};return <p>{String(box.date.getHours())}</p>;}',
    runtime:
      'function probe(){const date=new Date(0);date.getHours=()=>7;const box={date};return String(box.date.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'own-date-through-holder-data',
    source:
      'export function Widget(){const box={date:new Date(0)};box.date.getHours=()=>7;return <p>{String(box.date.getHours())}</p>;}',
    runtime:
      'function probe(){const box={date:new Date(0)};box.date.getHours=()=>7;return String(box.date.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'replaced-holder-field-data',
    source:
      'export function Widget(){const box:{date:Pick<Date,"getHours">}={date:new Date(0)};box.date={getHours:()=>7};return <p>{String(box.date.getHours())}</p>;}',
    runtime:
      'function probe(){const box:{date:Pick<Date,"getHours">}={date:new Date(0)};box.date={getHours:()=>7};return String(box.date.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'rebound-holder-data',
    source:
      'export function Widget(){let box:{date:Pick<Date,"getHours">}={date:new Date(0)};box={date:{getHours:()=>7}};return <p>{String(box.date.getHours())}</p>;}',
    runtime:
      'function probe(){let box:{date:Pick<Date,"getHours">}={date:new Date(0)};box={date:{getHours:()=>7}};return String(box.date.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'projected-own-method-data',
    source:
      'export function Widget(){const box={date:new Date(0)};const date=box.date;date.getHours=()=>7;return <p>{String(date.getHours())}</p>;}',
    runtime:
      'function probe(){const box={date:new Date(0)};const date=box.date;date.getHours=()=>7;return String(date.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'captured-holder-own-method-data',
    source:
      'export function Widget(){const box={date:new Date(0)};function read(){return box.date.getHours();}box.date.getHours=()=>7;return <p>{String(read())}</p>;}',
    runtime:
      'function probe(){const box={date:new Date(0)};function read(){return box.date.getHours();}box.date.getHours=()=>7;return String(read());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'stored-getter-data',
    source:
      'export function Widget(){const box={get date(){return {getHours:()=>7};}};return <p>{String(box.date.getHours())}</p>;}',
    runtime:
      'function probe(){const box={get date(){return {getHours:()=>7};}};return String(box.date.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'spread-replaced-date-data',
    source:
      'export function Widget(){const original={date:new Date(0)};const box={...original,date:{getHours:()=>7}};return <p>{String(box.date.getHours())}</p>;}',
    runtime:
      'function probe(){const original={date:new Date(0)};const box={...original,date:{getHours:()=>7}};return String(box.date.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'unselected-array-date-data',
    source:
      'export function Widget(){const box=[new Date(0),{getHours:()=>7}];return <p>{String(box[1]!.getHours())}</p>;}',
    runtime:
      'function probe(){const box=[new Date(0),{getHours:()=>7}];return String(box[1]!.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'mutable-computed-key-data',
    source:
      'export function Widget(){const box={date:new Date(0),fixed:{getHours:()=>7}};let key:"date"|"fixed"="date";key="fixed";return <p>{String(box[key].getHours())}</p>;}',
    runtime:
      'function probe(){const box={date:new Date(0),fixed:{getHours:()=>7}};let key:"date"|"fixed"="date";key="fixed";return String(box[key].getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'destructure-default-data',
    source:
      'export function Widget(){const {date={getHours:()=>7}}:{}&{date?:Pick<Date,"getHours">}={};return <p>{String(date.getHours())}</p>;}',
    runtime:
      'function probe(){const {date={getHours:()=>7}}:{}&{date?:Pick<Date,"getHours">}={};return String(date.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'destructure-prior-getter-data',
    source:
      'export function Widget(){const box={date:new Date(0),get other(){this.date.getHours=()=>7;return 0;}};const {date,other}=box;void other;return <p>{String(date.getHours())}</p>;}',
    runtime:
      'function probe(){const box={date:new Date(0),get other(){this.date.getHours=()=>7;return 0;}};const {date,other}=box;void other;return String(date.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'destructure-prior-iterator-data',
    source:
      'export function Widget(){const dates=[new Date(0)];dates[Symbol.iterator]=function(){const date=new Date(0);date.getHours=()=>7;return [date][Symbol.iterator]();};const [date]=dates;return <p>{String(date!.getHours())}</p>;}',
    runtime:
      'function probe(){const dates=[new Date(0)];dates[Symbol.iterator]=function(){const date=new Date(0);date.getHours=()=>7;return [date][Symbol.iterator]();};const [date]=dates;return String(date!.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: false,
  },
  {
    id: 'direct-own-date-literal-pin',
    source:
      'export function Widget(){const date=new Date(0);date.getHours=()=>7;return <p>{String(date.getHours())}</p>;}',
    runtime:
      'function probe(){const date=new Date(0);date.getHours=()=>7;return String(date.getHours());}',
    input: null,
    reader: true,
    client: true,
    alreadyPassing: true,
  },
] as const;

describe('stored date local-time readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'fixed-local-date.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('stored date local-time route renders', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, input }) => {
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
    const expected = { refusals: [], shared: input === null, private: input !== null };

    expect(found).toStrictEqual(expected);
  });
});

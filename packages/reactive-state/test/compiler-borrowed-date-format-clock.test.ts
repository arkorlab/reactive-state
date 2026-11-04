import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Borrowed native date formatter methods retain the actual receiver and consumed date. */
const CASES = [
  {
    id: 'borrowed-call-no-date',
    source:
      'export function Widget(){return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"}))))}</p>;}',
    runtime:
      'function probe(){return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"}))));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-call-native-undefined',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter,undefined)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter,undefined)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-call-void',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter,void 0)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter,void 0)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-call-undefined-alias',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const empty=undefined;const date=empty;return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter,date)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const empty=undefined;const date=empty;return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter,date)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-apply-empty',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.apply(formatter,[])))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.apply(formatter,[])));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-apply-omitted',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.apply(formatter)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.apply(formatter)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-apply-undefined',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify((Intl.DateTimeFormat.prototype.formatToParts.apply as (...args:unknown[])=>Intl.DateTimeFormatPart[])(formatter,undefined)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify((Intl.DateTimeFormat.prototype.formatToParts.apply as (...args:unknown[])=>Intl.DateTimeFormatPart[])(formatter,undefined)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-apply-null',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify((Intl.DateTimeFormat.prototype.formatToParts.apply as (...args:unknown[])=>Intl.DateTimeFormatPart[])(formatter,null)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify((Intl.DateTimeFormat.prototype.formatToParts.apply as (...args:unknown[])=>Intl.DateTimeFormatPart[])(formatter,null)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-reflect-empty',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Reflect.apply(Intl.DateTimeFormat.prototype.formatToParts,formatter,[])))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Reflect.apply(Intl.DateTimeFormat.prototype.formatToParts,formatter,[])));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-call-argument-spread',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(...([formatter,undefined] as const))))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(...([formatter,undefined] as const))));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-apply-list-spread',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.apply(formatter,[...([] as const)])))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.apply(formatter,[...([] as const)])));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-method-alias',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const parts=Intl.DateTimeFormat.prototype.formatToParts;return <p>{String(JSON.stringify(parts.call(formatter)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const parts=Intl.DateTimeFormat.prototype.formatToParts;return String(JSON.stringify(parts.call(formatter)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-whole-receiver-alias',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const alias=formatter;return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(alias)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const alias=formatter;return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(alias)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-constructor-alias',
    source:
      'export function Widget(){const Format=Intl.DateTimeFormat;const formatter=new Format("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter)))}</p>;}',
    runtime:
      'function probe(){const Format=Intl.DateTimeFormat;const formatter=new Format("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-stored-object',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(box.formatter)))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(box.formatter)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-stored-array',
    source:
      'export function Widget(){const box=[new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})];return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(box[0]!)))}</p>;}',
    runtime:
      'function probe(){const box=[new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})];return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(box[0]!)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-server-clock',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: false,
    reader: true,
  },
  {
    id: 'borrowed-explicit-call-date',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter,0)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter,0)));}',
    input: null,
    native: 'parts-epoch',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-explicit-apply-date',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.apply(formatter,[0])))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.apply(formatter,[0])));}',
    input: null,
    native: 'parts-epoch',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-explicit-reflect-date',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Reflect.apply(Intl.DateTimeFormat.prototype.formatToParts,formatter,[0])))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Reflect.apply(Intl.DateTimeFormat.prototype.formatToParts,formatter,[0])));}',
    input: null,
    native: 'parts-epoch',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-explicit-spread-date',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(...([formatter,0] as const))))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(...([formatter,0] as const))));}',
    input: null,
    native: 'parts-epoch',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-written-date-alias',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const date=0;return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter,date)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const date=0;return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter,date)));}',
    input: null,
    native: 'parts-epoch',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-shadow-undefined',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const undefined=0;return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter,undefined)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const undefined=0;return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter,undefined)));}',
    input: null,
    native: 'parts-epoch',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-fixed-range',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatRangeToParts.call(formatter,0,1000)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatRangeToParts.call(formatter,0,1000)));}',
    input: null,
    native: 'range-epoch',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-fixed-resolved-options',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.resolvedOptions.call(formatter).timeZone))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(Intl.DateTimeFormat.prototype.resolvedOptions.call(formatter).timeZone));}',
    input: null,
    native: 'zone',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-unrelated-number',
    source:
      'export function Widget(){return <p>{String(JSON.stringify(Intl.NumberFormat.prototype.formatToParts.call(new Intl.NumberFormat("en-US"),0)))}</p>;}',
    runtime:
      'function probe(){return String(JSON.stringify(Intl.NumberFormat.prototype.formatToParts.call(new Intl.NumberFormat("en-US"),0)));}',
    input: null,
    native: 'number-zero',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-own-call-override',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const parts=Intl.DateTimeFormat.prototype.formatToParts;Object.defineProperty(parts,"call",{value:()=>[{type:"literal",value:"fixed"}]});return <p>{String(JSON.stringify(parts.call(formatter)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const parts=Intl.DateTimeFormat.prototype.formatToParts;Object.defineProperty(parts,"call",{value:()=>[{type:"literal",value:"fixed"}]});return String(JSON.stringify(parts.call(formatter)));}',
    input: null,
    native: 'fixed-parts',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-own-apply-override',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const parts=Intl.DateTimeFormat.prototype.formatToParts;Object.defineProperty(parts,"apply",{value:()=>[{type:"literal",value:"fixed"}]});return <p>{String(JSON.stringify(parts.apply(formatter,[])))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const parts=Intl.DateTimeFormat.prototype.formatToParts;Object.defineProperty(parts,"apply",{value:()=>[{type:"literal",value:"fixed"}]});return String(JSON.stringify(parts.apply(formatter,[])));}',
    input: null,
    native: 'fixed-parts',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-local-intl',
    source:
      'export function Widget(){const Intl={DateTimeFormat:class{formatToParts(){return[{type:"literal",value:"fixed"}];}}};const formatter=new Intl.DateTimeFormat();return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter)))}</p>;}',
    runtime:
      'function probe(){const Intl={DateTimeFormat:class{formatToParts(){return[{type:"literal",value:"fixed"}];}}};const formatter=new Intl.DateTimeFormat();return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.call(formatter)));}',
    input: null,
    native: 'fixed-parts',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-local-reflect',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const Reflect={apply:(_target:unknown,_receiver:unknown,_args:unknown[])=>[{type:"literal",value:"fixed"}]};return <p>{String(JSON.stringify(Reflect.apply(Intl.DateTimeFormat.prototype.formatToParts,formatter,[])))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const Reflect={apply:(_target:unknown,_receiver:unknown,_args:unknown[])=>[{type:"literal",value:"fixed"}]};return String(JSON.stringify(Reflect.apply(Intl.DateTimeFormat.prototype.formatToParts,formatter,[])));}',
    input: null,
    native: 'fixed-parts',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-ordinary-callable',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const parts=()=>[{type:"literal",value:"fixed"}];return <p>{String(JSON.stringify(parts.call(formatter)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const parts=()=>[{type:"literal",value:"fixed"}];return String(JSON.stringify(parts.call(formatter)));}',
    input: null,
    native: 'fixed-parts',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-ignored-apply-tail',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const dates:[number|undefined]=[undefined];return <p>{String(JSON.stringify((Intl.DateTimeFormat.prototype.formatToParts.apply as (...args:unknown[])=>Intl.DateTimeFormatPart[])(formatter,dates,Object.assign(dates,{0:0}))))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const dates:[number|undefined]=[undefined];return String(JSON.stringify((Intl.DateTimeFormat.prototype.formatToParts.apply as (...args:unknown[])=>Intl.DateTimeFormatPart[])(formatter,dates,Object.assign(dates,{0:0}))));}',
    input: null,
    native: 'parts-epoch',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-event-only',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <button onClick={()=>console.log(Intl.DateTimeFormat.prototype.formatToParts.call(formatter))}>fixed</button>;}',
    runtime: 'function probe(){return"fixed";}',
    input: null,
    native: 'raw-fixed',
    client: true,
    reader: false,
  },
  {
    id: 'borrowed-effect-only',
    source:
      'import{useEffect}from"react";export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});useEffect(()=>{console.log(Intl.DateTimeFormat.prototype.formatToParts.call(formatter));},[]);return <p>fixed</p>;}',
    runtime: 'function probe(){return"fixed";}',
    input: null,
    native: 'raw-fixed',
    client: true,
    reader: false,
  },
] as const;

describe('borrowed date format clock readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-borrowed-date-clock.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('borrowed date format clock route renders', () => {
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

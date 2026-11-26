import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A date format's `format` a reflective read takes off it formats the time it is called at. */
const CASES = [
  {
    id: 'borrowed-number-call',
    source:
      'export function Widget(){return <p>{String(Intl.NumberFormat.prototype.resolvedOptions.call(new Intl.NumberFormat()).locale)}</p>;}',
    runtime:
      'function probe(){return String(Intl.NumberFormat.prototype.resolvedOptions.call(new Intl.NumberFormat()).locale);}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-number-apply',
    source:
      'export function Widget(){return <p>{String(Intl.NumberFormat.prototype.resolvedOptions.apply(new Intl.NumberFormat(),[]).locale)}</p>;}',
    runtime:
      'function probe(){return String(Intl.NumberFormat.prototype.resolvedOptions.apply(new Intl.NumberFormat(),[]).locale);}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-number-reflect',
    source:
      'export function Widget(){return <p>{String(Reflect.apply(Intl.NumberFormat.prototype.resolvedOptions,new Intl.NumberFormat(),[]).locale)}</p>;}',
    runtime:
      'function probe(){return String(Reflect.apply(Intl.NumberFormat.prototype.resolvedOptions,new Intl.NumberFormat(),[]).locale);}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-native-alias',
    source:
      'export function Widget(){const read=Intl.NumberFormat.prototype.resolvedOptions;return <p>{String(read.call(new Intl.NumberFormat()).locale)}</p>;}',
    runtime:
      'function probe(){const read=Intl.NumberFormat.prototype.resolvedOptions;return String(read.call(new Intl.NumberFormat()).locale);}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-native-alias-chain',
    source:
      'export function Widget(){const first=Intl.NumberFormat.prototype.resolvedOptions;const read=first;return <p>{String(read.call(new Intl.NumberFormat()).locale)}</p>;}',
    runtime:
      'function probe(){const first=Intl.NumberFormat.prototype.resolvedOptions;const read=first;return String(read.call(new Intl.NumberFormat()).locale);}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-computed-method',
    source:
      "export function Widget(){return <p>{String(Intl['NumberFormat'].prototype['resolvedOptions']['call'](new Intl.NumberFormat()).locale)}</p>;}",
    runtime:
      "function probe(){return String(Intl['NumberFormat'].prototype['resolvedOptions']['call'](new Intl.NumberFormat()).locale);}",
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-instance-alias',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat();return <p>{String(Intl.NumberFormat.prototype.resolvedOptions.call(formatter).locale)}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.NumberFormat();return String(Intl.NumberFormat.prototype.resolvedOptions.call(formatter).locale);}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-stored-receiver',
    source:
      'export function Widget(){const box={formatter:new Intl.NumberFormat()};return <p>{String(Intl.NumberFormat.prototype.resolvedOptions.call(box.formatter).locale)}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.NumberFormat()};return String(Intl.NumberFormat.prototype.resolvedOptions.call(box.formatter).locale);}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-this-spread',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat();return <p>{String(Intl.NumberFormat.prototype.resolvedOptions.call(...([formatter]as const)).locale)}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.NumberFormat();return String(Intl.NumberFormat.prototype.resolvedOptions.call(...([formatter]as const)).locale);}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-constructor-alias',
    source:
      'export function Widget(){const Formatter=Intl.NumberFormat;return <p>{String(Intl.NumberFormat.prototype.resolvedOptions.call(new Formatter()).locale)}</p>;}',
    runtime:
      'function probe(){const Formatter=Intl.NumberFormat;return String(Intl.NumberFormat.prototype.resolvedOptions.call(new Formatter()).locale);}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-date-call',
    source:
      'export function Widget(){return <p>{String(Intl.DateTimeFormat.prototype.resolvedOptions.call(new Intl.DateTimeFormat(undefined,{timeZone:"UTC"})).locale)}</p>;}',
    runtime:
      'function probe(){return String(Intl.DateTimeFormat.prototype.resolvedOptions.call(new Intl.DateTimeFormat(undefined,{timeZone:"UTC"})).locale);}',
    input: 'Intl.DateTimeFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-collator-call',
    source:
      'export function Widget(){return <p>{String(Intl.Collator.prototype.resolvedOptions.call(new Intl.Collator()).locale)}</p>;}',
    runtime:
      'function probe(){return String(Intl.Collator.prototype.resolvedOptions.call(new Intl.Collator()).locale);}',
    input: 'Intl.Collator.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-relative-call',
    source:
      'export function Widget(){return <p>{String(Intl.RelativeTimeFormat.prototype.resolvedOptions.call(new Intl.RelativeTimeFormat()).locale)}</p>;}',
    runtime:
      'function probe(){return String(Intl.RelativeTimeFormat.prototype.resolvedOptions.call(new Intl.RelativeTimeFormat()).locale);}',
    input: 'Intl.RelativeTimeFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-list-call',
    source:
      'export function Widget(){return <p>{String(Intl.ListFormat.prototype.resolvedOptions.call(new Intl.ListFormat()).locale)}</p>;}',
    runtime:
      'function probe(){return String(Intl.ListFormat.prototype.resolvedOptions.call(new Intl.ListFormat()).locale);}',
    input: 'Intl.ListFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-plural-call',
    source:
      'export function Widget(){return <p>{String(Intl.PluralRules.prototype.resolvedOptions.call(new Intl.PluralRules()).locale)}</p>;}',
    runtime:
      'function probe(){return String(Intl.PluralRules.prototype.resolvedOptions.call(new Intl.PluralRules()).locale);}',
    input: 'Intl.PluralRules.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-display-call',
    source:
      'export function Widget(){return <p>{String(Intl.DisplayNames.prototype.resolvedOptions.call(new Intl.DisplayNames(undefined,{type:"region"})).locale)}</p>;}',
    runtime:
      'function probe(){return String(Intl.DisplayNames.prototype.resolvedOptions.call(new Intl.DisplayNames(undefined,{type:"region"})).locale);}',
    input: 'Intl.DisplayNames.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-segmenter-call',
    source:
      'export function Widget(){return <p>{String(Intl.Segmenter.prototype.resolvedOptions.call(new Intl.Segmenter()).locale)}</p>;}',
    runtime:
      'function probe(){return String(Intl.Segmenter.prototype.resolvedOptions.call(new Intl.Segmenter()).locale);}',
    input: 'Intl.Segmenter.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-fixed-number',
    source:
      'export function Widget(){return <p>{String(Intl.NumberFormat.prototype.resolvedOptions.call(new Intl.NumberFormat("en-US")).locale)}</p>;}',
    runtime:
      'function probe(){return String(Intl.NumberFormat.prototype.resolvedOptions.call(new Intl.NumberFormat("en-US")).locale);}',
    input: null,
    client: true,
    reader: true,
    nativeData: 'en-US',
  },
  {
    id: 'borrowed-fixed-date',
    source:
      'export function Widget(){return <p>{String(Intl.DateTimeFormat.prototype.resolvedOptions.call(new Intl.DateTimeFormat("en-US",{timeZone:"UTC"})).locale)}</p>;}',
    runtime:
      'function probe(){return String(Intl.DateTimeFormat.prototype.resolvedOptions.call(new Intl.DateTimeFormat("en-US",{timeZone:"UTC"})).locale);}',
    input: null,
    client: true,
    reader: true,
    nativeData: 'en-US',
  },
  {
    id: 'borrowed-own-call',
    source:
      'export function Widget(){const read=Intl.NumberFormat.prototype.resolvedOptions;Object.defineProperty(read,"call",{value:()=>({locale:"fixed"})});return <p>{String(read.call(new Intl.NumberFormat()).locale)}</p>;}',
    runtime:
      'function probe(){const read=Intl.NumberFormat.prototype.resolvedOptions;Object.defineProperty(read,"call",{value:()=>({locale:"fixed"})});return String(read.call(new Intl.NumberFormat()).locale);}',
    input: null,
    client: true,
    reader: true,
    nativeData: 'fixed',
  },
  {
    id: 'borrowed-own-apply',
    source:
      'export function Widget(){const read=Intl.NumberFormat.prototype.resolvedOptions;Object.defineProperty(read,"apply",{value:()=>({locale:"fixed"})});return <p>{String(read.apply(new Intl.NumberFormat(),[]).locale)}</p>;}',
    runtime:
      'function probe(){const read=Intl.NumberFormat.prototype.resolvedOptions;Object.defineProperty(read,"apply",{value:()=>({locale:"fixed"})});return String(read.apply(new Intl.NumberFormat(),[]).locale);}',
    input: null,
    client: true,
    reader: true,
    nativeData: 'fixed',
  },
  {
    id: 'borrowed-local-intl',
    source:
      'export function Widget(){const Intl={NumberFormat:class{resolvedOptions(){return{locale:"fixed"};}}};return <p>{String(Intl.NumberFormat.prototype.resolvedOptions.call(new Intl.NumberFormat()).locale)}</p>;}',
    runtime:
      'function probe(){const Intl={NumberFormat:class{resolvedOptions(){return{locale:"fixed"};}}};return String(Intl.NumberFormat.prototype.resolvedOptions.call(new Intl.NumberFormat()).locale);}',
    input: null,
    client: true,
    reader: true,
    nativeData: 'fixed',
  },
  {
    id: 'borrowed-ordinary-callable',
    source:
      'export function Widget(){const target={resolvedOptions(){return{locale:"fixed"};}};return <p>{String(target.resolvedOptions.call({}).locale)}</p>;}',
    runtime:
      'function probe(){const target={resolvedOptions(){return{locale:"fixed"};}};return String(target.resolvedOptions.call({}).locale);}',
    input: null,
    client: true,
    reader: true,
    nativeData: 'fixed',
  },
  {
    id: 'borrowed-unrelated-native',
    source:
      'export function Widget(){return <p>{String(Object.prototype.toString.call(new Intl.NumberFormat()))}</p>;}',
    runtime:
      'function probe(){return String(Object.prototype.toString.call(new Intl.NumberFormat()));}',
    input: null,
    client: true,
    reader: true,
    nativeData: '[object Intl.NumberFormat]',
  },
  {
    id: 'direct-default-locale-pin',
    source:
      'export function Widget(){return <p>{String(new Intl.NumberFormat().resolvedOptions().locale)}</p>;}',
    runtime: 'function probe(){return String(new Intl.NumberFormat().resolvedOptions().locale);}',
    input: 'Intl.NumberFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-bypasses-own-method',
    source:
      'export function Widget(){const formatter=new Intl.ListFormat();formatter.resolvedOptions=()=>({locale:"fixed"}as Intl.ResolvedListFormatOptions);return <p>{String(Intl.ListFormat.prototype.resolvedOptions.call(formatter).locale)}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.ListFormat();formatter.resolvedOptions=()=>({locale:"fixed"}as Intl.ResolvedListFormatOptions);return String(Intl.ListFormat.prototype.resolvedOptions.call(formatter).locale);}',
    input: 'Intl.ListFormat.locale',
    client: true,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-event-only',
    source:
      'export function Widget(){return <button onClick={()=>console.log(Intl.NumberFormat.prototype.resolvedOptions.call(new Intl.NumberFormat()).locale)}>fixed</button>;}',
    runtime: 'function probe(){return"fixed";}',
    input: null,
    client: true,
    reader: false,
    nativeData: 'fixed',
  },
  {
    id: 'borrowed-effect-only',
    source:
      'import{useEffect}from"react";export function Widget(){useEffect(()=>{console.log(Intl.NumberFormat.prototype.resolvedOptions.call(new Intl.NumberFormat()).locale);},[]);return <p>fixed</p>;}',
    runtime: 'function probe(){return"fixed";}',
    input: null,
    client: true,
    reader: false,
    nativeData: 'fixed',
  },
  {
    id: 'borrowed-server-number',
    source:
      'export function Widget(){return <p>{String(Intl.NumberFormat.prototype.resolvedOptions.call(new Intl.NumberFormat()).locale)}</p>;}',
    runtime:
      'function probe(){return String(Intl.NumberFormat.prototype.resolvedOptions.call(new Intl.NumberFormat()).locale);}',
    input: 'Intl.NumberFormat.locale',
    client: false,
    reader: true,
    nativeData: null,
  },
  {
    id: 'borrowed-prior-global-wrapper',
    source:
      'export function Widget(){function prepare(){Object.defineProperty(Intl.NumberFormat.prototype.resolvedOptions,"call",{value:()=>({locale:"fixed"})});}prepare();return <p>{String(Intl.NumberFormat.prototype.resolvedOptions.call(new Intl.NumberFormat()).locale)}</p>;}',
    runtime:
      'function probe(){function prepare(){Object.defineProperty(Intl.NumberFormat.prototype.resolvedOptions,"call",{value:()=>({locale:"fixed"})});}prepare();return String(Intl.NumberFormat.prototype.resolvedOptions.call(new Intl.NumberFormat()).locale);}',
    input: 'retained Intl',
    client: true,
    reader: false,
    nativeData: 'fixed',
  },
  {
    id: 'borrowed-constructor-global-wrapper',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat("en-US",{get style(){Object.defineProperty(Intl.NumberFormat.prototype.resolvedOptions,"call",{value:()=>({locale:"fixed"})});return"decimal"as const;}});return <p>{String(Intl.NumberFormat.prototype.resolvedOptions.call(formatter).locale)}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.NumberFormat("en-US",{get style(){Object.defineProperty(Intl.NumberFormat.prototype.resolvedOptions,"call",{value:()=>({locale:"fixed"})});return"decimal"as const;}});return String(Intl.NumberFormat.prototype.resolvedOptions.call(formatter).locale);}',
    input: 'retained Intl',
    client: true,
    reader: false,
    nativeData: 'fixed',
  },
] as const;

describe('borrowed Intl environment readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-borrowed-intl.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('borrowed Intl environment route renders', () => {
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

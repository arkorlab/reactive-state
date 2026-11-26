import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Rendered locale operations retain local inputs while callbacks and written data keep their meaning. */
const CASES = [
  {
    id: 'display-default-of',
    source:
      'export function Widget(){return <p>{String(new Intl.DisplayNames(undefined,{type:"region"}).of("US"))}</p>;}',
    runtime:
      'function probe(){return String(new Intl.DisplayNames(undefined,{type:"region"}).of("US"));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'display-default-resolved',
    source:
      'export function Widget(){return <p>{String(new Intl.DisplayNames(undefined,{type:"region"}).resolvedOptions().locale)}</p>;}',
    runtime:
      'function probe(){return String(new Intl.DisplayNames(undefined,{type:"region"}).resolvedOptions().locale);}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'segment-default-resolved',
    source:
      'export function Widget(){return <p>{String(new Intl.Segmenter().resolvedOptions().locale)}</p>;}',
    runtime: 'function probe(){return String(new Intl.Segmenter().resolvedOptions().locale);}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'segment-default-segment',
    source:
      'export function Widget(){return <p>{String(Array.from(new Intl.Segmenter(undefined,{granularity:"word"}).segment("foo bar")).map((part)=>part.segment).join("|"))}</p>;}',
    runtime:
      'function probe(){return String(Array.from(new Intl.Segmenter(undefined,{granularity:"word"}).segment("foo bar")).map((part)=>part.segment).join("|"));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'display-constructor-alias',
    source:
      'export function Widget(){const Names=Intl.DisplayNames;return <p>{String(new Names(undefined,{type:"region"}).of("US"))}</p>;}',
    runtime:
      'function probe(){const Names=Intl.DisplayNames;return String(new Names(undefined,{type:"region"}).of("US"));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'segment-instance-alias',
    source:
      'export function Widget(){const original=new Intl.Segmenter();const formatter=original;return <p>{String(formatter.resolvedOptions().locale)}</p>;}',
    runtime:
      'function probe(){const original=new Intl.Segmenter();const formatter=original;return String(formatter.resolvedOptions().locale);}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'display-global-this',
    source:
      'export function Widget(){return <p>{String(new globalThis.Intl.DisplayNames(undefined,{type:"region"}).of("US"))}</p>;}',
    runtime:
      'function probe(){return String(new globalThis.Intl.DisplayNames(undefined,{type:"region"}).of("US"));}',
    refused: true,
    reader: true,
    alreadyPassing: true,
  },
  {
    id: 'segment-computed-method',
    source:
      'export function Widget(){return <p>{String(new Intl.Segmenter()["resolvedOptions"]().locale)}</p>;}',
    runtime: 'function probe(){return String(new Intl.Segmenter()["resolvedOptions"]().locale);}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-unsupported-tag',
    source:
      'export function Widget(){return <p>{String(new Intl.NumberFormat("zz").format(1234.5))}</p>;}',
    runtime: 'function probe(){return String(new Intl.NumberFormat("zz").format(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'collator-unsupported-tag',
    source:
      'export function Widget(){return <p>{String(new Intl.Collator("zz").resolvedOptions().locale)}</p>;}',
    runtime: 'function probe(){return String(new Intl.Collator("zz").resolvedOptions().locale);}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'relative-unsupported-tag',
    source:
      'export function Widget(){return <p>{String(new Intl.RelativeTimeFormat("zz").format(-1,"day"))}</p>;}',
    runtime: 'function probe(){return String(new Intl.RelativeTimeFormat("zz").format(-1,"day"));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'list-unsupported-tag',
    source:
      'export function Widget(){return <p>{String(new Intl.ListFormat("zz").format(["a","b"]))}</p>;}',
    runtime: 'function probe(){return String(new Intl.ListFormat("zz").format(["a","b"]));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'plural-unsupported-tag',
    source:
      'export function Widget(){return <p>{String(new Intl.PluralRules("zz").resolvedOptions().locale)}</p>;}',
    runtime:
      'function probe(){return String(new Intl.PluralRules("zz").resolvedOptions().locale);}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'date-unsupported-tag-fixed-zone',
    source:
      'export function Widget(){return <p>{String(new Intl.DateTimeFormat("zz",{timeZone:"UTC"}).format(0))}</p>;}',
    runtime:
      'function probe(){return String(new Intl.DateTimeFormat("zz",{timeZone:"UTC"}).format(0));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-unsupported-list',
    source:
      'export function Widget(){return <p>{String(new Intl.NumberFormat(["zz"]).format(1234.5))}</p>;}',
    runtime: 'function probe(){return String(new Intl.NumberFormat(["zz"]).format(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-all-unsupported-list',
    source:
      'export function Widget(){return <p>{String(new Intl.NumberFormat(["zz","xx"]).format(1234.5))}</p>;}',
    runtime: 'function probe(){return String(new Intl.NumberFormat(["zz","xx"]).format(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-unsupported-constant',
    source:
      'export function Widget(){const locale="zz";return <p>{String(new Intl.NumberFormat(locale).format(1234.5))}</p>;}',
    runtime:
      'function probe(){const locale="zz";return String(new Intl.NumberFormat(locale).format(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'display-unsupported-tag',
    source:
      'export function Widget(){return <p>{String(new Intl.DisplayNames("zz",{type:"region"}).of("US"))}</p>;}',
    runtime:
      'function probe(){return String(new Intl.DisplayNames("zz",{type:"region"}).of("US"));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'segment-unsupported-tag',
    source:
      'export function Widget(){return <p>{String(new Intl.Segmenter("zz").resolvedOptions().locale)}</p>;}',
    runtime: 'function probe(){return String(new Intl.Segmenter("zz").resolvedOptions().locale);}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'segment-unsupported-list',
    source:
      'export function Widget(){return <p>{String(new Intl.Segmenter(["zz"]).resolvedOptions().locale)}</p>;}',
    runtime:
      'function probe(){return String(new Intl.Segmenter(["zz"]).resolvedOptions().locale);}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'display-fixed-supported',
    source:
      'export function Widget(){return <p>{String(new Intl.DisplayNames("en-US",{type:"region"}).of("US"))}</p>;}',
    runtime:
      'function probe(){return String(new Intl.DisplayNames("en-US",{type:"region"}).of("US"));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'segment-fixed-supported',
    source:
      'export function Widget(){return <p>{String(new Intl.Segmenter("de-DE").resolvedOptions().locale)}</p>;}',
    runtime:
      'function probe(){return String(new Intl.Segmenter("de-DE").resolvedOptions().locale);}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-fixed-en',
    source:
      'export function Widget(){return <p>{String(new Intl.NumberFormat("en-US").format(1234.5))}</p>;}',
    runtime: 'function probe(){return String(new Intl.NumberFormat("en-US").format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-fixed-de',
    source:
      'export function Widget(){return <p>{String(new Intl.NumberFormat("de-DE").format(1234.5))}</p>;}',
    runtime: 'function probe(){return String(new Intl.NumberFormat("de-DE").format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-supported-after-unknown',
    source:
      'export function Widget(){return <p>{String(new Intl.NumberFormat(["zz","en-US"]).format(1234.5))}</p>;}',
    runtime:
      'function probe(){return String(new Intl.NumberFormat(["zz","en-US"]).format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-first-supported',
    source:
      'export function Widget(){return <p>{String(new Intl.NumberFormat(["de-DE","en-US"]).format(1234.5))}</p>;}',
    runtime:
      'function probe(){return String(new Intl.NumberFormat(["de-DE","en-US"]).format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-prefix-supported',
    source:
      'export function Widget(){return <p>{String(new Intl.NumberFormat("en-XX").format(1234.5))}</p>;}',
    runtime: 'function probe(){return String(new Intl.NumberFormat("en-XX").format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-fixed-constant',
    source:
      'export function Widget(){const locale="en-US";return <p>{String(new Intl.NumberFormat(locale).format(1234.5))}</p>;}',
    runtime:
      'function probe(){const locale="en-US";return String(new Intl.NumberFormat(locale).format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'date-fixed-supported-and-zone',
    source:
      'export function Widget(){return <p>{String(new Intl.DateTimeFormat("en-US",{timeZone:"UTC"}).format(0))}</p>;}',
    runtime:
      'function probe(){return String(new Intl.DateTimeFormat("en-US",{timeZone:"UTC"}).format(0));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'display-local-intl-shadow',
    source:
      'export function Widget(){const Intl={DisplayNames:class{constructor(_locale:unknown,_options:unknown){}of(_code:string){return "fixed";}}};return <p>{String(new Intl.DisplayNames(undefined,{type:"region"}).of("US"))}</p>;}',
    runtime:
      'function probe(){const Intl={DisplayNames:class{constructor(_locale:unknown,_options:unknown){}of(_code:string){return "fixed";}}};return String(new Intl.DisplayNames(undefined,{type:"region"}).of("US"));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'segment-local-constructor',
    source:
      'export function Widget(){const Segmenter=class{resolvedOptions(){return{locale:"fixed"};}};return <p>{String(new Segmenter().resolvedOptions().locale)}</p>;}',
    runtime:
      'function probe(){const Segmenter=class{resolvedOptions(){return{locale:"fixed"};}};return String(new Segmenter().resolvedOptions().locale);}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'ordinary-of-data',
    source:
      'export function Widget(){const formatter={of:()=>"fixed"};return <p>{String(formatter.of())}</p>;}',
    runtime: 'function probe(){const formatter={of:()=>"fixed"};return String(formatter.of());}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'display-own-primitive-data',
    source:
      'export function Widget(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});formatter.of=()=>"fixed";return <p>{String(formatter.of("US"))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});formatter.of=()=>"fixed";return String(formatter.of("US"));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'segment-own-primitive-data',
    source:
      'export function Widget(){const formatter=new Intl.Segmenter();formatter.segment=()=>"fixed" as never;return <p>{String(formatter.segment("text"))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.Segmenter();formatter.segment=()=>"fixed" as never;return String(formatter.segment("text"));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'display-own-options-data',
    source:
      'export function Widget(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});formatter.resolvedOptions=()=>({locale:"fixed",style:"long",type:"region",fallback:"code",languageDisplay:"dialect"});return <p>{String(formatter.resolvedOptions().locale)}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});formatter.resolvedOptions=()=>({locale:"fixed",style:"long",type:"region",fallback:"code",languageDisplay:"dialect"});return String(formatter.resolvedOptions().locale);}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'segment-own-options-data',
    source:
      'export function Widget(){const formatter=new Intl.Segmenter();formatter.resolvedOptions=()=>({locale:"fixed",granularity:"grapheme"});return <p>{String(formatter.resolvedOptions().locale)}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.Segmenter();formatter.resolvedOptions=()=>({locale:"fixed",granularity:"grapheme"});return String(formatter.resolvedOptions().locale);}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'display-invalid-tag-data',
    source:
      'export function Widget(){return <p>{String(( ()=>{try{return new Intl.DisplayNames("invalid_tag",{type:"region"}).of("US");}catch{return"fixed";}})())}</p>;}',
    runtime:
      'function probe(){return String(( ()=>{try{return new Intl.DisplayNames("invalid_tag",{type:"region"}).of("US");}catch{return"fixed";}})());}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'segment-invalid-tag-data',
    source:
      'export function Widget(){return <p>{String(( ()=>{try{return new Intl.Segmenter("invalid_tag").resolvedOptions().locale;}catch{return"fixed";}})())}</p>;}',
    runtime:
      'function probe(){return String(( ()=>{try{return new Intl.Segmenter("invalid_tag").resolvedOptions().locale;}catch{return"fixed";}})());}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-invalid-tag-data',
    source:
      'export function Widget(){return <p>{String(( ()=>{try{return new Intl.NumberFormat("invalid_tag").format(1234.5);}catch{return"fixed";}})())}</p>;}',
    runtime:
      'function probe(){return String(( ()=>{try{return new Intl.NumberFormat("invalid_tag").format(1234.5);}catch{return"fixed";}})());}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-default-existing-pin',
    source:
      'export function Widget(){return <p>{String(new Intl.NumberFormat().format(1234.5))}</p>;}',
    runtime: 'function probe(){return String(new Intl.NumberFormat().format(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: true,
  },
  {
    id: 'display-event-deferred',
    source:
      'export function Widget(){return <button onClick={()=>console.log(new Intl.DisplayNames(undefined,{type:"region"}).of("US"))}>fixed</button>;}',
    runtime: null,
    refused: false,
    reader: false,
    alreadyPassing: false,
  },
  {
    id: 'segment-effect-deferred',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{console.log(new Intl.Segmenter().resolvedOptions().locale);},[]);return <p>fixed</p>;}',
    runtime: null,
    refused: false,
    reader: false,
    alreadyPassing: false,
  },
  {
    id: 'display-own-descriptor',
    source:
      'export function Widget(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});Object.defineProperty(formatter,"of",{value:()=>"fixed"});return <p>{formatter.of("US")}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});Object.defineProperty(formatter,"of",{value:()=>"fixed"});return formatter.of("US");}',
    refused: false,
    reader: true,
    alreadyPassing: true,
  },
  {
    id: 'segment-own-options-descriptor',
    source:
      'export function Widget(){const formatter=new Intl.Segmenter();Object.defineProperty(formatter,"resolvedOptions",{value:()=>({locale:"fixed",granularity:"grapheme"})});return <p>{formatter.resolvedOptions().locale}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.Segmenter();Object.defineProperty(formatter,"resolvedOptions",{value:()=>({locale:"fixed",granularity:"grapheme"})});return formatter.resolvedOptions().locale;}',
    refused: false,
    reader: true,
    alreadyPassing: true,
  },
  {
    id: 'display-own-getter',
    source:
      'export function Widget(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});Object.defineProperty(formatter,"of",{get:()=>()=>"fixed"});return <p>{String(formatter.of("US"))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});Object.defineProperty(formatter,"of",{get:()=>()=>"fixed"});return String(formatter.of("US"));}',
    refused: false,
    reader: true,
    alreadyPassing: true,
  },
  {
    id: 'segment-own-getter',
    source:
      'export function Widget(){const formatter=new Intl.Segmenter();Object.defineProperty(formatter,"resolvedOptions",{get:()=>()=>({locale:"fixed",granularity:"grapheme"})});return <p>{String(formatter.resolvedOptions().locale)}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.Segmenter();Object.defineProperty(formatter,"resolvedOptions",{get:()=>()=>({locale:"fixed",granularity:"grapheme"})});return String(formatter.resolvedOptions().locale);}',
    refused: false,
    reader: true,
    alreadyPassing: true,
  },
  {
    id: 'display-unknown-handoff',
    source:
      'export function Widget(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});function replace(value:Intl.DisplayNames){Object.defineProperty(value,"of",{value:()=>"fixed"});}replace(formatter);return <p>{String(formatter.of("US"))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});function replace(value:Intl.DisplayNames){Object.defineProperty(value,"of",{value:()=>"fixed"});}replace(formatter);return String(formatter.of("US"));}',
    refused: false,
    reader: true,
    alreadyPassing: true,
  },
  {
    id: 'segment-captured-prepare',
    source:
      'export function Widget(){const formatter=new Intl.Segmenter();function prepare(){Object.defineProperty(formatter,"resolvedOptions",{value:()=>({locale:"fixed",granularity:"grapheme"})});}prepare();return <p>{String(formatter.resolvedOptions().locale)}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.Segmenter();function prepare(){Object.defineProperty(formatter,"resolvedOptions",{value:()=>({locale:"fixed",granularity:"grapheme"})});}prepare();return String(formatter.resolvedOptions().locale);}',
    refused: false,
    reader: true,
    alreadyPassing: true,
  },
] as const;

describe('remaining intl formatter render readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'remaining-render-intl.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(refused);
  });
});

describe('remaining intl formatter route render inputs', () => {
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

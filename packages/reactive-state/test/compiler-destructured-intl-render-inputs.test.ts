import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Rendered locale operations retain local inputs while callbacks and written data keep their meaning. */
const CASES = [
  {
    id: 'number-default-format',
    source:
      'export function Widget(){const {format}=new Intl.NumberFormat();return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const {format}=new Intl.NumberFormat();return String(format(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-renamed-format',
    source:
      'export function Widget(){const {format:render}=new Intl.NumberFormat();return <p>{String(render(1234.5))}</p>;}',
    runtime:
      'function probe(){const {format:render}=new Intl.NumberFormat();return String(render(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-computed-format',
    source:
      'export function Widget(){const {["format"]:render}=new Intl.NumberFormat();return <p>{String(render(1234.5))}</p>;}',
    runtime:
      'function probe(){const {["format"]:render}=new Intl.NumberFormat();return String(render(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-constant-key-format',
    source:
      'export function Widget(){const key="format";const {[key]:render}=new Intl.NumberFormat();return <p>{String(render(1234.5))}</p>;}',
    runtime:
      'function probe(){const key="format";const {[key]:render}=new Intl.NumberFormat();return String(render(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-native-constructor-alias',
    source:
      'export function Widget(){const Formatter=Intl.NumberFormat;const {format}=new Formatter();return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const Formatter=Intl.NumberFormat;const {format}=new Formatter();return String(format(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-instance-alias',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat();const {format}=formatter;return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.NumberFormat();const {format}=formatter;return String(format(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-whole-alias-chain',
    source:
      'export function Widget(){const original=new Intl.NumberFormat();const formatter=original;const {format:render}=formatter;return <p>{String(render(1234.5))}</p>;}',
    runtime:
      'function probe(){const original=new Intl.NumberFormat();const formatter=original;const {format:render}=formatter;return String(render(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-call-construction',
    source:
      'export function Widget(){const {format}=Intl.NumberFormat();return <p>{String(format(1234.5))}</p>;}',
    runtime: 'function probe(){const {format}=Intl.NumberFormat();return String(format(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-unsupported-locale',
    source:
      'export function Widget(){const {format}=new Intl.NumberFormat("zz");return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const {format}=new Intl.NumberFormat("zz");return String(format(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'collator-default-compare',
    source:
      'export function Widget(){const {compare}=new Intl.Collator();return <p>{String(compare("ä","z"))}</p>;}',
    runtime:
      'function probe(){const {compare}=new Intl.Collator();return String(compare("ä","z"));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'collator-constant-key',
    source:
      'export function Widget(){const key="compare";const {[key]:compare}=new Intl.Collator();return <p>{String(compare("ä","z"))}</p>;}',
    runtime:
      'function probe(){const key="compare";const {[key]:compare}=new Intl.Collator();return String(compare("ä","z"));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'display-default-of-captured',
    source:
      'export function Widget(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});const {of}=formatter;return <p>{String(of.call(formatter,"US"))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});const {of}=formatter;return String(of.call(formatter,"US"));}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'segment-default-resolved-captured',
    source:
      'export function Widget(){const formatter=new Intl.Segmenter();const {resolvedOptions}=formatter;return <p>{String(resolvedOptions.call(formatter).locale)}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.Segmenter();const {resolvedOptions}=formatter;return String(resolvedOptions.call(formatter).locale);}',
    refused: true,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-fixed-en',
    source:
      'export function Widget(){const {format}=new Intl.NumberFormat("en-US");return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const {format}=new Intl.NumberFormat("en-US");return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-fixed-de',
    source:
      'export function Widget(){const {format}=new Intl.NumberFormat("de-DE");return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const {format}=new Intl.NumberFormat("de-DE");return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-supported-later',
    source:
      'export function Widget(){const {format}=new Intl.NumberFormat(["zz","en-US"]);return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const {format}=new Intl.NumberFormat(["zz","en-US"]);return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'collator-fixed-de',
    source:
      'export function Widget(){const {compare}=new Intl.Collator("de-DE");return <p>{String(compare("ä","z"))}</p>;}',
    runtime:
      'function probe(){const {compare}=new Intl.Collator("de-DE");return String(compare("ä","z"));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'plain-own-format-data',
    source:
      'export function Widget(){const {format}={format:(_value:number)=>"fixed"};return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const {format}={format:(_value:number)=>"fixed"};return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-local-intl-shadow',
    source:
      'export function Widget(){const Intl={NumberFormat:class{readonly format=(_value:number)=>"fixed";}};const {format}=new Intl.NumberFormat();return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const Intl={NumberFormat:class{readonly format=(_value:number)=>"fixed";}};const {format}=new Intl.NumberFormat();return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-local-constructor-shadow',
    source:
      'export function Widget(){const Formatter=class{readonly format=(_value:number)=>"fixed";};const {format}=new Formatter();return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const Formatter=class{readonly format=(_value:number)=>"fixed";};const {format}=new Formatter();return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-own-descriptor-data',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat();Object.defineProperty(formatter,"format",{value:()=>"fixed"});const {format}=formatter;return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.NumberFormat();Object.defineProperty(formatter,"format",{value:()=>"fixed"});const {format}=formatter;return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-own-getter-data',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat();Object.defineProperty(formatter,"format",{get:()=>()=>"fixed"});const {format}=formatter;return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.NumberFormat();Object.defineProperty(formatter,"format",{get:()=>()=>"fixed"});const {format}=formatter;return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-prior-holder-alias-override',
    source:
      'export function Widget(){const original=new Intl.NumberFormat();const formatter=original;Object.defineProperty(original,"format",{value:()=>"fixed"});const {format}=formatter;return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const original=new Intl.NumberFormat();const formatter=original;Object.defineProperty(original,"format",{value:()=>"fixed"});const {format}=formatter;return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-opaque-prepare-data',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat();function prepare(){Object.defineProperty(formatter,"format",{value:()=>"fixed"});}prepare();const {format}=formatter;return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.NumberFormat();function prepare(){Object.defineProperty(formatter,"format",{value:()=>"fixed"});}prepare();const {format}=formatter;return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-unknown-handoff-data',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat();function replace(value:Intl.NumberFormat){Object.defineProperty(value,"format",{value:()=>"fixed"});}replace(formatter);const {format}=formatter;return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.NumberFormat();function replace(value:Intl.NumberFormat){Object.defineProperty(value,"format",{value:()=>"fixed"});}replace(formatter);const {format}=formatter;return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'list-own-literal-data',
    source:
      'export function Widget(){const formatter=new Intl.ListFormat();formatter.format=()=>"fixed";const {format}=formatter;return <p>{String(format(["a","b"]))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.ListFormat();formatter.format=()=>"fixed";const {format}=formatter;return String(format(["a","b"]));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'display-own-literal-data',
    source:
      'export function Widget(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});formatter.of=()=>"fixed";const {of}=formatter;return <p>{String(of("US"))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DisplayNames(undefined,{type:"region"});formatter.of=()=>"fixed";const {of}=formatter;return String(of("US"));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'segment-own-options-data',
    source:
      'export function Widget(){const formatter=new Intl.Segmenter();formatter.resolvedOptions=()=>({locale:"fixed",granularity:"grapheme"});const {resolvedOptions}=formatter;return <p>{String(resolvedOptions().locale)}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.Segmenter();formatter.resolvedOptions=()=>({locale:"fixed",granularity:"grapheme"});const {resolvedOptions}=formatter;return String(resolvedOptions().locale);}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-factory-data',
    source:
      'export function Widget(){function make(){return{format:(_value:number)=>"fixed"};}const {format}=make();return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){function make(){return{format:(_value:number)=>"fixed"};}const {format}=make();return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-destructure-default-data',
    source:
      'export function Widget(){const {format=(_value:number)=>"fixed"}={} as {format?:(_value:number)=>string};return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const {format=(_value:number)=>"fixed"}={} as {format?:(_value:number)=>string};return String(format(1234.5));}',
    refused: false,
    reader: true,
    alreadyPassing: false,
  },
  {
    id: 'number-default-direct-member-pin',
    source:
      'export function Widget(){return <p>{String(new Intl.NumberFormat().format(1234.5))}</p>;}',
    runtime: 'function probe(){return String(new Intl.NumberFormat().format(1234.5));}',
    refused: true,
    reader: true,
    alreadyPassing: true,
  },
  {
    id: 'date-default-destructure-pin',
    source:
      'export function Widget(){const {format}=new Intl.DateTimeFormat();return <p>{String(format(0))}</p>;}',
    runtime: 'function probe(){const {format}=new Intl.DateTimeFormat();return String(format(0));}',
    refused: true,
    reader: true,
    alreadyPassing: true,
  },
  {
    id: 'number-event-deferred',
    source:
      'export function Widget(){return <button onClick={()=>{const {format}=new Intl.NumberFormat();console.log(format(1234.5));}}>fixed</button>;}',
    runtime: null,
    refused: false,
    reader: false,
    alreadyPassing: false,
  },
  {
    id: 'number-effect-deferred',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{const {format}=new Intl.NumberFormat();console.log(format(1234.5));},[]);return <p>fixed</p>;}',
    runtime: null,
    refused: false,
    reader: false,
    alreadyPassing: false,
  },
] as const;

describe('destructured intl formatter render readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-intl-bindings.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(refused);
  });
});

describe('destructured intl formatter route render inputs', () => {
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

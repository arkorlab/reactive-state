import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Rendered locale operations retain local inputs while callbacks and written data keep their meaning. */
const CASES = [
  {
    id: 'object-number-default',
    source:
      'export function Widget(){const box={formatter:new Intl.NumberFormat()};return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.NumberFormat()};return String(box.formatter.format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'object-bracket-unsupported',
    source:
      'export function Widget(){const box={formatter:new Intl.NumberFormat("zz")};return <p>{String(box["formatter"].format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.NumberFormat("zz")};return String(box["formatter"].format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'array-number-default',
    source:
      'export function Widget(){const box=[new Intl.NumberFormat()];return <p>{String(box[0]!.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box=[new Intl.NumberFormat()];return String(box[0]!.format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'nested-object-array-default',
    source:
      'export function Widget(){const box={values:[{formatter:new Intl.NumberFormat()}]};return <p>{String(box.values[0]!.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={values:[{formatter:new Intl.NumberFormat()}]};return String(box.values[0]!.formatter.format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'holder-whole-alias',
    source:
      'export function Widget(){const original={formatter:new Intl.NumberFormat()};const box=original;return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const original={formatter:new Intl.NumberFormat()};const box=original;return String(box.formatter.format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'instance-member-alias',
    source:
      'export function Widget(){const box={formatter:new Intl.NumberFormat()};const formatter=box.formatter;return <p>{String(formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.NumberFormat()};const formatter=box.formatter;return String(formatter.format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'object-instance-binding',
    source:
      'export function Widget(){const {formatter}={formatter:new Intl.NumberFormat()};return <p>{String(formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const {formatter}={formatter:new Intl.NumberFormat()};return String(formatter.format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'array-instance-binding',
    source:
      'export function Widget(){const [formatter]=[new Intl.NumberFormat()];return <p>{String(formatter!.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const [formatter]=[new Intl.NumberFormat()];return String(formatter!.format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'nested-instance-binding',
    source:
      'export function Widget(){const {values:[{formatter}]}={values:[{formatter:new Intl.NumberFormat()}]};return <p>{String(formatter!.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const {values:[{formatter}]}={values:[{formatter:new Intl.NumberFormat()}]};return String(formatter!.format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'constant-property-key',
    source:
      'export function Widget(){const key="formatter";const box={[key]:new Intl.NumberFormat()};return <p>{String(box[key].format(1234.5))}</p>;}',
    runtime:
      'function probe(){const key="formatter";const box={[key]:new Intl.NumberFormat()};return String(box[key].format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'native-constructor-alias',
    source:
      'export function Widget(){const Formatter=Intl.NumberFormat;const box={formatter:new Formatter()};return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const Formatter=Intl.NumberFormat;const box={formatter:new Formatter()};return String(box.formatter.format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'callable-native-construction',
    source:
      'export function Widget(){const box={formatter:Intl.NumberFormat()};return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={formatter:Intl.NumberFormat()};return String(box.formatter.format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'object-default-collator',
    source:
      'export function Widget(){const box={formatter:new Intl.Collator()};return <p>{String(box.formatter.compare("ä","z"))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.Collator()};return String(box.formatter.compare("ä","z"));}',
    refused: true,
    reader: true,
  },
  {
    id: 'object-date-fixed-zone',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat(undefined,{timeZone:"UTC"})};return <p>{String(box.formatter.format(0))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DateTimeFormat(undefined,{timeZone:"UTC"})};return String(box.formatter.format(0));}',
    refused: true,
    reader: true,
  },
  {
    id: 'object-display-default',
    source:
      'export function Widget(){const box={formatter:new Intl.DisplayNames(undefined,{type:"region"})};return <p>{String(box.formatter.of("US"))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DisplayNames(undefined,{type:"region"})};return String(box.formatter.of("US"));}',
    refused: true,
    reader: true,
  },
  {
    id: 'array-segment-default',
    source:
      'export function Widget(){const box=[new Intl.Segmenter()];return <p>{String(box[0]!.resolvedOptions().locale)}</p>;}',
    runtime:
      'function probe(){const box=[new Intl.Segmenter()];return String(box[0]!.resolvedOptions().locale);}',
    refused: true,
    reader: true,
  },
  {
    id: 'captured-member-method',
    source:
      'export function Widget(){const box={formatter:new Intl.NumberFormat()};const {format}=box.formatter;return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.NumberFormat()};const {format}=box.formatter;return String(format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'captured-destructured-instance',
    source:
      'export function Widget(){const {formatter}={formatter:new Intl.NumberFormat()};const {format}=formatter;return <p>{String(format(1234.5))}</p>;}',
    runtime:
      'function probe(){const {formatter}={formatter:new Intl.NumberFormat()};const {format}=formatter;return String(format(1234.5));}',
    refused: true,
    reader: true,
  },
  {
    id: 'fixed-supported-locale',
    source:
      'export function Widget(){const box={formatter:new Intl.NumberFormat("en-US")};return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.NumberFormat("en-US")};return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'fixed-supported-later-locale',
    source:
      'export function Widget(){const box=[new Intl.NumberFormat(["zz","de-DE"])];return <p>{String(box[0]!.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box=[new Intl.NumberFormat(["zz","de-DE"])];return String(box[0]!.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'fixed-date-locale-zone',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC"})};return <p>{String(box.formatter.format(0))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC"})};return String(box.formatter.format(0));}',
    refused: false,
    reader: true,
  },
  {
    id: 'local-intl-shadow',
    source:
      'export function Widget(){const Intl={NumberFormat:class{readonly format=(_value:number)=>"fixed";}};const box={formatter:new Intl.NumberFormat()};return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const Intl={NumberFormat:class{readonly format=(_value:number)=>"fixed";}};const box={formatter:new Intl.NumberFormat()};return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'plain-own-method',
    source:
      'export function Widget(){const box={formatter:{format:(_value:number)=>"fixed"}};return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={formatter:{format:(_value:number)=>"fixed"}};return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'own-method-before-storage',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat();Object.defineProperty(formatter,"format",{value:()=>"fixed"});const box={formatter};return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.NumberFormat();Object.defineProperty(formatter,"format",{value:()=>"fixed"});const box={formatter};return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'own-method-after-storage',
    source:
      'export function Widget(){const box={formatter:new Intl.NumberFormat()};Object.defineProperty(box.formatter,"format",{value:()=>"fixed"});return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.NumberFormat()};Object.defineProperty(box.formatter,"format",{value:()=>"fixed"});return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'own-method-canonical-alias',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat();const box={formatter};Object.defineProperty(formatter,"format",{value:()=>"fixed"});return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.NumberFormat();const box={formatter};Object.defineProperty(formatter,"format",{value:()=>"fixed"});return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'holder-member-replacement',
    source:
      'export function Widget(){const box:{formatter:Pick<Intl.NumberFormat,"format">}={formatter:new Intl.NumberFormat()};box.formatter={format:()=>"fixed"};return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box:{formatter:Pick<Intl.NumberFormat,"format">}={formatter:new Intl.NumberFormat()};box.formatter={format:()=>"fixed"};return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'array-member-replacement',
    source:
      'export function Widget(){const box:Pick<Intl.NumberFormat,"format">[]=[new Intl.NumberFormat()];box[0]={format:()=>"fixed"};return <p>{String(box[0]!.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box:Pick<Intl.NumberFormat,"format">[]=[new Intl.NumberFormat()];box[0]={format:()=>"fixed"};return String(box[0]!.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'unknown-handoff-replacement',
    source:
      'export function Widget(){const box={formatter:new Intl.NumberFormat()};function prepare(value:typeof box){Object.defineProperty(value.formatter,"format",{value:()=>"fixed"});}prepare(box);return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.NumberFormat()};function prepare(value:typeof box){Object.defineProperty(value.formatter,"format",{value:()=>"fixed"});}prepare(box);return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'captured-callback-replacement',
    source:
      'export function Widget(){const box={formatter:new Intl.NumberFormat()};function prepare(){Object.defineProperty(box.formatter,"format",{value:()=>"fixed"});}prepare();return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.NumberFormat()};function prepare(){Object.defineProperty(box.formatter,"format",{value:()=>"fixed"});}prepare();return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'getter-holder-data',
    source:
      'export function Widget(){const box={get formatter(){return{format:(_value:number)=>"fixed"};},other:new Intl.NumberFormat()};return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={get formatter(){return{format:(_value:number)=>"fixed"};},other:new Intl.NumberFormat()};return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'spread-holder-data',
    source:
      'export function Widget(){const original={formatter:new Intl.NumberFormat()};const box={...original,formatter:{format:(_value:number)=>"fixed"}};return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const original={formatter:new Intl.NumberFormat()};const box={...original,formatter:{format:(_value:number)=>"fixed"}};return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'computed-call-key-data',
    source:
      'export function Widget(){function key(){return "formatter";}const box={other:new Intl.NumberFormat(),[key()]:{format:(_value:number)=>"fixed"}} as Record<string,Pick<Intl.NumberFormat,"format">>;return <p>{String(box[key()]!.format(1234.5))}</p>;}',
    runtime:
      'function probe(){function key(){return "formatter";}const box={other:new Intl.NumberFormat(),[key()]:{format:(_value:number)=>"fixed"}} as Record<string,Pick<Intl.NumberFormat,"format">>;return String(box[key()]!.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'custom-array-iterator-data',
    source:
      'export function Widget(){const values=[new Intl.NumberFormat()];values[Symbol.iterator]=()=>[{format:(_value:number)=>"fixed"} as Intl.NumberFormat][Symbol.iterator]();const [formatter]=values;return <p>{String(formatter!.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const values=[new Intl.NumberFormat()];values[Symbol.iterator]=()=>[{format:(_value:number)=>"fixed"} as Intl.NumberFormat][Symbol.iterator]();const [formatter]=values;return String(formatter!.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'factory-holder-data',
    source:
      'export function Widget(){function make(){return{formatter:{format:(_value:number)=>"fixed"}};}const box=make();return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){function make(){return{formatter:{format:(_value:number)=>"fixed"}};}const box=make();return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'binding-default-data',
    source:
      'export function Widget(){const {formatter={format:(_value:number)=>"fixed"}}={} as {formatter?:Pick<Intl.NumberFormat,"format">};return <p>{String(formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const {formatter={format:(_value:number)=>"fixed"}}={} as {formatter?:Pick<Intl.NumberFormat,"format">};return String(formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'unselected-native-data',
    source:
      'export function Widget(){const box={other:new Intl.NumberFormat(),formatter:{format:(_value:number)=>"fixed"}};return <p>{String(box.formatter.format(1234.5))}</p>;}',
    runtime:
      'function probe(){const box={other:new Intl.NumberFormat(),formatter:{format:(_value:number)=>"fixed"}};return String(box.formatter.format(1234.5));}',
    refused: false,
    reader: true,
  },
  {
    id: 'event-deferred-projection',
    source:
      'export function Widget(){return <button onClick={()=>{const box={formatter:new Intl.NumberFormat()};console.log(box.formatter.format(1234.5));}}>fixed</button>;}',
    runtime: null,
    refused: false,
    reader: false,
  },
  {
    id: 'effect-deferred-projection',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{const box={formatter:new Intl.NumberFormat()};console.log(box.formatter.format(1234.5));},[]);return <p>fixed</p>;}',
    runtime: null,
    refused: false,
    reader: false,
  },
] as const;

describe('stored intl formatter render readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-intl-projections.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(refused);
  });
});

describe('stored intl formatter route render inputs', () => {
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

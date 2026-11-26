import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A date format's `format` a reflective read takes off it formats the time it is called at. */
const CASES = [
  {
    id: 'stored-object-clock',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return <p>{String(box.formatter.format())}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return String(box.formatter.format());}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'stored-bracket-clock',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return <p>{String(box["formatter"].format())}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return String(box["formatter"].format());}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'stored-array-clock',
    source:
      'export function Widget(){const box=[new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})];return <p>{String(box[0]!.format())}</p>;}',
    runtime:
      'function probe(){const box=[new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})];return String(box[0]!.format());}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'stored-nested-clock',
    source:
      'export function Widget(){const box={items:[{formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})}]};return <p>{String(box.items[0]!.formatter.format())}</p>;}',
    runtime:
      'function probe(){const box={items:[{formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})}]};return String(box.items[0]!.formatter.format());}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'stored-holder-alias-clock',
    source:
      'export function Widget(){const original={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};const box=original;return <p>{String(box.formatter.format())}</p>;}',
    runtime:
      'function probe(){const original={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};const box=original;return String(box.formatter.format());}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'stored-instance-alias-clock',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};const formatter=box.formatter;return <p>{String(formatter.format())}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};const formatter=box.formatter;return String(formatter.format());}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'stored-object-binding-clock',
    source:
      'export function Widget(){const {formatter}={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return <p>{String(formatter.format())}</p>;}',
    runtime:
      'function probe(){const {formatter}={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return String(formatter.format());}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'stored-array-binding-clock',
    source:
      'export function Widget(){const [formatter]=[new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})];return <p>{String(formatter!.format())}</p>;}',
    runtime:
      'function probe(){const [formatter]=[new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})];return String(formatter!.format());}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'stored-constant-key-clock',
    source:
      'export function Widget(){const key="formatter";const box={[key]:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return <p>{String(box[key].format())}</p>;}',
    runtime:
      'function probe(){const key="formatter";const box={[key]:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return String(box[key].format());}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'stored-reflect-clock',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return <p>{String(Reflect.get(box.formatter,"format")())}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return String(Reflect.get(box.formatter,"format")());}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'stored-parts-clock',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return <p>{String(JSON.stringify(box.formatter.formatToParts()))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return String(JSON.stringify(box.formatter.formatToParts()));}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'parts-now',
  },
  {
    id: 'stored-supplied-date',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return <p>{String(box.formatter.format(0))}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return String(box.formatter.format(0));}',
    input: null,
    client: true,
    reader: true,
    native: 'epoch',
  },
  {
    id: 'direct-supplied-date',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(0))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(0));}',
    input: null,
    client: true,
    reader: true,
    native: 'epoch',
  },
  {
    id: 'stored-written-override',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};Object.defineProperty(box.formatter,"format",{value:()=>"fixed"});return <p>{String(box.formatter.format())}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};Object.defineProperty(box.formatter,"format",{value:()=>"fixed"});return String(box.formatter.format());}',
    input: null,
    client: true,
    reader: true,
    native: 'fixed',
  },
  {
    id: 'stored-holder-replacement',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};box.formatter={format:()=>"fixed"}as never;return <p>{String(box.formatter.format())}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};box.formatter={format:()=>"fixed"}as never;return String(box.formatter.format());}',
    input: null,
    client: true,
    reader: true,
    native: 'fixed',
  },
  {
    id: 'stored-ordinary-method',
    source:
      'export function Widget(){const box={formatter:{format:()=>"fixed"}};return <p>{String(box.formatter.format())}</p>;}',
    runtime:
      'function probe(){const box={formatter:{format:()=>"fixed"}};return String(box.formatter.format());}',
    input: null,
    client: true,
    reader: true,
    native: 'fixed',
  },
  {
    id: 'stored-shadowed-intl',
    source:
      'export function Widget(){const Intl={DateTimeFormat:class{format(){return"fixed";}}};const box={formatter:new Intl.DateTimeFormat()};return <p>{String(box.formatter.format())}</p>;}',
    runtime:
      'function probe(){const Intl={DateTimeFormat:class{format(){return"fixed";}}};const box={formatter:new Intl.DateTimeFormat()};return String(box.formatter.format());}',
    input: null,
    client: true,
    reader: true,
    native: 'fixed',
  },
  {
    id: 'stored-event-only',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return <button onClick={()=>console.log(box.formatter.format())}>fixed</button>;}',
    runtime: 'function probe(){return"fixed";}',
    input: null,
    client: true,
    reader: false,
    native: 'fixed',
  },
  {
    id: 'stored-effect-only',
    source:
      'import{useEffect}from"react";export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};useEffect(()=>{console.log(box.formatter.format());},[]);return <p>fixed</p>;}',
    runtime: 'function probe(){return"fixed";}',
    input: null,
    client: true,
    reader: false,
    native: 'fixed',
  },
  {
    id: 'stored-server-clock',
    source:
      'export function Widget(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return <p>{box.formatter.format()}</p>;}',
    runtime:
      'function probe(){const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return box.formatter.format();}',
    input: 'Intl.DateTimeFormat',
    client: false,
    reader: true,
    native: 'now',
  },
] as const;

describe('stored date format clock readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-stored-formats.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('stored date format clock route renders', () => {
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

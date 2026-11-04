import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A date format's `format` a reflective read takes off it formats the time it is called at. */
const CASES = [
  {
    id: 'undefined-whole-alias',
    source:
      'export function Widget(){const missing=undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const missing=undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(missing));}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'undefined-alias-chain',
    source:
      'export function Widget(){const absent=undefined;const missing=absent;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const absent=undefined;const missing=absent;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(missing));}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'undefined-void-alias',
    source:
      'export function Widget(){const missing=void 0;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const missing=void 0;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(missing));}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'undefined-parts-alias',
    source:
      'export function Widget(){const missing=undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(JSON.stringify(formatter.formatToParts(missing)))}</p>;}',
    runtime:
      'function probe(){const missing=undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(JSON.stringify(formatter.formatToParts(missing)));}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'parts-now',
  },
  {
    id: 'undefined-constructor-alias',
    source:
      'export function Widget(){const missing=undefined;const Formatter=Intl.DateTimeFormat;const formatter=new Formatter("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const missing=undefined;const Formatter=Intl.DateTimeFormat;const formatter=new Formatter("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(missing));}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'undefined-instance-alias',
    source:
      'export function Widget(){const missing=undefined;const original=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const formatter=original;return <p>{String(formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const missing=undefined;const original=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const formatter=original;return String(formatter.format(missing));}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'undefined-fresh-construction',
    source:
      'export function Widget(){const missing=undefined;return <p>{String((new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})).format(missing))}</p>;}',
    runtime:
      'function probe(){const missing=undefined;return String((new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})).format(missing));}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'undefined-asserted-alias',
    source:
      'export function Widget(){const missing=undefined as number|undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const missing=undefined as number|undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(missing));}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'undefined-stored-instance',
    source:
      'export function Widget(){const missing=undefined;const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return <p>{String(box.formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const missing=undefined;const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};return String(box.formatter.format(missing));}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'undefined-shadowed-name',
    source:
      'export function Widget(){const undefined=0;const missing=undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const undefined=0;const missing=undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(missing));}',
    input: null,
    client: true,
    reader: true,
    native: 'epoch',
  },
  {
    id: 'undefined-fixed-number',
    source:
      'export function Widget(){const missing=0;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const missing=0;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(missing));}',
    input: null,
    client: true,
    reader: true,
    native: 'epoch',
  },
  {
    id: 'undefined-null-data',
    source:
      'export function Widget(){const missing=null;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(missing as never))}</p>;}',
    runtime:
      'function probe(){const missing=null;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(missing as never));}',
    input: null,
    client: true,
    reader: true,
    native: 'epoch',
  },
  {
    id: 'undefined-reassigned-variable',
    source:
      'export function Widget(){let missing:number|undefined=undefined;missing=0;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){let missing:number|undefined=undefined;missing=0;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(missing));}',
    input: null,
    client: true,
    reader: true,
    native: 'epoch',
  },
  {
    id: 'undefined-own-format',
    source:
      'export function Widget(){const missing=undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});Object.defineProperty(formatter,"format",{value:()=>"fixed"});return <p>{String(formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const missing=undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});Object.defineProperty(formatter,"format",{value:()=>"fixed"});return String(formatter.format(missing));}',
    input: null,
    client: true,
    reader: true,
    native: 'fixed',
  },
  {
    id: 'undefined-own-getter',
    source:
      'export function Widget(){const missing=undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});Object.defineProperty(formatter,"format",{get(){return()=>"fixed";}});return <p>{String(formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const missing=undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});Object.defineProperty(formatter,"format",{get(){return()=>"fixed";}});return String(formatter.format(missing));}',
    input: null,
    client: true,
    reader: true,
    native: 'fixed',
  },
  {
    id: 'undefined-stored-replaced',
    source:
      'export function Widget(){const missing=undefined;const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};box.formatter={format:()=>"fixed"}as never;return <p>{String(box.formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const missing=undefined;const box={formatter:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"})};box.formatter={format:()=>"fixed"}as never;return String(box.formatter.format(missing));}',
    input: null,
    client: true,
    reader: true,
    native: 'fixed',
  },
  {
    id: 'undefined-local-intl',
    source:
      'export function Widget(){const missing=undefined;const Intl={DateTimeFormat:class{format(_date?:number){return"fixed";}}};const formatter=new Intl.DateTimeFormat();return <p>{String(formatter.format(missing))}</p>;}',
    runtime:
      'function probe(){const missing=undefined;const Intl={DateTimeFormat:class{format(_date?:number){return"fixed";}}};const formatter=new Intl.DateTimeFormat();return String(formatter.format(missing));}',
    input: null,
    client: true,
    reader: true,
    native: 'fixed',
  },
  {
    id: 'undefined-written-factory',
    source:
      'export function Widget(){function missing(){return 0;}const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(missing()))}</p>;}',
    runtime:
      'function probe(){function missing(){return 0;}const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(missing()));}',
    input: null,
    client: true,
    reader: true,
    native: 'epoch',
  },
  {
    id: 'direct-undefined-clock',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(undefined))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(undefined));}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'direct-void-clock',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <p>{String(formatter.format(void 0))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return String(formatter.format(void 0));}',
    input: 'Intl.DateTimeFormat',
    client: true,
    reader: true,
    native: 'now',
  },
  {
    id: 'undefined-event-only',
    source:
      'export function Widget(){const missing=undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});return <button onClick={()=>console.log(formatter.format(missing))}>fixed</button>;}',
    runtime: 'function probe(){return"fixed";}',
    input: null,
    client: true,
    reader: false,
    native: 'fixed',
  },
  {
    id: 'undefined-effect-only',
    source:
      'import{useEffect}from"react";export function Widget(){const missing=undefined;const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});useEffect(()=>{console.log(formatter.format(missing));},[]);return <p>fixed</p>;}',
    runtime: 'function probe(){return"fixed";}',
    input: null,
    client: true,
    reader: false,
    native: 'fixed',
  },
] as const;

describe('undefined date format clock readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-undefined-formats.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('undefined date format clock route renders', () => {
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

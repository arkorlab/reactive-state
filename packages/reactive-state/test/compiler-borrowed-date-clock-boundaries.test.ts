import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Borrowed native date formatter methods retain the actual receiver and consumed date. */
const CASES = [
  {
    id: 'borrowed-computed-void-alias',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const key="call";const date=void 0;return <p>{String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts[key](formatter,date)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const key="call";const date=void 0;return String(JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts[key](formatter,date)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-prototype-alias',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const prototype=Intl.DateTimeFormat.prototype;return <p>{String(JSON.stringify(prototype.formatToParts.call(formatter)))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const prototype=Intl.DateTimeFormat.prototype;return String(JSON.stringify(prototype.formatToParts.call(formatter)));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'borrowed-reflect-ignored-tail',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const dates:[number|undefined]=[undefined];return <p>{String(JSON.stringify((Reflect.apply as (...args:unknown[])=>Intl.DateTimeFormatPart[])(Intl.DateTimeFormat.prototype.formatToParts,formatter,dates,Object.assign(dates,{0:0}))))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const dates:[number|undefined]=[undefined];return String(JSON.stringify((Reflect.apply as (...args:unknown[])=>Intl.DateTimeFormatPart[])(Intl.DateTimeFormat.prototype.formatToParts,formatter,dates,Object.assign(dates,{0:0}))));}',
    input: null,
    native: 'parts-epoch',
    client: true,
    reader: true,
  },
] as const;

describe('borrowed date clock boundaries readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-borrowed-date-clock.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('borrowed date clock boundaries route renders', () => {
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

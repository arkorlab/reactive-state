import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A date format of a written locale and zone, whose `format` reads only the clock given no date. */
const FIXED = 'new Intl.DateTimeFormat("en-US",{timeZone:"UTC"})';
const CLOCK = 'Intl.DateTimeFormat';

/** A date format's `format` a reflective read takes off it formats the time it is called at. */
const CASES = [
  {
    id: 'reflected-format-now',
    source: `export function Widget(){return <p>{String(Reflect.get(${FIXED},"format")())}</p>;}`,
    input: CLOCK,
    client: true,
    reader: true,
  },
  {
    id: 'server-reflected-format-now',
    source: `export function Widget(){return <p>{String(Reflect.get(${FIXED},"format")())}</p>;}`,
    input: CLOCK,
    client: false,
    reader: true,
  },
  {
    id: 'reflected-instance-format-now',
    source: `export function Widget(){const formatter=${FIXED};return <p>{String(Reflect.get(formatter,"format")())}</p>;}`,
    input: CLOCK,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-parts-now',
    source: `export function Widget(){const formatter=${FIXED};return <p>{String(Reflect.get(formatter,"formatToParts").call(formatter).length)}</p>;}`,
    input: CLOCK,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-get-alias-now',
    source: `export function Widget(){const get=Reflect.get;return <p>{String(get(${FIXED},"format")())}</p>;}`,
    input: CLOCK,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-get-call-now',
    source: `export function Widget(){return <p>{String(Reflect.get.call(undefined,${FIXED},"format")())}</p>;}`,
    input: CLOCK,
    client: true,
    reader: true,
  },
  {
    id: 'reflect-apply-format-now',
    source: `export function Widget(){return <p>{String(Reflect.apply(Reflect.get,undefined,[${FIXED},"format"])())}</p>;}`,
    input: CLOCK,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-constant-key-now',
    source: `export function Widget(){const key="format";return <p>{String(Reflect.get(${FIXED},key)())}</p>;}`,
    input: CLOCK,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-unknown-key-now',
    source: `export function Widget({name}:{name:string}){return <p>{String(Reflect.get(${FIXED},name))}</p>;}`,
    input: CLOCK,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-undefined-date-now',
    source: `export function Widget(){return <p>{String(Reflect.get(${FIXED},"format")(undefined))}</p>;}`,
    input: CLOCK,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-receiver-now',
    source: `export function Widget(){return <p>{String(Reflect.get(Intl.DateTimeFormat.prototype,"format",${FIXED})())}</p>;}`,
    input: CLOCK,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-subclass-now',
    source:
      'class Format extends Intl.DateTimeFormat {} export function Widget(){return <p>{String(Reflect.get(new Format("en-US",{timeZone:"UTC"}),"format")())}</p>;}',
    input: CLOCK,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-captured-format',
    source: `export function Widget(){const format=Reflect.get(${FIXED},"format");return <p>{String(format())}</p>;}`,
    input: CLOCK,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-format-of-date',
    source: `export function Widget(){return <p>{String(Reflect.get(${FIXED},"format")(0))}</p>;}`,
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-alias-format-of-date',
    source: `export function Widget(){const get=Reflect.get;return <p>{String(get(${FIXED},"format")(0))}</p>;}`,
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-resolved-zone',
    source: `export function Widget(){const formatter=${FIXED};return <p>{String(Reflect.get(formatter,"resolvedOptions").call(formatter).timeZone)}</p>;}`,
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-symbol-key',
    source: `export function Widget(){return <p>{String(Reflect.get(${FIXED},Symbol.toStringTag))}</p>;}`,
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-ordinary-format-now',
    source:
      'export function Widget(){return <p>{String(Reflect.get({format:()=>"fixed"},"format")())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-own-format-subclass',
    source:
      'class Format extends Intl.DateTimeFormat {format(){return "fixed";}} export function Widget(){return <p>{String(Reflect.get(new Format("en-US",{timeZone:"UTC"}),"format")())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'shadowed-intl-format-now',
    source:
      'export function Widget(){const Intl={DateTimeFormat:class{format(){return "fixed";}}};return <p>{String(Reflect.get(new Intl.DateTimeFormat(),"format")())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'shadowed-reflect-format-now',
    source: `export function Widget(){const Reflect={get:(_target:unknown,_key:string)=>()=>"fixed"};return <p>{String(Reflect.get(${FIXED},"format")())}</p>;}`,
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-format-event-only',
    source: `export function Widget(){return <button onClick={()=>console.log(Reflect.get(${FIXED},"format")())}>fixed</button>;}`,
    input: null,
    client: true,
    reader: false,
  },
  {
    id: 'reflected-format-effect-only',
    source: `import {useEffect} from "react";export function Widget(){useEffect(()=>{console.log(Reflect.get(${FIXED},"format")());},[]);return <p>fixed</p>;}`,
    input: null,
    client: true,
    reader: false,
  },
] as const;

describe('reflected date format clock readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-format-reflections.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('reflected date format clock route renders', () => {
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

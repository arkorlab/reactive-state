import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

const LOCALE_TEXT = 'reads `toLocaleString`, of the time zone or the locale where it runs';

/** Reflected native locale members retain the render environment as their member reads do. */
const CASES = [
  {
    id: 'reflected-number-prototype',
    source:
      'export function Widget(){return <p>{String(Reflect.get(Number.prototype,"toLocaleString").call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'server-reflected-number-prototype',
    source:
      'export function Widget(){return <p>{String(Reflect.get(Number.prototype,"toLocaleString").call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: false,
    reader: true,
  },
  {
    id: 'reflected-bigint-prototype',
    source:
      'export function Widget(){return <p>{String(Reflect.get(BigInt.prototype,"toLocaleString").call(1234n))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-array',
    source:
      'export function Widget(){return <p>{String(Reflect.get([1234.5],"toLocaleString").call([1234.5]))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-array-alias',
    source:
      'export function Widget(){const values=[1234.5];return <p>{String(Reflect.get(values,"toLocaleString").call(values))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-wrapped-number',
    source:
      'export function Widget(){return <p>{String(Reflect.get(Object(1234.5),"toLocaleString").call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-prop-date',
    source:
      'export function Widget({date}:{date:Date}){return <p>{String(Reflect.get(date,"toLocaleString").call(date))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-string-compare',
    source:
      'export function Widget(){return <p>{String(Reflect.get(String.prototype,"localeCompare").call("a","b"))}</p>;}',
    input: 'reads `localeCompare`, of the time zone or the locale where it runs',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-string-lower',
    source:
      'export function Widget(){return <p>{String(Reflect.get(String.prototype,"toLocaleLowerCase").call("I"))}</p>;}',
    input: 'reads `toLocaleLowerCase`, of the time zone or the locale where it runs',
    client: true,
    reader: true,
  },
  {
    id: 'reflected-provided-locale',
    source:
      'export function Widget(){return <p>{String(Reflect.get(Number.prototype,"toLocaleString").call(1234.5,"en-US"))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-locale-alias',
    source:
      'export function Widget(){const get=Reflect.get;return <p>{String(get(Number.prototype,"toLocaleString").call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-locale-call',
    source:
      'export function Widget(){return <p>{String(Reflect.get.call(undefined,Number.prototype,"toLocaleString").call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'reflect-apply-locale',
    source:
      'export function Widget(){return <p>{String(Reflect.apply(Reflect.get,undefined,[Number.prototype,"toLocaleString"]).call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-constant-locale-key',
    source:
      'export function Widget(){const key="toLocaleString";return <p>{String(Reflect.get(Number.prototype,key).call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    // `Reflect.get` throws on a primitive target; it is read as `(1234.5).toLocaleString` is.
    id: 'reflected-primitive-number',
    source:
      'export function Widget(){return <p>{String(Reflect.get(1234.5 as unknown as object,"toLocaleString").call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    // A member read before the named object, `Reflect.get` itself, leaves its method unproven.
    id: 'reflected-named-custom-method',
    source:
      'export function Widget(){const value={toLocaleString:()=>"fixed"};return <p>{String(Reflect.get(value,"toLocaleString")())}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-written-custom-method',
    source:
      'export function Widget(){return <p>{String(Reflect.get({toLocaleString:()=>"fixed"},"toLocaleString")())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-own-date-locale-data',
    source:
      'export function Widget(){const date=new Date(0);date.toLocaleString=()=>"fixed";return <p>{String(Reflect.get(date,"toLocaleString")())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-plain-number-text',
    source:
      'export function Widget(){return <p>{String(Reflect.get(Number.prototype,"toString").call(1234.5))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-unknown-locale-key',
    source:
      'export function Widget({name}:{name:string}){return <p>{String(typeof Reflect.get(Number.prototype,name))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-symbol-locale-key',
    source:
      'export function Widget(){return <p>{String(Reflect.get(Number.prototype,Symbol.toStringTag))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'shadowed-reflect-locale',
    source:
      'export function Widget(){const Reflect={get:(_target:unknown,_key:string)=>()=>"fixed"};return <p>{String(Reflect.get(Number.prototype,"toLocaleString")())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'reflected-locale-event-only',
    source:
      'export function Widget(){return <button onClick={()=>console.log(Reflect.get(Number.prototype,"toLocaleString").call(1234.5))}>fixed</button>;}',
    input: null,
    client: true,
    reader: false,
  },
  {
    id: 'reflected-locale-effect-only',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{console.log(Reflect.get(Number.prototype,"toLocaleString").call(1234.5));},[]);return <p>fixed</p>;}',
    input: null,
    client: true,
    reader: false,
  },
] as const;

describe('reflected locale member readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-locale-reflections.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('reflected locale member route renders', () => {
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

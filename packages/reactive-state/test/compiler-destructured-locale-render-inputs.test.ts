import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

const LOCALE_TEXT = 'reads `toLocaleString`, of the time zone or the locale where it runs';

/** A native locale member a pattern takes apart retains the render environment as its member read. */
const CASES = [
  {
    id: 'destructured-number-prototype',
    source:
      'export function Widget(){const {toLocaleString}=Number.prototype;return <p>{String(toLocaleString.call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'server-destructured-number-prototype',
    source:
      'export function Widget(){const {toLocaleString}=Number.prototype;return <p>{String(toLocaleString.call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: false,
    reader: true,
  },
  {
    id: 'renamed-locale-method',
    source:
      'export function Widget(){const {toLocaleString:format}=Number.prototype;return <p>{String(format.call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'bracketed-locale-method',
    source:
      'export function Widget(){const {["toLocaleString"]:format}=Number.prototype;return <p>{String(format.call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'constant-key-locale-method',
    source:
      'export function Widget(){const key="toLocaleString";const {[key]:format}=Number.prototype;return <p>{String(format.call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'bigint-prototype-locale',
    source:
      'export function Widget(){const {toLocaleString}=BigInt.prototype;return <p>{String(toLocaleString.call(1234n))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'array-locale-method',
    source:
      'export function Widget(){const values=[1234.5];const {toLocaleString}=values;return <p>{String(toLocaleString.call(values))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'string-compare-method',
    source:
      'export function Widget(){const {localeCompare}=String.prototype;return <p>{String(localeCompare.call("a","b"))}</p>;}',
    input: 'reads `localeCompare`, of the time zone or the locale where it runs',
    client: true,
    reader: true,
  },
  {
    id: 'date-prop-locale',
    source:
      'export function Widget({date}:{date:Date}){const {toLocaleString}=date;return <p>{String(toLocaleString.call(date))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'parameter-default-locale',
    source:
      'export function Widget(){const show=({toLocaleString}=Number.prototype)=>toLocaleString.call(1234.5);return <p>{String(show())}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'nested-locale-method',
    source:
      'export function Widget(){const {prototype:{toLocaleString}}=Number;return <p>{String(toLocaleString.call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'loop-locale-method',
    source:
      'export function Widget(){const texts:string[]=[];for(const {toLocaleString} of [Number.prototype]){texts.push(toLocaleString.call(1234.5));}return <p>{texts.join()}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'prop-locale-method',
    source:
      'export function Widget({value}:{value:{toLocaleString:()=>string}}){const {toLocaleString}=value;return <p>{toLocaleString()}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'assigned-locale-method',
    source:
      'export function Widget(){let format:unknown;({toLocaleString:format}=Number.prototype);return <p>{String((format as (this:number)=>string).call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'nested-assigned-locale',
    source:
      'export function Widget(){let format:unknown;({a:{toLocaleString:format}}={a:Number.prototype});return <p>{String((format as (this:number)=>string).call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'array-assigned-locale',
    source:
      'export function Widget(){let format:unknown;[{toLocaleString:format}]=[Number.prototype];return <p>{String((format as (this:number)=>string).call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'default-target-assigned-locale',
    source:
      'export function Widget(){let format:unknown;({a:{toLocaleString:format}={}}={a:Number.prototype});return <p>{String((format as (this:number)=>string).call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'default-target-custom-locale',
    source:
      'export function Widget(){let format:unknown;({a:{toLocaleString:format}={toLocaleString:()=>"fixed"}}={a:Number.prototype});return <p>{String((format as (this:number)=>string).call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'loop-assigned-locale',
    source:
      'export function Widget(){let format:unknown;for({toLocaleString:format} of [Number.prototype]){}return <p>{String((format as (this:number)=>string).call(1234.5))}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'key-loop-assigned-locale',
    source:
      'export function Widget(){let format:unknown;for({toLocaleString:format} in {a:1}){}return <p>{String(typeof format)}</p>;}',
    input: LOCALE_TEXT,
    client: true,
    reader: true,
  },
  {
    id: 'direct-assigned-custom-method',
    source:
      'export function Widget(){let format:unknown;({toLocaleString:format}={toLocaleString:()=>"fixed"});return <p>{String((format as ()=>string)())}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'assigned-object-value',
    source:
      'export function Widget(){let value:unknown;value={toLocaleString:()=>"fixed"};return <p>{String(typeof value)}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'array-of-object-values',
    source:
      'export function Widget(){let values:unknown;values=[{toLocaleString:()=>"fixed"}];return <p>{String(typeof values)}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'named-custom-locale-method',
    source:
      'export function Widget(){const value={toLocaleString:()=>"fixed"};const {toLocaleString}=value;return <p>{toLocaleString()}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'literal-custom-locale-method',
    source:
      'export function Widget(){const {toLocaleString}={toLocaleString:()=>"fixed"};return <p>{toLocaleString()}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'shadowed-number-locale',
    source:
      'export function Widget(){const Number={prototype:{toLocaleString:()=>"fixed"}};const {toLocaleString}=Number.prototype;return <p>{toLocaleString()}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'own-date-locale-data',
    source:
      'export function Widget(){const date=new Date(0);date.toLocaleString=()=>"fixed";const {toLocaleString}=date;return <p>{toLocaleString()}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'plain-text-method',
    source:
      'export function Widget(){const {toString}=Number.prototype;return <p>{String(toString.call(1234.5))}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'unknown-key-locale',
    source:
      'export function Widget({name}:{name:string}){const {[name]:read}=Number.prototype as unknown as Record<string,unknown>;return <p>{String(typeof read)}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'rest-locale-copy',
    source:
      'export function Widget(){const {...rest}=Number.prototype;return <p>{String(Object.keys(rest).length)}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'object-literal-entry',
    source:
      'export function Widget(){const format=()=>"fixed";const value={toLocaleString:format};return <p>{String(typeof value)}</p>;}',
    input: null,
    client: true,
    reader: true,
  },
  {
    id: 'destructured-locale-event-only',
    source:
      'export function Widget(){return <button onClick={()=>{const {toLocaleString}=Number.prototype;console.log(toLocaleString.call(1234.5));}}>fixed</button>;}',
    input: null,
    client: true,
    reader: false,
  },
  {
    id: 'destructured-locale-effect-only',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{const {toLocaleString}=Number.prototype;console.log(toLocaleString.call(1234.5));},[]);return <p>fixed</p>;}',
    input: null,
    client: true,
    reader: false,
  },
] as const;

describe('destructured locale member readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-locale-patterns.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('destructured locale member route renders', () => {
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

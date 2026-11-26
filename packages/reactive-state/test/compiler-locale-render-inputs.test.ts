import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Rendered locale operations retain local inputs while callbacks and written data keep their meaning. */
const CASES = [
  {
    id: 'number-locale',
    source: 'export function Widget(){return <p>{String((1234).toLocaleString())}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'string-compare',
    source: "export function Widget(){return <p>{String('a'.localeCompare('b'))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'string-lower',
    source: "export function Widget(){return <p>{String('I'.toLocaleLowerCase())}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'string-upper',
    source: "export function Widget(){return <p>{String('i'.toLocaleUpperCase())}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'number-alias',
    source:
      'export function Widget(){const value=1234;return <p>{String(value.toLocaleString())}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'bracket-locale',
    source: "export function Widget(){return <p>{String((1234)['toLocaleString']())}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'date-native-string',
    source: 'export function Widget(){return <p>{String(String(new Date(0)))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'provided-locale',
    source: "export function Widget(){return <p>{String((1234).toLocaleString('en-US'))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'plain-number-text',
    source: 'export function Widget(){return <p>{String((1234).toString())}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'plain-lower-text',
    source: "export function Widget(){return <p>{String('I'.toLowerCase())}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'utc-date-text',
    source: 'export function Widget(){return <p>{String(new Date(0).toISOString())}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'custom-locale-method',
    source:
      'export function Widget(){const value={toLocaleString:()=>"fixed"};return <p>{String(value.toLocaleString())}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'custom-compare-method',
    source:
      "export function Widget(){const value={localeCompare:(_value:string)=>0};return <p>{String(value.localeCompare('b'))}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'own-date-locale-data',
    source:
      'export function Widget(){const date=new Date(0);date.toLocaleString=()=>"fixed";return <p>{String(date.toLocaleString())}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'locale-event-only',
    source:
      'export function Widget(){return <button onClick={()=>console.log((1234).toLocaleString())}>fixed</button>;}',
    refused: false,
    reader: false,
  },
  {
    id: 'locale-effect-only',
    source:
      "import {useEffect} from 'react';export function Widget(){useEffect(()=>{console.log('a'.localeCompare('b'));},[]);return <p>fixed</p>;}",
    refused: false,
    reader: false,
  },
] as const;

describe('locale render readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-locale.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(refused);
  });
});

describe('locale route render inputs', () => {
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

import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Rendered locale operations retain local inputs while callbacks and written data keep their meaning. */
const CASES = [
  {
    id: 'number-default',
    source: 'export function Widget(){return <p>{new Intl.NumberFormat().format(1234)}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'collator-default',
    source: "export function Widget(){return <p>{Intl.Collator().compare('a','b')}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'number-resolved',
    source:
      'export function Widget(){return <p>{new Intl.NumberFormat().resolvedOptions().locale}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'date-default-zone',
    source: "export function Widget(){return <p>{new Intl.DateTimeFormat('en-US').format(0)}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'formatter-alias',
    source:
      'export function Widget(){const made=new Intl.NumberFormat();const formatter=made;return <p>{formatter.format(1234)}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'constructor-alias',
    source:
      'export function Widget(){const NumberFormat=Intl.NumberFormat;const formatter=new NumberFormat();return <p>{formatter.format(1234)}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'undefined-locale',
    source: 'export function Widget(){return <p>{Intl.NumberFormat(undefined).format(1234)}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'empty-locale-list',
    source: 'export function Widget(){return <p>{new Intl.NumberFormat([]).format(1234)}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'fixed-number-locale',
    source:
      "export function Widget(){return <p>{new Intl.NumberFormat('en-US').format(1234)}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'fixed-collator-locale',
    source: "export function Widget(){return <p>{Intl.Collator('en-US').compare('a','b')}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'fixed-date-zone',
    source:
      "export function Widget(){return <p>{new Intl.DateTimeFormat('en-US',{timeZone:'UTC'}).format(0)}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'fixed-locale-alias',
    source:
      "export function Widget(){const locale='en-US';return <p>{new Intl.NumberFormat(locale).format(1234)}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'fixed-formatter-alias',
    source:
      "export function Widget(){const made=new Intl.NumberFormat('en-US');const formatter=made;return <p>{formatter.format(1234)}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'shadow-intl',
    source:
      'export function Widget(){const Intl={NumberFormat:class{format(){return "fixed";}}};return <p>{new Intl.NumberFormat().format(1234)}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'shadow-constructor',
    source:
      'export function Widget(){const NumberFormat=class{format(){return "fixed";}};return <p>{new NumberFormat().format(1234)}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'ordinary-format-method',
    source:
      'export function Widget(){const formatter={format:()=>"fixed"};return <p>{formatter.format(1234)}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'other-lexical-formatter',
    source:
      'export function Widget(){const formatter={format:()=>"fixed"};{const formatter=new Intl.NumberFormat();void formatter;}return <p>{formatter.format(1234)}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'formatter-event-only',
    source:
      'export function Widget(){return <button onClick={()=>console.log(new Intl.NumberFormat().format(1234))}>fixed</button>;}',
    refused: false,
    reader: false,
  },
  {
    id: 'formatter-effect-only',
    source:
      "import {useEffect} from 'react';export function Widget(){useEffect(()=>{console.log(Intl.Collator().compare('a','b'));},[]);return <p>fixed</p>;}",
    refused: false,
    reader: false,
  },
] as const;

describe('intl formatter render readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-locale.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(refused);
  });
});

describe('intl formatter route render inputs', () => {
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

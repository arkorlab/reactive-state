import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Rendered locale operations retain local inputs while callbacks and written data keep their meaning. */
const CASES = [
  {
    id: 'RelativeTimeFormat-default',
    source:
      "export function Widget(){return <p>{new Intl.RelativeTimeFormat().format(-1,'day')}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'RelativeTimeFormat-fixed',
    source:
      'export function Widget(){return <p>{new Intl.RelativeTimeFormat("en-US").format(-1,\'day\')}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'RelativeTimeFormat-resolved',
    source:
      'export function Widget(){return <p>{new Intl.RelativeTimeFormat().resolvedOptions().locale}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'ListFormat-default',
    source: "export function Widget(){return <p>{new Intl.ListFormat().format(['a','b'])}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'ListFormat-fixed',
    source:
      "export function Widget(){return <p>{new Intl.ListFormat(\"en-US\").format(['a','b'])}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'ListFormat-resolved',
    source:
      'export function Widget(){return <p>{new Intl.ListFormat().resolvedOptions().locale}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'PluralRules-default',
    source: 'export function Widget(){return <p>{new Intl.PluralRules().select(2)}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'PluralRules-fixed',
    source: 'export function Widget(){return <p>{new Intl.PluralRules("en-US").select(2)}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'PluralRules-resolved',
    source:
      'export function Widget(){return <p>{new Intl.PluralRules().resolvedOptions().locale}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'relative-parts',
    source:
      "export function Widget(){return <p>{String(new Intl.RelativeTimeFormat().formatToParts(-1,'day'))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'list-parts',
    source:
      "export function Widget(){return <p>{String(new Intl.ListFormat().formatToParts(['a','b']))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'plural-range',
    source: 'export function Widget(){return <p>{new Intl.PluralRules().selectRange(1,2)}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'relative-constructor-alias',
    source:
      "export function Widget(){const Relative=Intl.RelativeTimeFormat;return <p>{new Relative().format(-1,'day')}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'list-instance-alias',
    source:
      "export function Widget(){const original=new Intl.ListFormat();const formatter=original;return <p>{formatter.format(['a','b'])}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'relative-local-intl',
    source:
      "export function Widget(){const Intl={RelativeTimeFormat:class{format(){return'fixed';}}};return <p>{new Intl.RelativeTimeFormat().format()}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'plural-local-constructor',
    source:
      "export function Widget(){const PluralRules=class{select(){return'fixed';}};return <p>{new PluralRules().select()}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'ordinary-format-data',
    source:
      "export function Widget(){const formatter={format:()=> 'fixed'};return <p>{formatter.format()}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'relative-event-deferred',
    source:
      "export function Widget(){return <button onClick={()=>console.log(new Intl.RelativeTimeFormat().format(-1,'day'))}>fixed</button>;}",
    refused: false,
    reader: false,
  },
  {
    id: 'list-effect-deferred',
    source:
      "import {useEffect} from 'react';export function Widget(){useEffect(()=>{console.log(new Intl.ListFormat().format(['a','b']));},[]);return <p>fixed</p>;}",
    refused: false,
    reader: false,
  },
  {
    id: 'native-relative-own-format-data',
    source:
      'export function Widget(){const formatter=new Intl.RelativeTimeFormat();formatter.format=()=>"fixed";return <p>{formatter.format(-1,"day")}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'native-relative-own-clock-stays-private',
    source:
      'export function Widget(){const formatter=new Intl.RelativeTimeFormat();formatter.format=()=>String(Date.now());return <p>{formatter.format(-1,"day")}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'native-relative-own-unknown-stays-private',
    source:
      'export function Widget({text="fixed"}:{text?:string}={}){const formatter=new Intl.RelativeTimeFormat();formatter.format=()=>text;return <p>{formatter.format(-1,"day")}</p>;}',
    refused: true,
    reader: true,
  },
];

describe('additional intl formatter readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-locale.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(refused);
  });
});

describe('additional intl formatter route inputs', () => {
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

import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native join separator text retains source-known Date render inputs and existing opacity. */
const CASES = [
  {
    id: 'reported-Date-separator',
    source: "export function Widget(){return <p>{['a','b'].join(new Date(0) as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'bracket-native-join',
    source: "export function Widget(){return <p>{['a','b']['join'](new Date(0) as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'fixed-ISO-Date-separator',
    source:
      "export function Widget(){return <p>{['a','b'].join(new Date('2020-01-01T00:00:00Z') as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'whole-Date-separator-alias',
    source:
      "export function Widget(){const separator=new Date(0);return <p>{['a','b'].join(separator as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'whole-Date-alias-chain',
    source:
      "export function Widget(){const date=new Date(0);const separator=date;return <p>{['a','b'].join(separator as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'Date-holder-field-separator',
    source:
      "export function Widget(){const box={date:new Date(0)};return <p>{['a','b'].join(box.date as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'Date-holder-bracket-field',
    source:
      "export function Widget(){const box={date:new Date(0)};return <p>{['a','b'].join(box['date'] as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'whole-receiver-alias',
    source:
      "export function Widget(){const values=['a','b'];return <p>{values.join(new Date(0) as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'whole-receiver-alias-chain',
    source:
      "export function Widget(){const first=['a','b'];const values=first;return <p>{values.join(new Date(0) as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'Date-array-separator',
    source: "export function Widget(){return <p>{['a','b'].join([new Date(0)] as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'nested-Date-array-separator',
    source: "export function Widget(){return <p>{['a','b'].join([[new Date(0)]] as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'Date-array-separator-alias',
    source:
      "export function Widget(){const separator=[new Date(0)];return <p>{['a','b'].join(separator as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'quiet-ignored-join-tail',
    source:
      "export function Widget(){const values=['a','b'] as unknown as {join(...values:unknown[]):string};return <p>{values.join(new Date(0),0)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'empty-array-reads-separator',
    source: 'export function Widget(){return <p>{[].join(new Date(0) as never)}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'single-array-reads-separator',
    source: "export function Widget(){return <p>{['a'].join(new Date(0) as never)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'hole-array-separator',
    source: 'export function Widget(){return <p>{[,,].join(new Date(0) as never)}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'primitive-separator-data',
    source: "export function Widget(){return <p>{['a','b'].join('-')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'invalid-Date-separator-data',
    source: "export function Widget(){return <p>{['a','b'].join(new Date(1e20) as never)}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'UTC-separator-data',
    source: "export function Widget(){return <p>{['a','b'].join(new Date(0).toUTCString())}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'ISO-separator-data',
    source: "export function Widget(){return <p>{['a','b'].join(new Date(0).toISOString())}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'numeric-Date-separator-data',
    source:
      "export function Widget(){return <p>{['a','b'].join(new Date(0).valueOf() as never)}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'own-Date-text-data',
    source:
      "export function Widget(){const separator=new Date(0);separator.toString=()=>\"fixed\";return <p>{['a','b'].join(separator as never)}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'own-array-join-data',
    source:
      "export function Widget(){const values=['a','b'];values.join=()=> 'fixed';return <p>{values.join(new Date(0) as never)}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'own-object-join-data',
    source:
      "export function Widget(){const values={join(_separator:unknown){return 'fixed';}};return <p>{values.join(new Date(0))}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'toString-ignores-Date-argument',
    source:
      "export function Widget(){const values=['a','b'] as unknown as {toString(...values:unknown[]):string};return <p>{values.toString(new Date(0))}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'prior-Date-hook-mutation-data',
    source:
      "export function Widget(){function prepare(){separator.toString=()=>\"fixed\";}const separator=new Date(0);prepare();return <p>{['a','b'].join(separator as never)}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'unknown-ignored-tail-boundary',
    source:
      "export function Widget(){function prepare(){return 0;}const values=['a','b'] as unknown as {join(...values:unknown[]):string};return <p>{values.join(new Date(0),prepare())}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'unknown-receiver-call-boundary',
    source:
      "export function Widget(){function values(){return ['a','b'];}return <p>{values().join(new Date(0) as never)}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'getter-Date-source-boundary',
    source:
      "export function Widget(){const box={get date(){return new Date(0);}};return <p>{['a','b'].join(box.date as never)}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'captured-Date-hook-boundary',
    source:
      "export function Widget(){const separator=new Date(0);function text(prepare:()=>void){prepare();return ['a','b'].join(separator as never);}return <p>{text(()=>{separator.toString=()=> 'fixed';})}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'own-Date-array-text-data',
    source:
      "export function Widget(){const separator=[new Date(0)];separator.toString=()=>\"fixed\";return <p>{['a','b'].join(separator as never)}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'existing-Date-elements-pin',
    source: "export function Widget(){return <p>{[new Date(0)].join('-')}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'existing-Date-toString-pin',
    source: 'export function Widget(){return <p>{[new Date(0)].toString()}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'event-join-stays-shared',
    source:
      "export function Widget(){return <button onClick={()=>{['a','b'].join(new Date(0) as never);}}>fixed</button>;}",
    input: null,
    private: false,
  },
  {
    id: 'effect-join-stays-shared',
    source:
      "import {useEffect} from 'react';export function Widget(){useEffect(()=>{['a','b'].join(new Date(0) as never);},[]);return <p>fixed</p>;}",
    input: null,
    private: false,
  },
  // The elements render whatever the separator: one the compile reads but cannot prove written —
  // a call, a member read — adds no Date text of its own, and takes none away.
  {
    id: 'coowned-call-separator',
    source:
      "export function Widget(){const sep=()=>'-';return <p>{[new Date(0)].join(sep())}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'member-read-separator',
    source:
      "export function Widget(){const box={sep:'-'};return <p>{[new Date(0)].join(box.sep)}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'coowned-call-separator-data',
    source: "export function Widget(){const sep=()=>'-';return <p>{['a','b'].join(sep())}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'member-read-separator-data',
    source:
      "export function Widget(){const box={sep:'-'};return <p>{['a','b'].join(box.sep)}</p>;}",
    input: false,
    private: false,
  },
] as const;

describe('native join Date separator readers', () => {
  it.each(CASES.filter((row) => row.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-join-date-separator.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('native join Date separator route renders', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, private: privateRender }) => {
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
    const expected = { refusals: [], shared: !privateRender, private: privateRender };

    expect(found).toStrictEqual(expected);
  });
});

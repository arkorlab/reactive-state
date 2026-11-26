import { describe, expect, it } from 'vitest';

import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native padding converts only a consumed fill after quiet original argument evaluation. */
const CASES = [
  {
    id: 'reported-pad-start',
    source: `export function Widget(){return <p>{''.padStart(70,new Date(0) as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'pad-end',
    source: `export function Widget(){return <p>{''.padEnd(70,new Date(0) as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'constant-fill-alias',
    source: `export function Widget(){const fill=new Date(0);return <p>{''.padStart(70,fill as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'constant-receiver-alias',
    source: `export function Widget(){const text='prefix';return <p>{text.padEnd(70,new Date(0) as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'finite-date-array-fill',
    source: `export function Widget(){return <p>{''.padStart(70,[new Date(0)] as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-native-call',
    source: `export function Widget(){return <p>{String.prototype.padStart.call('',70,new Date(0) as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-native-apply',
    source: `export function Widget(){return <p>{String.prototype.padEnd.apply('',[70,new Date(0) as never])}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'reflected-native-apply',
    source: `export function Widget(){return <p>{Reflect.apply(String.prototype.padStart,'',[70,new Date(0)])}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-method-alias',
    source: `export function Widget(){const pad=String.prototype.padStart;return <p>{pad.call('',70,new Date(0) as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'finite-readonly-spread',
    source: `export function Widget(){const args=[70,new Date(0) as never] as const;return <p>{''.padStart(...args)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'fixed-fill',
    source: `export function Widget(){return <p>{'x'.padStart(3,'0')}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'fixed-utc-text',
    source: `export function Widget(){return <p>{''.padStart(70,new Date(0).toISOString())}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'length-already-sufficient',
    source: `export function Widget(){return <p>{'fixed'.padStart(2,new Date(0) as never)}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'numeric-date-length',
    source: `export function Widget(){return <p>{''.padStart(new Date(0) as never,'fixed')}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'ordinary-own-method',
    source: `export function Widget(){const receiver={padStart:(_length:number,_fill:Date)=>'fixed'};return <p>{receiver.padStart(70,new Date(0))}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'own-date-text',
    source: `export function Widget(){const date=new Date(0);date.toString=()=> 'fixed';return <p>{''.padStart(70,date as never)}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'ignored-date-tail',
    source: `export function Widget(){return <p>{Reflect.apply(String.prototype.padEnd,'',[3,'0',new Date(0)])}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'event-only',
    source: `export function Widget(){return <button onClick={()=>''.padStart(70,new Date(0) as never)}>fixed</button>;}`,
    owner: true,
    input: true,
    private: false,
  },
  // pad the text: the fill's Date text stays.
  {
    id: 'unread-width-Date-fill',
    source: `export function Widget(){const render=(width:number)=>'x'.padStart(width,[new Date(0)] as unknown as string);return <p>{render(40)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'unread-width-text-fill-data',
    source: `export function Widget(){const render=(width:number)=>'x'.padStart(width,'-');return <p>{render(40)}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'unresolved-spread-Date-fill',
    source: `export function Widget(){const render=(head:readonly number[])=>'x'.padEnd(...(head as [number]),[new Date(0)] as unknown as string);return <p>{render([40])}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'unresolved-spread-text-fill-data',
    source: `export function Widget(){const render=(head:readonly number[])=>'x'.padEnd(...(head as [number]),'-');return <p>{render([40])}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
] as const;

describe('native string padding Date owner boundaries', () => {
  it.each(CASES)('$id', ({ source, owner }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-assignment-owner.tsx', source);
    const read = firstIn(
      [parsed.sourceFile],
      (node) => renderDateConversion(node),
      () => false,
    );

    expect(read !== undefined).toBe(owner);
  });
});

describe('native string padding Date readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-addition.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('native string padding Date route renders', () => {
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

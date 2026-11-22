import { describe, expect, it } from 'vitest';

import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Finite native join arguments retain their original evaluated inputs and Date text sources. */
const CASES = [
  {
    id: 'direct-finite-spread',
    source: `export function Widget(){return <p>{[new Date(0)].join(...[''] as const)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'direct-const-spread',
    source: `export function Widget(){const args=[''] as const;return <p>{[new Date(0)].join(...args)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'direct-let-spread',
    source: `export function Widget(){let args:['']=[''];return <p>{[new Date(0)].join(...args)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'direct-nested-spread',
    source: `export function Widget(){return <p>{[new Date(0)].join(...[...[''] as const] as const)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'direct-empty-default',
    source: `export function Widget(){return <p>{[new Date(0)].join(...[] as const)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'direct-undefined-default',
    source: `export function Widget(){return <p>{[new Date(0)].join(...[undefined] as const)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'direct-let-array',
    source: `export function Widget(){let dates=[new Date(0)];return <p>{dates.join(...[''] as const)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'direct-date-separator',
    source: `export function Widget(){return <p>{['x','y'].join(...[new Date(0) as unknown as string] as const)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'direct-nested-date-separator',
    source: `export function Widget(){return <p>{['x','y'].join(...[[new Date(0)] as unknown as string] as const)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-call',
    source: `export function Widget(){return <p>{Array.prototype.join.call([new Date(0)],...[''] as const)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-apply',
    source: `export function Widget(){return <p>{Array.prototype.join.apply([new Date(0)],[...[''] as const])}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-reflect',
    source: `export function Widget(){return <p>{Reflect.apply(Array.prototype.join,[new Date(0)],[...[''] as const])}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-bound',
    source: `export function Widget(){return <p>{Array.prototype.join.bind([new Date(0)])(...[''] as const)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'direct-existing-date',
    source: `export function Widget(){return <p>{[new Date(0)].join('')}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'direct-scalar-fixed',
    source: `export function Widget(){return <p>{[1,'x'].join(...['|'] as const)}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'direct-empty-scalar-fixed',
    source: `export function Widget(){return <p>{[1,'x'].join(...[] as const)}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'direct-fixed-iso',
    source: `export function Widget(){return <p>{[new Date(0).toISOString()].join(...[''] as const)}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'direct-own-join',
    source: `export function Widget(){const dates=[new Date(0)];dates.join=()=> 'fixed';return <p>{dates.join(...[''] as const)}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'direct-own-date',
    source: `export function Widget(){const dates=[new Date(0)];dates[0]!.toString=()=> 'fixed';return <p>{dates.join(...[''] as const)}</p>;}`,
    owner: false,
    input: true,
    private: true,
  },
  {
    id: 'direct-effectful-spread',
    source: `export function Widget(){const dates=[new Date(0)];return <p>{dates.join(...[(dates[0]!.toString=()=> 'fixed','')] as const)}</p>;}`,
    owner: false,
    input: true,
    private: true,
  },
  {
    id: 'direct-local-date',
    source: `export function Widget(){class Date{constructor(_value:number){}toString(){return 'fixed';}}return <p>{[new Date(0)].join(...[''] as const)}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'direct-captured-array',
    source: `export function Widget(){const dates=[new Date(0)];const render=()=>dates.join(...[''] as const);return <p>{render()}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-replaced-invoker',
    source: `export function Widget(){const dates=[new Date(0)];Array.prototype.join.call=()=> 'fixed';return <p>{Array.prototype.join.call(dates,...[''] as const)}</p>;}`,
    owner: false,
    input: false,
    private: true,
  },
  {
    id: 'event-only',
    source: `export function Widget(){return <button onClick={()=>[new Date(0)].join(...[''] as const)}>fixed</button>;}`,
    owner: true,
    input: true,
    private: false,
  },
  {
    id: 'direct-toString-empty',
    source: `export function Widget(){return <p>{[new Date(0)].toString(...[] as const)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'empty-array-date-separator-policy',
    source: `export function Widget(){return <p>{[].join(...[new Date(0) as unknown as string] as const)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
] as const;

describe('native Date join spread owner boundaries', () => {
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

describe('native Date join spread readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-addition.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('native Date join spread route renders', () => {
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

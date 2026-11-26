import { describe, expect, it } from 'vitest';

import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Immediate local native array text calls retain captured Date inputs at the original invocation. */
const CASES = [
  {
    id: 'immediate-captured-join-spread',
    source:
      "export function Widget(){const dates=[new Date(0)];const render=()=>dates.join(...[''] as const);return <p>{render()}</p>;}",
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'immediate-captured-join-default',
    source:
      'export function Widget(){const dates=[new Date(0)];const render=()=>dates.join();return <p>{render()}</p>;}',
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'immediate-captured-toString',
    source:
      'export function Widget(){const dates=[new Date(0)];const render=()=>dates.toString();return <p>{render()}</p>;}',
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'immediate-captured-function',
    source:
      "export function Widget(){const dates=[new Date(0)];const render=function(){return dates.join('');};return <p>{render()}</p>;}",
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'immediate-captured-scalar',
    source:
      "export function Widget(){const dates=[1,'x'];const render=()=>dates.join(...['|'] as const);return <p>{render()}</p>;}",
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'immediate-captured-iso',
    source:
      "export function Widget(){const dates=[new Date(0).toISOString()];const render=()=>dates.join('');return <p>{render()}</p>;}",
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'replaced-own-join-before-call',
    source:
      "export function Widget(){const dates=[new Date(0)];const render=()=>dates.join('');dates.join=()=> 'fixed';return <p>{render()}</p>;}",
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'replaced-date-before-call',
    source:
      "export function Widget(){const dates=[new Date(0)];const render=()=>dates.join('');dates[0]!.toString=()=> 'fixed';return <p>{render()}</p>;}",
    owner: false,
    input: true,
    private: true,
  },
  {
    id: 'replaced-element-before-call',
    source:
      "export function Widget(){const dates=[new Date(0)];const render=()=>dates.join('');dates[0]=new Date(NaN);return <p>{render()}</p>;}",
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'ignored-argument-effect',
    source:
      "export function Widget(){const dates=[new Date(0)];const render=(..._ignored:unknown[])=>dates.join('');return <p>{render((dates[0]!.toString=()=> 'fixed'))}</p>;}",
    owner: false,
    input: true,
    private: true,
  },
  {
    id: 'application-callback-not-called',
    source:
      "export function Widget(){const dates=[new Date(0)];const render=()=>dates.join('');const invoke=(_callback:()=>string)=> 'fixed';return <p>{invoke(render)}</p>;}",
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'event-only-captured',
    source:
      "export function Widget(){const dates=[new Date(0)];const render=()=>dates.join('');return <button onClick={()=>render()}>fixed</button>;}",
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'deferred-reference-only',
    source:
      "export function Widget(){const dates=[new Date(0)];const render=()=>dates.join('');return <button onClick={render}>fixed</button>;}",
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'immediate-captured-date-separator',
    source:
      "export function Widget(){const separator=[new Date(0)];const render=()=>['x','y'].join(separator);return <p>{render()}</p>;}",
    owner: true,
    input: true,
    private: true,
  },
] as const;

describe('immediate captured Date array owner boundaries', () => {
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

describe('immediate captured Date array readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-addition.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('immediate captured Date array route renders', () => {
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

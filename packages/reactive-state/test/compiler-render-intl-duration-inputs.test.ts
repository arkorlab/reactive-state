import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native DurationFormat methods retain their default-locale input during rendering. */
const CASES = [
  {
    id: 'reported-default-format',
    source:
      'export function Widget(){return <p>{new Intl.DurationFormat().format({hours:1})}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'default-format-to-parts',
    source:
      'export function Widget(){return <p>{JSON.stringify(new Intl.DurationFormat().formatToParts({hours:1}))}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'default-resolved-locale',
    source:
      'export function Widget(){return <p>{new Intl.DurationFormat().resolvedOptions().locale}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'default-constructor-alias',
    source:
      'export function Widget(){const Duration=Intl.DurationFormat;return <p>{new Duration().format({hours:1})}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'default-stored-projection',
    source:
      'export function Widget(){const box={formatter:new Intl.DurationFormat()};return <p>{box.formatter.format({hours:1})}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'default-captured-instance',
    source:
      'const formatter=new Intl.DurationFormat();export function Widget(){return <p>{formatter.format({hours:1})}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'default-borrowed-format',
    source:
      'export function Widget(){return <p>{Intl.DurationFormat.prototype.format.call(new Intl.DurationFormat(),{hours:1})}</p>;}',
    input: true,
    private: true,
  },
  {
    id: 'fixed-locale-format',
    source:
      "export function Widget(){return <p>{new Intl.DurationFormat('en-US').format({hours:1})}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'fixed-locale-format-to-parts',
    source:
      "export function Widget(){return <p>{JSON.stringify(new Intl.DurationFormat('en-US').formatToParts({hours:1}))}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'own-fixed-format',
    source:
      "export function Widget(){const formatter=new Intl.DurationFormat();formatter.format=()=> 'fixed';return <p>{formatter.format({hours:1})}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'lexical-intl-shadow',
    source:
      "export function Widget(){const Intl={DurationFormat:class{format(_duration:{hours:number}){return 'fixed';}}};return <p>{new Intl.DurationFormat().format({hours:1})}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'deferred-event-format',
    source:
      'export function Widget(){return <button onClick={()=>new Intl.DurationFormat().format({hours:1})}>fixed</button>;}',
    input: null,
    private: false,
  },
  {
    id: 'fixed-number-format-pin',
    source: "export function Widget(){return <p>{new Intl.NumberFormat('en-US').format(1)}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'ordinary-constructor-name',
    source: 'export function Widget(){return <p>{new Intl.DurationFormat().constructor.name}</p>;}',
    input: false,
    private: false,
  },
] as const;

describe('native DurationFormat input reader', () => {
  it.each(CASES.filter((entry) => entry.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'client-multipart.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('native DurationFormat route delivery', () => {
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

    expect({
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    }).toStrictEqual({ refusals: [], shared: !privateRender, private: privateRender });
  });
});

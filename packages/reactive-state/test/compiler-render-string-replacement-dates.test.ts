import { describe, expect, it } from 'vitest';

import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native replacement converts a noncallable replacement after quiet original argument evaluation. */
const CASES = [
  {
    id: 'reported-replace',
    source: `export function Widget(){return <p>{''.replace('',new Date(0) as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'replace-all',
    source: `export function Widget(){return <p>{''.replaceAll('',new Date(0) as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'constant-replacement-alias',
    source: `export function Widget(){const replacement=new Date(0);return <p>{''.replace('',replacement as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'constant-receiver-alias',
    source: `export function Widget(){const text='prefix';return <p>{text.replace('prefix',new Date(0) as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'finite-date-array-replacement',
    source: `export function Widget(){return <p>{''.replace('',[new Date(0)] as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-native-call',
    source: `export function Widget(){return <p>{String.prototype.replace.call('','',new Date(0) as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-native-apply',
    source: `export function Widget(){return <p>{String.prototype.replaceAll.apply('',['',new Date(0) as never])}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'reflected-native-apply',
    source: `export function Widget(){return <p>{Reflect.apply(String.prototype.replace,'',['',new Date(0)])}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-method-alias',
    source: `export function Widget(){const replace=String.prototype.replace;return <p>{replace.call('','',new Date(0) as never)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'finite-readonly-spread',
    source: `export function Widget(){const args=['',new Date(0) as never] as const;return <p>{''.replace(...args)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'fixed-replacement',
    source: `export function Widget(){return <p>{'x'.replace('x','fixed')}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'fixed-utc-text',
    source: `export function Widget(){return <p>{''.replace('',new Date(0).toISOString())}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'known-missing-search',
    source: `export function Widget(){return <p>{'fixed'.replace('missing',new Date(0) as never)}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'fixed-replacement-callback',
    source: `export function Widget(){return <p>{''.replace('',()=> 'fixed')}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'ordinary-own-method',
    source: `export function Widget(){const receiver={replace:(_search:string,_replacement:Date)=>'fixed'};return <p>{receiver.replace('',new Date(0))}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'own-date-text',
    source: `export function Widget(){const date=new Date(0);date.toString=()=> 'fixed';return <p>{''.replace('',date as never)}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'ignored-date-tail',
    source: `export function Widget(){return <p>{Reflect.apply(String.prototype.replaceAll,'',['','fixed',new Date(0)])}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'event-only',
    source: `export function Widget(){return <button onClick={()=>''.replace('',new Date(0) as never)}>fixed</button>;}`,
    owner: true,
    input: true,
    private: false,
  },
] as const;

describe('native string replacement Date owner boundaries', () => {
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

describe('native string replacement Date readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-addition.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('native string replacement Date route renders', () => {
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

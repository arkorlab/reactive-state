import { describe, expect, it } from 'vitest';

import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native replacement search preserves Date text after quiet original argument evaluation. */
const CASES = [
  {
    id: 'reported-date-search',
    source: `export function Widget(){return <p>{'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'.replace(new Date(0) as never,'epoch')}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'replace-all-date-search',
    source: `export function Widget(){return <p>{'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'.replaceAll(new Date(0) as never,'epoch')}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'constant-search-alias',
    source: `export function Widget(){const search=new Date(0);return <p>{'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'.replace(search as never,'epoch')}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'constant-receiver-alias',
    source: `export function Widget(){const text='Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)';return <p>{text.replace(new Date(0) as never,'epoch')}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'finite-date-array-search',
    source: `export function Widget(){return <p>{'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'.replace([new Date(0)] as never,'epoch')}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-native-call',
    source: `export function Widget(){return <p>{String.prototype.replace.call('Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)',new Date(0) as never,'epoch')}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-native-apply',
    source: `export function Widget(){return <p>{String.prototype.replaceAll.apply('Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)',[new Date(0) as never,'epoch'])}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'reflected-native-apply',
    source: `export function Widget(){return <p>{Reflect.apply(String.prototype.replace,'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)',[new Date(0),'epoch'])}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-method-alias',
    source: `export function Widget(){const replace=String.prototype.replace;return <p>{replace.call('Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)',new Date(0) as never,'epoch')}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'finite-readonly-spread',
    source: `export function Widget(){const args=[new Date(0) as never,'epoch'] as const;return <p>{'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'.replace(...args)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'fixed-string-search',
    source: `export function Widget(){return <p>{'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'.replace('Thu','Thursday')}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'fixed-iso-search',
    source: `export function Widget(){return <p>{'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'.replace(new Date(0).toISOString(),'epoch')}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'ordinary-own-method',
    source: `export function Widget(){const receiver={replace:(_search:Date,_replacement:string)=>'fixed'};return <p>{receiver.replace(new Date(0),'epoch')}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'own-date-text',
    source: `export function Widget(){const date=new Date(0);date.toString=()=> 'missing';return <p>{'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'.replace(date as never,'epoch')}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'ordinary-symbol-replace',
    source: `export function Widget(){const search={[Symbol.replace]:()=> 'fixed'};return <p>{'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'.replace(search,'epoch')}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'date-own-symbol-replace',
    source: `export function Widget(){const search=new Date(0);Object.defineProperty(search,Symbol.replace,{value:()=> 'fixed'});return <p>{'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'.replace(search as never,'epoch')}</p>;}`,
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
    id: 'event-only',
    source: `export function Widget(){return <button onClick={()=>'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'.replace(new Date(0) as never,'epoch')}>fixed</button>;}`,
    owner: true,
    input: true,
    private: false,
  },
] as const;

describe('native string replacement search Date owner boundaries', () => {
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

describe('native string replacement search Date readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-addition.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('native string replacement search Date route renders', () => {
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

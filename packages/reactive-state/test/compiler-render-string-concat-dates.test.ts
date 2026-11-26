import { describe, expect, it } from 'vitest';

import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native string concatenation retains Date inputs after quiet original argument evaluation. */
const CASES = [
  {
    id: 'reported-scalar-date',
    source: `export function Widget(){return <p>{''.concat(new Date(0) as unknown as string)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'constant-date-alias',
    source: `export function Widget(){const date=new Date(0);return <p>{''.concat(date as unknown as string)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'constant-receiver-alias',
    source: `export function Widget(){const text='prefix';return <p>{text.concat(new Date(0) as unknown as string)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'date-array-input',
    source: `export function Widget(){return <p>{''.concat([new Date(0)] as unknown as string)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'finite-spread-input',
    source: `export function Widget(){return <p>{''.concat(...[new Date(0) as unknown as string] as const)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-native-call',
    source: `export function Widget(){return <p>{String.prototype.concat.call('',new Date(0) as unknown as string)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'borrowed-method-alias',
    source: `export function Widget(){const concat=String.prototype.concat;return <p>{concat.call('',new Date(0) as unknown as string)}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'fixed-string-input',
    source: `export function Widget(){const text='prefix';return <p>{text.concat('fixed')}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'fixed-utc-text',
    source: `export function Widget(){return <p>{''.concat(new Date(0).toISOString())}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'empty-readonly-arguments',
    source: `export function Widget(){const args=[] as const;return <p>{''.concat(...args)}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'ordinary-own-concat',
    source: `export function Widget(){const receiver={concat:(_value:Date)=>'fixed'};return <p>{receiver.concat(new Date(0))}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'own-date-text-replacement',
    source: `export function Widget(){const date=new Date(0);date.toString=()=> 'fixed';return <p>{''.concat(date as unknown as string)}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'event-only',
    source: `export function Widget(){return <button onClick={()=>''.concat(new Date(0) as unknown as string)}>fixed</button>;}`,
    owner: true,
    input: true,
    private: false,
  },
] as const;

describe('native string concat Date owner boundaries', () => {
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

describe('native string concat Date readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-addition.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('native string concat Date route renders', () => {
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

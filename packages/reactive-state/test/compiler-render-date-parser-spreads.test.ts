import { describe, expect, it } from 'vitest';

import { renderDateParser } from '../src/compiler/render-date-parsers.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Finite parser-alias arguments retain their source text and original evaluation boundaries. */
const CASES = [
  {
    id: 'alias-literal-spread',
    source: `export function Widget(){const parse=Date.parse;return <p>{String(parse(...['2020-01-01T00:00'] as const))}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'alias-const-tuple-spread',
    source: `export function Widget(){const parse=Date.parse;const args=['2020-01-01T00:00'] as const;return <p>{String(parse(...args))}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'alias-whole-chain',
    source: `export function Widget(){const original=Date.parse;const parse=original;const args=['2020-01-01T00:00'] as const;return <p>{String(parse(...args))}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'alias-nested-tuple-spread',
    source: `export function Widget(){const parse=Date.parse;const args=['2020-01-01T00:00'] as const;return <p>{String(parse(...[...args] as const))}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'alias-empty-leading-spread',
    source: `export function Widget(){const parse=Date.parse;return <p>{String(parse(...[] as const,...['2020-01-01T00:00'] as const))}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'global-native-alias-spread',
    source: `export function Widget(){const parse=globalThis.Date.parse;return <p>{String(parse(...['2020-01-01T00:00'] as const))}</p>;}`,
    owner: false,
    input: true,
    private: true,
  },
  {
    id: 'literal-member-native-alias',
    source: `export function Widget(){const parse=Date['parse'];return <p>{String(parse(...['2020-01-01T00:00'] as const))}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'quiet-ignored-tail',
    source: `export function Widget(){const parse=Date.parse as (...args:string[])=>number;return <p>{String(parse(...['2020-01-01T00:00','ignored'] as const))}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'explicit-utc',
    source: `export function Widget(){const parse=Date.parse;return <p>{String(parse(...['2020-01-01T00:00Z'] as const))}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'explicit-offset',
    source: `export function Widget(){const parse=Date.parse;return <p>{String(parse(...['2020-01-01T00:00+02:00'] as const))}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'date-only',
    source: `export function Widget(){const parse=Date.parse;return <p>{String(parse(...['2020-01-01'] as const))}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'empty-arguments',
    source: `export function Widget(){const parse=Date.parse as (...args:string[])=>number;return <p>{String(parse(...[] as const))}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'existing-direct-alias',
    source: `export function Widget(){const parse=Date.parse;return <p>{String(parse('2020-01-01T00:00'))}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'existing-borrowed-spread',
    source: `export function Widget(){const parse=Date.parse;return <p>{String(parse.call(undefined,...['2020-01-01T00:00'] as const))}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'existing-bound-spread',
    source: `export function Widget(){const parse=Date.parse.bind(undefined);return <p>{String(parse(...['2020-01-01T00:00'] as const))}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
  {
    id: 'shadowed-native',
    source: `export function Widget(){const Date={parse:(_input:string)=>0};const parse=Date.parse;return <p>{String(parse(...['2020-01-01T00:00'] as const))}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'source-own-method',
    source: `export function Widget(){Date.parse=(_input:string)=>0;const parse=Date.parse;return <p>{String(parse(...['2020-01-01T00:00'] as const))}</p>;}`,
    owner: false,
    input: false,
    private: true,
  },
  {
    id: 'written-tuple-fixed',
    source: `export function Widget(){const parse=Date.parse;const args:[string]=['2020-01-01T00:00'];args[0]='2020-01-01T00:00Z';return <p>{String(parse(...args))}</p>;}`,
    owner: false,
    input: false,
    private: false,
  },
  {
    id: 'captured-tuple-opacity',
    source: `const args=['2020-01-01T00:00'] as const;export function Widget(){const parse=Date.parse;return <p>{String(parse(...args))}</p>;}`,
    owner: true,
    input: true,
    private: true,
  },
] as const;

describe('native Date parser spread owner boundaries', () => {
  it.each(CASES)('$id', ({ source, owner }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-assignment-owner.tsx', source);
    const read = firstIn(
      [parsed.sourceFile],
      (node) => renderDateParser(node),
      () => false,
    );

    expect(read !== undefined).toBe(owner);
  });
});

describe('native Date parser spread readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-addition.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('native Date parser spread route renders', () => {
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

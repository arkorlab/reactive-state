import { describe, expect, it } from 'vitest';

import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Mutable native Date arrays retain their original consumer inputs and source boundaries. */
const CASES = [
  {
    id: 'let-String',
    source: 'export function Widget(){let dates=[new Date(0)];return <p>{String(dates)}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-template',
    source: `export function Widget(){let dates=[new Date(0)];return <p>{\`\${dates}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-join',
    source: "export function Widget(){let dates=[new Date(0)];return <p>{dates.join('')}</p>;}",
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'const-String',
    source: 'export function Widget(){const dates=[new Date(0)];return <p>{String(dates)}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'const-template',
    source: `export function Widget(){const dates=[new Date(0)];return <p>{\`\${dates}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'const-join',
    source: "export function Widget(){const dates=[new Date(0)];return <p>{dates.join('')}</p>;}",
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-toString',
    source: 'export function Widget(){let dates=[new Date(0)];return <p>{dates.toString()}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-newString',
    source:
      'export function Widget(){let dates=[new Date(0)];return <p>{new String(dates).valueOf()}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-String-call',
    source:
      'export function Widget(){let dates=[new Date(0)];return <p>{String.call(null,dates)}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-String-apply',
    source:
      'export function Widget(){let dates=[new Date(0)];return <p>{String.apply(null,[dates])}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-String-Reflect',
    source:
      'export function Widget(){let dates=[new Date(0)];return <p>{Reflect.apply(String,null,[dates])}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-String-bound',
    source:
      'export function Widget(){let dates=[new Date(0)];return <p>{String.bind(null,dates)()}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-join-call',
    source:
      "export function Widget(){let dates=[new Date(0)];return <p>{Array.prototype.join.call(dates,'')}</p>;}",
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-join-apply',
    source:
      "export function Widget(){let dates=[new Date(0)];return <p>{Array.prototype.join.apply(dates,[''])}</p>;}",
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-join-Reflect',
    source:
      "export function Widget(){let dates=[new Date(0)];return <p>{Reflect.apply(Array.prototype.join,dates,[''])}</p>;}",
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-toString-call',
    source:
      'export function Widget(){let dates=[new Date(0)];return <p>{Array.prototype.toString.call(dates)}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-toString-apply',
    source:
      'export function Widget(){let dates=[new Date(0)];return <p>{Array.prototype.toString.apply(dates,[])}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-join-bound',
    source:
      "export function Widget(){let dates=[new Date(0)];return <p>{Array.prototype.join.bind(dates,'')()}</p>;}",
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-String-saved-bound',
    source:
      'export function Widget(){let dates=[new Date(0)];const convert=String.bind(null,dates);return <p>{convert()}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-join-saved-bound',
    source:
      "export function Widget(){let dates=[new Date(0)];const convert=Array.prototype.join.bind(dates,'');return <p>{convert()}</p>;}",
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'var-String',
    source: 'export function Widget(){var dates=[new Date(0)];return <p>{String(dates)}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'String-const-apply-list',
    source:
      'export function Widget(){let dates=[new Date(0)];const args:[unknown]=[dates];return <p>{String.apply(null,args)}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'reported-String-spread',
    source: 'export function Widget(){return <p>{String(...[new Date(0)] as const)}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'newString-finite-spread',
    source:
      'export function Widget(){return <p>{new String(...[new Date(0)] as const).valueOf()}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-array-in-String-spread',
    source:
      'export function Widget(){let dates=[new Date(0)];return <p>{String(...[dates] as const)}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'let-tuple-String-spread',
    source:
      'export function Widget(){let dates:[Date]=[new Date(0)];return <p>{String(...dates)}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'empty-String-spread',
    source: 'export function Widget(){return <p>{String(...[] as const)}</p>;}',
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'ISO-String-spread',
    source:
      'export function Widget(){return <p>{String(...[new Date(0).toISOString()] as const)}</p>;}',
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'mutable-ISO-array',
    source:
      'export function Widget(){let dates=[new Date(0).toISOString()];return <p>{String(dates)}</p>;}',
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'mutable-scalar-array',
    source: "export function Widget(){let dates=[1,'x',true];return <p>{String(dates)}</p>;}",
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'mutable-empty-array',
    source: 'export function Widget(){let dates:unknown[]=[];return <p>{String(dates)}</p>;}',
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'var-redeclaration',
    source:
      'export function Widget(){var dates:unknown=[new Date(0)];var dates:unknown=["fixed"];return <p>{String(dates)}</p>;}',
    input: true,
    owner: false,
    private: true,
  },
  {
    id: 'captured-own-conversion',
    source:
      "export function Widget(){let dates=[new Date(0)];dates.toString=()=> 'fixed';function text(){return String(dates);}return <p>{text()}</p>;}",
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'own-join-data',
    source:
      "export function Widget(){let dates=[new Date(0)];dates.join=()=> 'fixed';return <p>{dates.toString()}</p>;}",
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'own-toString-data',
    source:
      "export function Widget(){let dates=[new Date(0)];dates.toString=()=> 'fixed';return <p>{String(dates)}</p>;}",
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'ignored-String-effect',
    source:
      "export function Widget(){let dates=[new Date(0)];return <p>{Reflect.apply(String,null,[dates,Date.prototype.toString=()=> 'fixed'])}</p>;}",
    input: true,
    owner: false,
    private: true,
  },
  {
    id: 'ignored-join-effect',
    source:
      "export function Widget(){let dates=[new Date(0)];return <p>{Reflect.apply(Array.prototype.join,dates,['',Date.prototype.toString=()=> 'fixed'])}</p>;}",
    input: true,
    owner: false,
    private: true,
  },
  {
    id: 'bound-ignored-invocation-effect',
    source:
      "export function Widget(){const date=new Date(0);let dates=[date];const convert=String.bind(null,dates);return <p>{Reflect.apply(convert,null,[date.toString=()=> 'fixed'])}</p>;}",
    input: false,
    owner: false,
    private: false,
  },
  {
    id: 'conditional-String',
    source:
      'export function Widget(){if(false){var dates:unknown=[new Date(0)];}return <p>{String(dates)}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'conditional-template',
    source: `export function Widget(){if(false){var dates:unknown=[new Date(0)];}return <p>{\`\${dates}\`}</p>;}`,
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'conditional-String-call',
    source:
      'export function Widget(){if(false){var dates:unknown=[new Date(0)];}return <p>{String.call(null,dates)}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'event-only',
    source:
      'export function Widget(){return <button onClick={()=>{let dates=[new Date(0)];return String(dates);}}>fixed</button>;}',
    input: null,
    owner: null,
    private: false,
  },
  {
    id: 'effect-only',
    source:
      "import{useEffect}from'react';export function Widget(){useEffect(()=>{let dates=[new Date(0)];void String(dates);},[]);return <p>fixed</p>;}",
    input: null,
    owner: null,
    private: false,
  },
  {
    id: 'const-alias-of-mutable-array',
    source:
      'export function Widget(){let dates=[new Date(0)];const alias=dates;return <p>{String(alias)}</p>;}',
    input: true,
    owner: true,
    private: true,
  },
  {
    id: 'var-initializer-after-alias-read',
    source:
      'export function Widget(){const alias=dates;var dates:unknown=[new Date(0)];return <p>{String(alias)}</p>;}',
    input: false,
    owner: false,
    private: false,
  },
] as const;

describe('mutable Date text consumer owner boundaries', () => {
  it.each(CASES.filter((row) => row.owner !== null))('$id', ({ source, owner }) => {
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

describe('mutable Date text consumer readers', () => {
  it.each(CASES.filter((row) => row.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-addition.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('mutable Date text consumer route renders', () => {
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

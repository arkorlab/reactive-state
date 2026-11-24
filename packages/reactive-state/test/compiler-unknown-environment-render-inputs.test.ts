import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Unlisted environment globals are private during render; known data and deferred work stay shared. */
const CASES = [
  {
    id: 'erased-ambient-namespace',
    source:
      'declare namespace Types { namespace Nested { class Data extends File {} } } export function Widget(){return <p>fixed</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'ambient-namespace-runtime-read',
    source:
      'declare namespace Types { const screen: {width:number}; } export function Widget(){return <p>{Types.screen.width}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'screen-width',
    source:
      'export function Widget(){return <p>{typeof screen==="undefined"?"server":String(screen.width)}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'device-pixel-ratio',
    source:
      'export function Widget(){return <p>{typeof devicePixelRatio==="undefined"?"server":String(devicePixelRatio)}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'visual-viewport',
    source:
      'export function Widget(){return <p>{typeof visualViewport==="undefined"?"server":String(visualViewport?.width)}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'unknown-future-global',
    source:
      'declare const futureEnvironmentFlag:string|undefined;export function Widget(){return <p>{typeof futureEnvironmentFlag==="undefined"?"server":"page"}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'shared-buffer-availability',
    source:
      'export function Widget(){return <p>{typeof SharedArrayBuffer==="undefined"?"server":"available"}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'native-language-data',
    source:
      'export function Widget(){return <p>{JSON.stringify(Math.max(1,2))+String(Number.isFinite(2))}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'platform-url-data',
    source:
      'export function Widget(){return <p>{new URL("https://example.test/fixed").hostname}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'platform-text-data',
    source:
      'export function Widget(){return <p>{new TextDecoder().decode(new Uint8Array([65]))}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'module-shadow',
    source: 'const screen={width:7};export function Widget(){return <p>{screen.width}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'local-shadow',
    source: 'export function Widget(){const devicePixelRatio=2;return <p>{devicePixelRatio}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'property-name-data',
    source: 'export function Widget(){const data={screen:"fixed"};return <p>{data.screen}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'undefined-data',
    source: 'export function Widget(){return <p>{String(undefined)}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'event-only',
    source:
      'export function Widget(){return <button onClick={()=>console.log(screen.width)}>fixed</button>;}',
    refused: false,
    reader: false,
  },
  {
    id: 'effect-only',
    source:
      'import {useEffect}from"react";export function Widget(){useEffect(()=>console.log(screen.width),[]);return <p>fixed</p>;}',
    refused: false,
    reader: false,
  },
  {
    id: 'callback-only',
    source:
      'import {useCallback}from"react";export function Widget(){const click=useCallback(()=>console.log(screen.width),[]);return <button onClick={click}>fixed</button>;}',
    refused: false,
    reader: false,
  },
];

describe('unknown environment render readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-platform.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(refused);
  });
});

describe('unknown environment route inputs', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused }) => {
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
    const expected = { refusals: [], shared: !refused, private: refused };

    expect(found).toStrictEqual(expected);
  });
});

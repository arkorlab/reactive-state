import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Browser environment inputs are private during render and remain allowed in deferred handlers. */
const CASES = [
  {
    id: 'navigator-render',
    source: 'export function Widget(){return <p>{navigator.language}</p>;}',
    input: 'navigator',
    reader: true,
  },
  {
    id: 'guarded-localStorage-render',
    source:
      "export function Widget(){return <p>{typeof localStorage==='undefined'?'none':localStorage.getItem('theme')}</p>;}",
    input: 'localStorage',
    reader: true,
  },
  {
    id: 'document-render',
    source: 'export function Widget(){return <p>{document.title}</p>;}',
    input: 'document',
    reader: true,
  },
  {
    id: 'location-render',
    source: 'export function Widget(){return <p>{location.pathname}</p>;}',
    input: 'location',
    reader: true,
  },
  {
    id: 'sessionStorage-render',
    source: "export function Widget(){return <p>{sessionStorage.getItem('theme')}</p>;}",
    input: 'sessionStorage',
    reader: true,
  },
  {
    id: 'indexedDB-render',
    source: 'export function Widget(){return <p>{typeof indexedDB}</p>;}',
    input: 'indexedDB',
    reader: true,
  },
  {
    id: 'animation-callback-render',
    source: 'export function Widget(){return <p>{typeof requestAnimationFrame}</p>;}',
    input: 'requestAnimationFrame',
    reader: true,
  },
  {
    id: 'idle-callback-render',
    source: 'export function Widget(){return <p>{typeof requestIdleCallback}</p>;}',
    input: 'requestIdleCallback',
    reader: true,
  },
  {
    id: 'local-navigator-shadow',
    source:
      'const navigator={language:"fixed"};export function Widget(){return <p>{navigator.language}</p>;}',
    input: null,
    reader: true,
  },
  {
    id: 'local-storage-shadow',
    source:
      'const localStorage={getItem:()=>"fixed"};export function Widget(){return <p>{localStorage.getItem("theme")}</p>;}',
    input: null,
    reader: true,
  },
  {
    id: 'browser-event-only',
    source:
      'export function Widget(){return <button onClick={()=>console.log(navigator.language)}>fixed</button>;}',
    input: null,
    reader: false,
  },
  {
    id: 'browser-effect-only',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{console.log(localStorage.getItem("theme"));},[]);return <p>fixed</p>;}',
    input: null,
    reader: false,
  },
  {
    id: 'browser-useCallback-only',
    source:
      'import {useCallback} from "react";export function Widget(){const click=useCallback(()=>console.log(location.pathname),[]);return <button onClick={click}>fixed</button>;}',
    input: null,
    reader: false,
  },
  {
    id: 'browser-ref-only',
    source: 'export function Widget(){return <p ref={()=>console.log(document.title)}>fixed</p>;}',
    input: null,
    reader: false,
  },
];

describe('browser environment render readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'browser-render-inputs.tsx', `'use client';\n${source}`);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input ?? undefined);
  });
});

describe('browser environment route renders', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, input }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${source}`,
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { Widget } from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){',
        'return <section><Widget />{children}</section>;',
        '}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board).toMatchObject({ shared: input === null });
    expect(board?.private === undefined).toBe(input === null);
  });
});

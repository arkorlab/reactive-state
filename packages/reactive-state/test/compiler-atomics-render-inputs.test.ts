import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Rendered locale operations retain local inputs while callbacks and written data keep their meaning. */
const CASES = [
  {
    id: 'direct-lock-free',
    source:
      'export function Widget({list}:{list:Int32Array}){return <p>{String(Atomics.isLockFree(8))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'computed-lock-free',
    source:
      "export function Widget({list}:{list:Int32Array}){return <p>{String(Atomics['isLockFree'](8))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'global-lock-free',
    source:
      'export function Widget({list}:{list:Int32Array}){return <p>{String(globalThis.Atomics.isLockFree(8))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'native-wait',
    source:
      'export function Widget({list}:{list:Int32Array}){return <p>{String(Atomics.wait(list,0,0,0))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'computed-wait',
    source:
      "export function Widget({list}:{list:Int32Array}){return <p>{String(Atomics['wait'](list,0,0,0))}</p>;}",
    refused: true,
    reader: true,
  },
  {
    id: 'aliased-lock-free',
    source:
      'export function Widget(){const lockFree=Atomics.isLockFree;return <p>{String(lockFree(8))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'destructured-lock-free',
    source:
      'export function Widget(){const {isLockFree}=Atomics;return <p>{String(isLockFree(8))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'ordinary-load',
    source: 'export function Widget(){return <p>{String(Atomics.load(new Int32Array(1),0))}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'computed-ordinary-load',
    source:
      "export function Widget(){return <p>{String(Atomics['load'](new Int32Array(1),0))}</p>;}",
    refused: false,
    reader: true,
  },
  {
    id: 'local-atomics-shadow',
    source:
      'const Atomics={isLockFree:(_size:number)=>true};export function Widget(){return <p>{String(Atomics.isLockFree(8))}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'local-atomics-wait-shadow',
    source:
      'const Atomics={wait:()=>"fixed"};export function Widget(){return <p>{Atomics.wait()}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'lock-free-event-only',
    source:
      'export function Widget(){return <button onClick={()=>console.log(Atomics.isLockFree(8))}>fixed</button>;}',
    refused: false,
    reader: false,
  },
  {
    id: 'wait-effect-only',
    source:
      'import {useEffect} from "react";export function Widget({list}:{list:Int32Array}){useEffect(()=>{Atomics.wait(list,0,0,0);},[list]);return <p>fixed</p>;}',
    refused: false,
    reader: false,
  },
  {
    id: 'lock-free-useCallback-only',
    source:
      'import {useCallback} from "react";export function Widget(){const click=useCallback(()=>console.log(Atomics.isLockFree(8)),[]);return <button onClick={click}>fixed</button>;}',
    refused: false,
    reader: false,
  },
] as const;

describe('atomics render readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-atomics.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(refused);
  });
});

describe('atomics route inputs', () => {
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

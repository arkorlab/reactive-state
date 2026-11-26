import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Rendered blob URLs and WebAssembly results are private; ordinary URL data stays shared. */
const CASES = [
  {
    id: 'native-blob-url',
    source: 'export function Widget(){return <p>{URL.createObjectURL(new Blob())}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'computed-blob-url',
    source: 'export function Widget(){return <p>{URL["createObjectURL"](new Blob())}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'captured-blob-url-method',
    source:
      'export function Widget(){const create=URL.createObjectURL;return <p>{create(new Blob())}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'blob-url-namespace-alias',
    source:
      'export function Widget(){const Address=URL;return <p>{Address.createObjectURL(new Blob())}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'destructured-blob-url-method',
    source:
      'export function Widget(){const {createObjectURL:create}=URL;return <p>{create(new Blob())}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'global-blob-url-pin',
    source: 'export function Widget(){return <p>{globalThis.URL.createObjectURL(new Blob())}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'native-wasm-validate',
    source:
      'export function Widget(){return <p>{String(WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0])))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'computed-wasm-validate',
    source:
      'export function Widget(){return <p>{String(WebAssembly["validate"](new Uint8Array([0,97,115,109,1,0,0,0])))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'captured-wasm-validate',
    source:
      'export function Widget(){const validate=WebAssembly.validate;return <p>{String(validate(new Uint8Array([0,97,115,109,1,0,0,0])))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'wasm-namespace-alias',
    source:
      'export function Widget(){const wasm=WebAssembly;return <p>{String(wasm.validate(new Uint8Array([0,97,115,109,1,0,0,0])))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'global-wasm-pin',
    source:
      'export function Widget(){return <p>{String(globalThis.WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0])))}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'opaque-url-member',
    source:
      'export function Widget(){let key:string="createObjectURL";return <p>{(URL as any)[key](new Blob())}</p>;}',
    refused: true,
    reader: true,
  },
  {
    id: 'absolute-url-construction',
    source:
      'export function Widget(){return <p>{new URL("https://example.test/fixed").pathname}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'url-constructor-alias',
    source:
      'export function Widget(){const Address=URL;return <p>{new Address("https://example.test/fixed").pathname}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'native-url-parse',
    source:
      'export function Widget(){return <p>{URL.parse("https://example.test/fixed")?.pathname}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'native-url-can-parse',
    source:
      'export function Widget(){return <p>{String(URL.canParse("https://example.test/fixed"))}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'local-url-shadow',
    source:
      'const URL={createObjectURL:(_value:Blob)=>"fixed"};export function Widget(){return <p>{URL.createObjectURL(new Blob())}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'local-wasm-shadow',
    source:
      'const WebAssembly={validate:(_value:Uint8Array)=>true};export function Widget(){return <p>{String(WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0])))}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'ordinary-numeric-global',
    source: 'export function Widget(){return <p>{Math.max(1,2)}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'native-url-instance',
    source:
      'export function Widget(){const value=new URL("https://example.test/fixed");return <p>{value.hostname}</p>;}',
    refused: false,
    reader: true,
  },
  {
    id: 'blob-url-event-only',
    source:
      'export function Widget(){return <button onClick={()=>console.log(URL.createObjectURL(new Blob()))}>fixed</button>;}',
    refused: false,
    reader: false,
  },
  {
    id: 'wasm-effect-only',
    source:
      'import {useEffect} from "react";export function Widget(){useEffect(()=>{console.log(WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0])));},[]);return <p>fixed</p>;}',
    refused: false,
    reader: false,
  },
  {
    id: 'wasm-callback-only',
    source:
      'import {useCallback} from "react";export function Widget(){const click=useCallback(()=>console.log(WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0]))),[]);return <button onClick={click}>fixed</button>;}',
    refused: false,
    reader: false,
  },
  {
    id: 'wasm-event-only',
    source:
      'export function Widget(){return <button onClick={()=>console.log(WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0])))}>fixed</button>;}',
    refused: false,
    reader: false,
  },
  {
    id: 'ordinary-property-name-alias',
    source:
      'const Native=URL;export function Widget(){const data={Native:"fixed"};return <p>{data.Native}</p>;}',
    refused: false,
    reader: true,
  },
];

describe('native platform render readers', () => {
  it.each(CASES.filter(({ reader }) => reader))('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-platform.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(refused);
  });
});

describe('native platform route inputs', () => {
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

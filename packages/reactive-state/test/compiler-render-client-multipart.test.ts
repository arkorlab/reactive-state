import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native multipart serialization draws randomness during a rendered client call. */
const CASES = [
  {
    id: 'reported-response-form-data',
    source:
      "export function Widget(){return <p>{new Response(new FormData()).headers.get('content-type')}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'response-body-alias',
    source:
      "export function Widget(){const body=new FormData();const response=new Response(body);return <p>{response.headers.get('content-type')}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'request-form-data',
    source:
      "export function Widget(){return <p>{new Request('https://example.com/',{method:'POST',body:new FormData()}).headers.get('content-type')}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'request-options-alias-spread',
    source:
      "export function Widget(){const body=new FormData();const options={method:'POST',body};return <p>{new Request('https://example.com/',{...options}).headers.get('content-type')}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'response-conditional-body',
    source:
      "export function Widget(){return <p>{new Response(true?new FormData():'fixed').headers.get('content-type')}</p>;}",
    input: true,
    private: true,
  },
  {
    id: 'readonly-form-data',
    source: "export function Widget(){return <p>{new FormData().has('name')?'yes':'no'}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'response-plain-text',
    source:
      "export function Widget(){return <p>{new Response('fixed').headers.get('content-type')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'response-empty-body',
    source:
      "export function Widget(){return <p>{new Response(null).headers.get('content-type')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'request-replaced-form-data-body',
    source:
      "export function Widget(){return <p>{new Request('https://example.com/',{method:'POST',...{body:new FormData()},body:'fixed'}).headers.get('content-type')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'request-unrelated-form-data-option',
    source:
      "export function Widget(){return <p>{new Request('https://example.com/',{method:'POST',other:new FormData()}).headers.get('content-type')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'response-tracked-text-prop',
    source:
      "export function Widget({body}:{body:string}){return <p>{new Response(body).headers.get('content-type')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'deferred-event-form-data',
    source:
      "export function Widget(){return <button onClick={()=>new Response(new FormData()).headers.get('content-type')}>fixed</button>;}",
    input: null,
    private: false,
  },
  {
    id: 'lexical-response-constructor',
    source:
      "export function Widget(){class Response{headers={get:(_key:string)=>'fixed'};constructor(_body:FormData){}}return <p>{new Response(new FormData()).headers.get('content-type')}</p>;}",
    input: false,
    private: false,
  },
  {
    id: 'lexical-form-data-subclass',
    source:
      "export function Widget(){class FormData extends URLSearchParams{}return <p>{new Response(new FormData()).headers.get('content-type')}</p>;}",
    input: false,
    private: false,
  },
] as const;

describe('rendered client multipart input reader', () => {
  it.each(CASES.filter((entry) => entry.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'client-multipart.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('rendered client multipart route delivery', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, private: privateRender }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${source}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget body="fixed"/>{children}</section>;}',
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

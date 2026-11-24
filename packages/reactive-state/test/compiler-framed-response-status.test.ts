import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'response-status-supplied-words',
    source:
      'function words(error:Error){return new Response(null,{statusText:error as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-status-caught-words',
    source:
      'function words(){try{JSON.parse("{");}catch(error){return new Response(null,{statusText:error as never}).statusText;}}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'response-status-constructor-alias',
    source:
      'function words(error:Error){const Native=Response;return new Native(null,{statusText:error as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-status-constant-options',
    source:
      'function words(error:Error){const options={statusText:error as never};return new Response(null,options).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-status-options-chain',
    source:
      'function words(error:Error){const first={statusText:error as never};const options=first;return new Response(null,options).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-status-literal-spread',
    source:
      'function words(error:Error){return new Response(null,{...{statusText:error as never}}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-status-aliased-spread',
    source:
      'function words(error:Error){const options={statusText:error as never};return new Response(null,{...options}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-status-overwrites-data',
    source:
      'function words(error:Error){return new Response(null,{statusText:"fixed",...({statusText:error as never} as ResponseInit)}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-status-getter-words',
    source:
      'function words(error:Error){return new Response(null,{get statusText(){return error as never;}}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-status-array-words',
    source:
      'function words(error:Error){return new Response(null,{statusText:[error] as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-status-reflected-construction',
    source:
      'function words(error:Error){return Reflect.construct(Response,[null,{statusText:error}]).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-status-fixed-pin',
    source: 'function words(){return new Response(null,{statusText:"fixed"}).statusText;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'response-status-local-words-pin',
    source:
      'function words(){return new Response(null,{statusText:new Error("fixed") as never}).statusText;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'response-status-ignored-option-pin',
    source:
      'function words(error:Error){return new Response(null,{statusText:"fixed",ignored:error} as ResponseInit).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-status-later-data-pin',
    source:
      'function words(error:Error){return new Response(null,{statusText:error as never,...({statusText:"fixed"} as ResponseInit)}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-status-changed-options-pin',
    source:
      'function words(error:Error){const options={statusText:error as never};options.statusText="fixed" as never;return new Response(null,options).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-status-local-constructor-pin',
    source:
      'class Response{statusText="fixed";constructor(_body:unknown,_options:unknown){}}function words(error:Error){return new Response(null,{statusText:error}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-status-own-array-text-pin',
    source:
      'function words(error:Error){const text=Object.assign([error],{toString(){return"fixed";}});return new Response(null,{statusText:text as never}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-status-ignored-third-slot-pin',
    source:
      'function words(error:Error){const Native=Response as unknown as new(...args:unknown[])=>Response;return new Native(null,{statusText:"fixed"},error).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-status-body-existing-pin',
    source:
      'function words(error:Error){return new Response(error as never,{statusText:"fixed"}).statusText;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
];

describe('native response status text conversions readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'response-status-observations.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('native response status text conversions admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});

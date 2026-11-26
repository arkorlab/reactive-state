import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'url-logical-or-username',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.username ||= error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-or-password',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.password ||= error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-or-search',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.search ||= error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-or-hash',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.hash ||= error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-and-username',
    source:
      'function words(error:Error){const url=new URL("https://kept@example.test/");url.username &&= error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-and-pathname',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.pathname &&= error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-and-search',
    source:
      'function words(error:Error){const url=new URL("https://example.test/?kept");url.search &&= error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-and-hash',
    source:
      'function words(error:Error){const url=new URL("https://example.test/#kept");url.hash &&= error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-whole-alias',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");const alias=url;alias.username ||= error as never;return alias.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-native-alias',
    source:
      'const Native=URL;function words(error:Error){const url=new Native("https://example.test/");url.username ||= error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-relative-base',
    source:
      'function words(error:Error){const base="https://example.test/";const url=new URL("/path",base);url.username ||= error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-caught-words',
    source:
      'function words(){try{JSON.parse("{");}catch(error){const url=new URL("https://example.test/");url.username ||=error as never;return url.href;}}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'url-logical-or-known-skipped',
    source:
      'function words(error:Error){const url=new URL("https://kept@example.test/");url.username ||= error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-and-known-skipped',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.username &&= error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-or-path-skipped',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.pathname ||=error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-nullish-skipped',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.username ??=error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-own-data',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");Object.defineProperty(url,"username",{value:"",writable:true});url.username ||=error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-own-empty-setter',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");Object.defineProperty(url,"username",{get(){return"";},set(_value:unknown){}});url.username ||=error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-own-truthy-setter',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");Object.defineProperty(url,"username",{get(){return"kept";},set(_value:unknown){}});url.username &&=error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-replaced-prototype',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");Object.setPrototypeOf(url,{get username(){return"";},set username(_value:unknown){},get href(){return"fixed";}});url.username ||=error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-rhs-installs-setter',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.username ||= (Object.defineProperty(url,"username",{set(_value:unknown){}}),error) as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-unknown-constructor',
    source:
      'function words(error:Error,input:string){const url=new URL(input);url.username ||=error as never;return url.href;}',
    invocation: 'words(new Error("ours"),"https://example.test/")',
    refused: false,
  },
  {
    id: 'url-logical-local-constructor',
    source:
      'class URL{username:unknown="";href="fixed";constructor(_input:string){}}function words(error:Error){const url=new URL("https://example.test/");url.username ||=error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-local-error-words',
    source:
      'function words(){const url=new URL("https://example.test/");url.username ||=new Error("fixed") as never;return url.href;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'url-logical-ordinary-data',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.username ||="fixed";return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-own-error-conversion',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");Object.defineProperty(error,"toString",{value(){return"fixed";}});url.username ||=error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-literal-member',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url["username"] ||=error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-evaluated-member',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url[(Object.assign(error,{message:"fixed",name:"Fixed"}),"username")] ||=error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-error-array',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.username ||=[error] as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-logical-own-array-conversion',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");const name=Object.assign([error],{toString(){return"fixed";}});url.username ||=name as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-skipped-rhs-work',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.username &&=(Object.assign(error,{message:"fixed",name:"Fixed"}),error) as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-logical-earlier-write',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");url.username="fixed";url.username ||=error as never;return url.href;}',
    invocation: 'words(new Error("ours"))',
    refused: false,
  },
];

describe('native URL logical assignments readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'url-logical.ts', source);
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

describe('native URL logical assignments admissions', () => {
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

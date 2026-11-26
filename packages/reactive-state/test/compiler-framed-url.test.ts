import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'url-setter-href',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");url.href=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-username',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");url.username=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-password',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");url.password=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-protocol',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");url.protocol=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-host',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");url.host=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-hostname',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");url.hostname=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-port',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");url.port=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-pathname',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");url.pathname=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-search',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");url.search=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-hash',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");url.hash=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-caught-words',
    source:
      'function frames(){try{JSON.parse("{");}catch(error){const url=new URL("https://example.test/");url.username=error as never;return url.href;}}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'url-setter-constant-native-alias',
    source:
      'const Native=URL;function frames(error:Error){const url=new Native("https://example.test/");const alias=url;alias.username=error as never;return alias.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-error-array',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");url.username=[error] as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-primitive-data-pin',
    source:
      'function frames(){const url=new URL("https://example.test/");url.username="fixed";return url.href;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'url-setter-local-words-pin',
    source:
      'function frames(){const url=new URL("https://example.test/");url.username=new Error("fixed") as never;return url.href;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'url-setter-plain-receiver-pin',
    source:
      'function frames(error:Error){const url={username:undefined as unknown,href:"fixed"};url.username=error;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-setter-local-shadow-pin',
    source:
      'class URL{username:unknown;href="fixed";constructor(_input:string){}}function frames(error:Error){const url=new URL("https://example.test/");url.username=error;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-setter-own-data-pin',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");Object.defineProperty(url,"username",{value:"fixed",writable:true});url.username=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-setter-own-accessor-pin',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");Object.defineProperty(url,"username",{get(){return"fixed";},set(_value:unknown){}});url.username=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-setter-prototype-replaced-pin',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");Object.setPrototypeOf(url,{set username(_value:unknown){},get href(){return"fixed";}});url.username=error as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-setter-rhs-installs-own-setter-pin',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");url.username=(Object.defineProperty(url,"username",{set(_value:unknown){}}),error) as never;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-setter-unrelated-property-pin',
    source:
      'function frames(error:Error){const url=new URL("https://example.test/");(url as URL&{custom?:unknown}).custom=error;return url.href;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'url-setter-default-read',
    source:
      'function words(error:Error){const url=new URL("https://example.test/");const {a=url.href}=(url.username=error as never,{} as {a?:string});return a;}',
    invocation: 'words(new Error("ours"))',
    refused: true,
  },
  {
    id: 'url-setter-default-data',
    source:
      'function words(){const url=new URL("https://example.test/");const {a=url.href}=(url.username="user",{} as {a?:string});return a;}',
    invocation: 'words()',
    refused: false,
  },
];

describe('native URL setter Error words readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'url-observations.ts', source);
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

describe('native URL setter Error words admissions', () => {
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

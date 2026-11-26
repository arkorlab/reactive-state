import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native text conversions retain the error words actually consumed. */
const CASES = [
  {
    id: 'search-includes',
    source: "function frames(error:Error){return 'words'.includes(error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'search',
  },
  {
    id: 'search-startsWith',
    source: "function frames(error:Error){return 'words'.startsWith(error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'search',
  },
  {
    id: 'search-endsWith',
    source: "function frames(error:Error){return 'words'.endsWith(error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'search',
  },
  {
    id: 'search-indexOf',
    source: "function frames(error:Error){return 'words'.indexOf(error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'search',
  },
  {
    id: 'search-lastIndexOf',
    source: "function frames(error:Error){return 'words'.lastIndexOf(error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'search',
  },
  {
    id: 'search-call',
    source:
      "function frames(error:Error){return String.prototype.includes.call('words',error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'search',
  },
  {
    id: 'search-apply',
    source:
      "function frames(error:Error){return String.prototype.indexOf.apply('words',[error as never]);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'search',
  },
  {
    id: 'search-reflect',
    source:
      "function frames(error:Error){return Reflect.apply(String.prototype.startsWith,'words',[error]);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'search',
  },
  {
    id: 'search-data',
    source: "function frames(){return 'words'.includes('word');}",
    invocation: 'frames()',
    refused: false,
    topic: 'search',
  },
  {
    id: 'search-own',
    source:
      'function frames(error:Error){const own={includes(_value:unknown){return true;}};return own.includes(error);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'search',
  },
  {
    id: 'search-ignored-tail',
    source:
      "function frames(error:Error){return ('words'.indexOf as (...args:unknown[])=>number)('word',0,error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'search',
  },
  {
    id: 'search-own-words',
    source: "function frames(){return 'words'.includes(new Error('ours') as never);}",
    invocation: 'frames()',
    refused: false,
    topic: 'search',
  },
  {
    id: 'pad-zero-undefined',
    source: "function frames(error:Error){return ''.padEnd(undefined as never,error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'padzero',
  },
  {
    id: 'pad-zero-null',
    source: "function frames(error:Error){return ''.padEnd(null as never,error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'padzero',
  },
  {
    id: 'pad-zero-false',
    source: "function frames(error:Error){return ''.padEnd(false as never,error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'padzero',
  },
  {
    id: 'pad-zero-apply',
    source:
      "function frames(error:Error){return String.prototype.padStart.apply('',[null as never,error as never]);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'padzero',
  },
  {
    id: 'pad-positive-control',
    source: "function frames(error:Error){return ''.padEnd(100,error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'padzero',
  },
  {
    id: 'replace-callback-error',
    source: "function frames(error:Error){return 'x'.replace('x',()=>error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'callback',
  },
  {
    id: 'replaceAll-callback-error',
    source: "function frames(error:Error){return 'xx'.replaceAll('x',()=>error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'callback',
  },
  {
    id: 'replace-callback-borrowed',
    source:
      "function frames(error:Error){return String.prototype.replace.call('x','x',()=>error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'callback',
  },
  {
    id: 'replace-callback-data',
    source: "function frames(){return 'x'.replace('x',()=> 'fixed');}",
    invocation: 'frames()',
    refused: false,
    topic: 'callback',
  },
  {
    id: 'replace-callback-own-words',
    source: "function frames(){return 'x'.replace('x',()=>new Error('ours') as never);}",
    invocation: 'frames()',
    refused: false,
    topic: 'callback',
  },
  {
    id: 'replace-callback-no-match',
    source: "function frames(error:Error){return 'x'.replace('z',()=>error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'callback',
  },
  {
    id: 'join-separator',
    source: 'function frames(error:Error){return [1,2].join(error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'separator',
  },
  {
    id: 'join-separator-call',
    source: 'function frames(error:Error){return Array.prototype.join.call([1,2],error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'separator',
  },
  {
    id: 'join-separator-apply',
    source:
      'function frames(error:Error){return Array.prototype.join.apply([1,2],[error as never]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'separator',
  },
  {
    id: 'join-data',
    source: "function frames(){return [1,2].join('-');}",
    invocation: 'frames()',
    refused: false,
    topic: 'separator',
  },
  {
    id: 'join-own',
    source:
      "function frames(error:Error){const own={join(_value:unknown){return 'fixed';}};return own.join(error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'separator',
  },
  {
    id: 'join-ignored-tail',
    source:
      "function frames(error:Error){return ([1,2].join as (...args:unknown[])=>string)('-',error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    topic: 'separator',
  },
  {
    id: 'search-split',
    source: "function frames(error:Error){return 'words'.split(error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'othersearch',
  },
  {
    id: 'search-match',
    source: "function frames(error:Error){return 'words'.match(error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'othersearch',
  },
  {
    id: 'search-matchAll',
    source: "function frames(error:Error){return 'words'.matchAll(error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'othersearch',
  },
  {
    id: 'search-search',
    source: "function frames(error:Error){return 'words'.search(error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'othersearch',
  },
  {
    id: 'search-localeCompare',
    source: "function frames(error:Error){return 'words'.localeCompare(error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    topic: 'othersearch',
  },
];

describe('native text conversion readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-text-conversions.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});

describe('shared native text conversions', () => {
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

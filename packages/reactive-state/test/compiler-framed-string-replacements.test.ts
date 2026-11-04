import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native string replacement coerces error values while own methods and callbacks retain their meaning. */
const CASES = [
  {
    id: 'replace-caught',
    source:
      "function frames(){try{JSON.parse('bad');}catch(error){return 'x'.replace('x',error as Error);}}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'replaceAll-caught',
    source:
      "function frames(){try{JSON.parse('bad');}catch(error){return 'xx'.replaceAll('x',error as Error);}}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'replace-bracket-supplied',
    source: "function frames(error:Error){return 'x'['replace']('x',error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'replace-typed-string',
    source: "function frames(text:string,error:Error){return text.replace('x',error as never);}",
    invocation: 'frames("x",new Error("ours"))',
    refused: true,
  },
  {
    id: 'replace-native-String',
    source: "function frames(error:Error){return String('x').replace('x',error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'replace-search-error',
    source: "function frames(error:Error){return 'x'.replace(error as never,'fixed');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'replace-borrowed-call',
    source:
      "function frames(error:Error){return String.prototype.replace.call('x','x',error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'replace-borrowed-apply',
    source:
      "function frames(error:Error){return String.prototype.replace.apply('x',['x',error as never]);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'replace-ordinary-data',
    source: "function frames(){return 'x'.replace('x','fixed');}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'replace-made-words',
    source: "function frames(){return 'x'.replace('x',new Error('ours') as never);}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'replace-own-method',
    source:
      "function frames(error:Error){const own={replace(_search:unknown,_value:unknown){return 'fixed';}};return own.replace('x',error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'replace-shadowed-String',
    source:
      "function frames(error:Error){const String=()=>({replace(_search:unknown,_value:unknown){return 'fixed';}});return String().replace('x',error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'replace-callback-fixed',
    source: "function frames(){return 'x'.replace('x',()=> 'fixed');}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'replaceAll-callback-fixed',
    source: "function frames(){return 'xx'.replaceAll('x',()=> 'fixed');}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'replace-extra-argument-ignored',
    source:
      "function frames(error:Error){return ('x'.replace as (...args:unknown[])=>string)('x','fixed',error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'replaceAll-regexp-callback',
    source: "function frames(){return 'xx'.replaceAll(/x/g,()=> 'fixed');}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'spread-pos-direct-empty',
    source:
      "function frames(error:Error){return ('x'.replace as (...args:unknown[])=>string)(...[],'x',error);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-pos-direct-nested-empty',
    source:
      "function frames(error:Error){return ('x'.replace as (...args:unknown[])=>string)(...[...[]],'x',error);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-pos-replaceAll-empty',
    source:
      "function frames(error:Error){return ('xx'.replaceAll as (...args:unknown[])=>string)(...[],'x',error);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-pos-borrowed-call-empty',
    source:
      "function frames(error:Error){return String.prototype.replace.call('x',...[],'x',error as never);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-pos-literal-apply-empty',
    source:
      "function frames(error:Error){return String.prototype.replace.apply('x',[...[],'x',error as never]);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-pos-direct-third-ignored',
    source:
      "function frames(error:Error){return ('x'.replace as (...args:unknown[])=>string)(...['x','fixed'],error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'spread-pos-nested-third-ignored',
    source:
      "function frames(error:Error){return ('x'.replace as (...args:unknown[])=>string)(...[...['x','fixed']],error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'spread-pos-borrowed-third-ignored',
    source:
      "function frames(error:Error){return (String.prototype.replace.call as (...args:unknown[])=>string)('x',...['x','fixed'],error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'spread-pos-apply-third-ignored',
    source:
      "function frames(error:Error){return String.prototype.replace.apply('x',[...['x','fixed'],error as never]);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'spread-pos-empty-extra-third-ignored',
    source:
      "function frames(error:Error){return ('x'.replace as (...args:unknown[])=>string)(...[],'x','fixed',error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'spread-pos-unknown-prefix',
    source:
      "function frames(error:Error,values:unknown[]){return ('x'.replace as (...args:unknown[])=>string)(...values,'x',error);}",
    invocation: 'frames(new Error("ours"),[])',
    refused: true,
  },
  {
    id: 'spread-pos-unknown-ignored-tail',
    source:
      "function frames(error:Error,parts:string[]){return ('x'.replace as (...args:unknown[])=>string)(...parts,'x','fixed',error);}",
    invocation: 'frames(new Error("ours"),[])',
    refused: false,
  },
];

describe('native string replacement readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'string-replacement-words.ts', source);
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

describe('shared native string replacement words', () => {
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

import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'regexp-test-text',
    source: 'function frames(error:Error){return /firefox/.test(error as never);}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'regexp-exec-alias',
    source:
      'function frames(error:Error){const pattern=/firefox/;return pattern.exec(error as never)?.[0]??"none";}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'regexp-constructor-alias',
    source:
      'const Pattern=RegExp;function frames(error:Error){return new Pattern("firefox").test(error as never);}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'regexp-borrowed-test',
    source:
      'function frames(error:Error){return RegExp.prototype.test.call(/firefox/,error as never);}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'regexp-reflected-exec',
    source:
      'function frames(error:Error){return Reflect.apply(RegExp.prototype.exec,/firefox/,[error])?.[0]??"none";}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'regexp-compile-pattern',
    source: 'function frames(error:Error){return /fixed/.compile(error as never).source;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'regexp-compile-flags',
    source: 'function frames(error:Error){return /fixed/.compile("fixed",error as never).source;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'regexp-ordinary-text',
    source: 'function frames(){return /fixed/.test("fixed");}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'regexp-own-object',
    source: 'function frames(error:Error){return {test:(_value:unknown)=>true}.test(error);}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'regexp-local-shadow',
    source:
      'function frames(error:Error){class RegExp{constructor(_value:string){}test(_value:unknown){return true;}}return new RegExp("fixed").test(error);}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'regexp-own-native-method',
    source:
      'function frames(error:Error){const pattern=/fixed/;pattern.test=()=>true;return pattern.test(error as never);}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'regexp-ignored-extra-argument',
    source:
      'function frames(error:Error){return Reflect.apply(RegExp.prototype.test,/fixed/,["fixed",error]);}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'regexp-local-error',
    source: 'function frames(){return /fixed/.test(new Error("fixed")as never);}',
    invocation: 'frames()',
    refused: false,
  },
];

describe('native regexp word readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-regexp-words.ts', source);
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

describe('shared native regexp words', () => {
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

import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native URI arguments and the selected replacement callback retain their consumed words. */
const CASES = [
  {
    id: 'direct',
    source: "function frames(error:Error){return String.raw({raw:['','']},error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'global',
    source:
      "function frames(error:Error){return globalThis.String.raw({raw:['','']},error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'call',
    source:
      "function frames(error:Error){return String.raw.call(null,{raw:['','']},error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'apply',
    source:
      "function frames(error:Error){return String.raw.apply(null,[{raw:['','']},error as never]);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflect',
    source:
      "function frames(error:Error){return Reflect.apply(String.raw,null,[{raw:['','']},error]);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'alias',
    source:
      "function frames(error:Error){const raw=String.raw;return raw({raw:['','']},error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'third',
    source:
      "function frames(error:Error){return String.raw({raw:['','','']},'fixed',error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'spread',
    source:
      "function frames(error:Error){return String.raw(...[{raw:['','','']},'fixed',error] as [TemplateStringsArray,string,never]);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'segment',
    source: 'function frames(error:Error){return String.raw({raw:[error as never]});}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'mixed-segments',
    source:
      "function frames(error:Error){return String.raw({raw:['fixed',error as never]},'fixed');}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'tagged',
    source: `function frames(error:Error){return String.raw\`prefix\${error}suffix\`;}`,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty',
    source: 'function frames(error:Error){return String.raw({raw:[]},error as never);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored',
    source: "function frames(error:Error){return String.raw({raw:['fixed']},error as never);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-tail',
    source:
      "function frames(error:Error){return String.raw({raw:['','']},'fixed',error as never);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'data',
    source: "function frames(){return String.raw({raw:['a','b']},'fixed');}",
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'own-words',
    source: "function frames(){return String.raw({raw:['','']},new Error('ours') as never);}",
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'shadow',
    source:
      "function frames(error:Error){const String={raw:(_template:unknown,_value:unknown)=>'fixed'};return String.raw({raw:['','']},error);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'segment-data',
    source: "function frames(){return String.raw({raw:['fixed']});}",
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'holder-ignored',
    source:
      "function frames(error:Error){const template={raw:['fixed']};return String.raw(template,error as never);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'holder-two-reads',
    source:
      "function frames(error:Error){const template={raw:['fixed']};String.raw(template);return String.raw(template,error as never);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'holder-written',
    source:
      "function frames(error:Error){const template={raw:['fixed']};template.raw=['',''];return String.raw(template,error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'holder-interface-heritage',
    source:
      'function frames(error:Error){const Date={raw:[error as never]};interface Derived extends Date{};return String.raw(Date);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'holder-implements',
    source:
      'function frames(error:Error){const Date={raw:[error as never]};class Derived implements Date{getTime(){return 0;}}void Derived;return String.raw(Date);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'holder-interface-same-name',
    source:
      'function frames(error:Error){const Raw={raw:[error as never]};interface Raw{raw:never[]}return String.raw(Raw);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'holder-alias-same-name',
    source:
      'function frames(error:Error){const Raw={raw:[error as never]};type Raw={raw:never[]};return String.raw(Raw);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'holder-extends-written',
    source:
      "function frames(error:Error){const template={raw:['fixed']};class Base{}class Derived extends ((template.raw=['','']),Base){}void Derived;return String.raw(template,error as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'holder-extends-other-written',
    source:
      "function frames(error:Error){const template={raw:['fixed']};const other={raw:['fixed']};class Base{}class Derived extends ((other.raw=['','']),Base){}void Derived;return String.raw(template,error as never);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'segment-written',
    source:
      "function frames(error:Error){const segments:unknown[]=['fixed'];segments[0]=error;return String.raw({raw:segments as never});}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-unknown-tail',
    source:
      'function frames(error:Error){const ignored:Error[]=[error];return String.raw({raw:[]},...ignored as never);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'single-unknown-tail',
    source:
      "function frames(error:Error){const ignored:Error[]=[error];return String.raw({raw:['fixed']},...ignored as never);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'filled-unknown-tail',
    source:
      "function frames(error:Error){const ignored:Error[]=[error];return String.raw({raw:['','']},'fixed',...ignored as never);}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'spread-written-array',
    source:
      "function frames(error:Error){const parts:unknown[]=[];parts.push(error);return String.raw({raw:['','']},...parts as never);}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('native raw readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-encoding-callbacks.ts', source);
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

describe('shared native raw text', () => {
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

import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'assign-supplied-stack',
    source: 'function frames(error:Error){return Object.assign(error,{}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assign-local-stack',
    source: 'function frames(){return Object.assign(new Error("fixed"),{}).stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'assign-multiple-empty-words',
    source: 'function frames(error:Error){return Object.assign(error,{},{}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assign-null-source',
    source:
      'function frames(error:Error){return (Object.assign as(...inputs:unknown[])=>Error)(error,null).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assign-undefined-source',
    source:
      'function frames(error:Error){return (Object.assign as(...inputs:unknown[])=>Error)(error,undefined,{}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assign-empty-array-source',
    source: 'function frames(error:Error){return Object.assign(error,[]).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assign-empty-primitive-sources',
    source:
      'function frames(error:Error){return (Object.assign as(...inputs:unknown[])=>Error)(error,0,false,"").stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assign-local-written-words-pin',
    source: 'function frames(){return Object.assign(new Error("fixed"),{}).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assign-plain-data-pin',
    source: 'function frames(){return Object.assign({stack:"fixed"},{}).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assign-selected-field-override-pin',
    source: 'function frames(){return Object.assign(new Error("fixed"),{stack:"fixed"}).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assign-selected-getter-override-pin',
    source:
      'function frames(){return Object.assign(new Error("fixed"),{get stack(){return"fixed";}}).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assign-own-target-getter-data-pin',
    source: 'function frames(){return Object.assign({get stack(){return"fixed";}},{}).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assign-local-object-shadow-pin',
    source:
      'const Object={assign(_target:unknown,_source:unknown){return{stack:"fixed"};}};function frames(error:Error){return Object.assign(error,{}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'assign-source-mutation-pin',
    source:
      'function frames(){const source:{stack?:string}={};source.stack="fixed";return Object.assign(new Error("ours"),source).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assign-peer-opaque-own-setter-source',
    source:
      'function frames(receiver:{setTime(value:number):{message:string}}){return(Object.assign(new Error("fixed"),receiver.setTime(NaN))as Error).message;}',
    invocation: 'frames({setTime(){return{message:"engine"};}})',
    refused: true,
  },
  {
    id: 'assign-peer-written-own-setter-source',
    source:
      'function frames(data:{message:string}){const receiver={setTime(_value:number){return{message:data.message};}};return(Object.assign(new Error("fixed"),receiver.setTime(NaN))as Error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'assign-peer-written-own-setter-fixed-source',
    source:
      'function frames(){const receiver={setTime(_value:number){return{message:"changed"};}};return(Object.assign(new Error("fixed"),receiver.setTime(NaN))as Error).message;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'assign-peer-quiet-number-source-pin',
    source:
      'function frames(){return(Object.assign(new Error("fixed"),Number("0"))as Error).message;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'assign-peer-quiet-empty-source-pin',
    source: 'function frames(){return(Object.assign(new Error("fixed"),{})as Error).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assign-peer-fresh-date-source-pin',
    source:
      'function frames(){return(Object.assign(new Error("fixed"),new Date(0).setTime(NaN))as Error).message;}',
    invocation: 'frames()',
    refused: true,
  },
];

describe('native empty assign Error targets readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-observations.ts', source);
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

describe('native empty assign Error targets admissions', () => {
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

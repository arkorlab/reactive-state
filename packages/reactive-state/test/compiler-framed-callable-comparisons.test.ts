import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native utility and object-identity boundaries preserve Error observations and data. */
const CASES = [
  {
    id: 'callable-object-equality',
    source: 'function same(error:Error,fn:()=>void){return error==(fn as object);}',
    invocation: 'same(new Error("ours"),()=>{})',
    refused: false,
  },
  {
    id: 'array-object-equality',
    source: 'function same(error:Error,values:number[]){return error==(values as object);}',
    invocation: 'same(new Error("ours"),[1])',
    refused: false,
  },
  {
    id: 'tuple-object-equality',
    source: 'function same(error:Error,values:[number]){return error==(values as object);}',
    invocation: 'same(new Error("ours"),[1])',
    refused: false,
  },
  {
    id: 'readonly-tuple-equality',
    source: 'function same(error:Error,values:readonly[number]){return error==(values as object);}',
    invocation: 'same(new Error("ours"),[1])',
    refused: false,
  },
  {
    id: 'native-array-equality',
    source: 'function same(error:Error,values:Array<number>){return error==(values as object);}',
    invocation: 'same(new Error("ours"),[1])',
    refused: false,
  },
  {
    id: 'native-readonly-array-equality',
    source:
      'function same(error:Error,values:ReadonlyArray<number>){return error==(values as object);}',
    invocation: 'same(new Error("ours"),[1])',
    refused: false,
  },
  {
    id: 'constructable-object-equality',
    source: 'function same(error:Error,ctor:new()=>object){return error==(ctor as object);}',
    invocation: 'same(new Error("ours"),class {})',
    refused: false,
  },
  {
    id: 'selected-callable-equality',
    source: 'function same(error:Error,{fn}:{fn:()=>void}){return error==(fn as object);}',
    invocation: 'same(new Error("ours"),{fn:()=>{}})',
    refused: false,
  },
  {
    id: 'possible-primitive-union',
    source: 'function same(error:Error,fn:(()=>void)|string){return error==(fn as object);}',
    invocation: 'same(new Error("ours"),"fixed")',
    refused: true,
  },
  {
    id: 'written-primitive-replacement',
    source:
      'function same(error:Error,fn:()=>void){fn="fixed" as never;return error==(fn as object);}',
    invocation: 'same(new Error("ours"),()=>{})',
    refused: true,
  },
  {
    id: 'callable-relational-conversion',
    source: 'function same(error:Error,fn:()=>void){return error<(fn as unknown as string);}',
    invocation: 'same(new Error("ours"),()=>{})',
    refused: true,
  },
  {
    id: 'ordinary-data-comparison',
    source: 'function same(value:{stack:string},fn:()=>void){return value==(fn as object);}',
    invocation: 'same({stack:"fixed"},()=>{})',
    refused: false,
  },
];

describe('callable-comparisons readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-noinfer.ts', source);
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

describe('shared callable-comparisons results', () => {
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

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});

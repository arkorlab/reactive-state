import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A reduction or a mapping whose callback an unresolved spread supplies answers what its call
 * declares, and where the method is borrowed through `call`, `apply` or `Reflect.apply`, written
 * with type arguments, the declared result is the last of them: the first is the receiver's type.
 * A mapping's result is an array, whose element is what the callback returns.
 */
const REDUCERS = '[(a:Error,c:number,i:number,r:number[])=>Error,Error]';
const ROW_REDUCERS = '[(a:Row,c:number,i:number,r:number[])=>Row,Row]';
const ROW = 'type Row={stack?:string;title:string};';
const CASES = [
  {
    id: 'reduce-call-error-result-array-this',
    source: `function frames(reducers:${REDUCERS}){return Array.prototype.reduce.call<number[],[(a:Error,c:number,i:number,r:number[])=>Error,Error],Error>([1],...reducers).stack;}`,
    invocation: 'frames([(a)=>a,new Error("ours")])',
    refused: true,
  },
  {
    id: 'reduce-right-call-error-result-array-this',
    source: `function frames(reducers:${REDUCERS}){return Array.prototype.reduceRight.call<number[],[(a:Error,c:number,i:number,r:number[])=>Error,Error],Error>([1],...reducers).stack;}`,
    invocation: 'frames([(a)=>a,new Error("ours")])',
    refused: true,
  },
  {
    id: 'reduce-apply-spread-list-error-result-array-this',
    source: `function frames(reducers:${REDUCERS}){return Array.prototype.reduce.apply<number[],[(a:Error,c:number,i:number,r:number[])=>Error,Error],Error>([1],[...reducers]).stack;}`,
    invocation: 'frames([(a)=>a,new Error("ours")])',
    refused: true,
  },
  {
    id: 'reduce-reflect-apply-spread-list-error-result-array-this',
    source: `function frames(reducers:${REDUCERS}){return Reflect.apply<number[],[(a:Error,c:number,i:number,r:number[])=>Error,Error],Error>(Array.prototype.reduce,[1],[...reducers]).stack;}`,
    invocation: 'frames([(a)=>a,new Error("ours")])',
    refused: true,
  },
  {
    id: 'reduce-call-alias-error-result-array-this',
    source:
      'type Failure=Error;function frames(reducers:[(a:Failure,c:number,i:number,r:number[])=>Failure,Failure]){return Array.prototype.reduce.call<number[],[(a:Failure,c:number,i:number,r:number[])=>Failure,Failure],Failure>([1],...reducers).stack;}',
    invocation: 'frames([(a)=>a,new Error("ours")])',
    refused: true,
  },
  {
    id: 'reduce-call-data-result-array-this-quiet',
    source: `${ROW}function frames(reducers:${ROW_REDUCERS}){return Array.prototype.reduce.call<number[],[(a:Row,c:number,i:number,r:number[])=>Row,Row],Row>([1],...reducers).stack;}`,
    invocation: 'frames([(a)=>a,{stack:"fixed",title:"t"}])',
    refused: false,
  },
  {
    id: 'reduce-call-data-result-any-this-quiet',
    source: `${ROW}function frames(reducers:${ROW_REDUCERS}){return Array.prototype.reduce.call<any,[(a:Row,c:number,i:number,r:number[])=>Row,Row],Row>([1],...reducers).stack;}`,
    invocation: 'frames([(a)=>a,{stack:"fixed",title:"t"}])',
    refused: false,
  },
  {
    id: 'map-call-error-result-array-this',
    source:
      'function frames(mappers:[(v:number)=>Error]){return Array.prototype.map.call<number[],[(v:number)=>Error],Error[]>([1],...mappers)[0]!.stack;}',
    invocation: 'frames([()=>new Error("ours")])',
    refused: true,
  },
  {
    id: 'flat-map-call-error-result-array-this',
    source:
      'function frames(mappers:[(v:number)=>Error[]]){return Array.prototype.flatMap.call<number[],[(v:number)=>Error[]],Error[]>([1],...mappers)[0]!.stack;}',
    invocation: 'frames([()=>[new Error("ours")]])',
    refused: true,
  },
  {
    id: 'map-call-alias-error-result-array-this',
    source:
      'type Failures=Error[];function frames(mappers:[(v:number)=>Error]){return Array.prototype.map.call<number[],[(v:number)=>Error],Failures>([1],...mappers)[0]!.stack;}',
    invocation: 'frames([()=>new Error("ours")])',
    refused: true,
  },
  {
    id: 'map-call-readonly-error-result-array-this',
    source:
      'function frames(mappers:[(v:number)=>Error]){return Array.prototype.map.call<number[],[(v:number)=>Error],readonly Error[]>([1],...mappers)[0]!.stack;}',
    invocation: 'frames([()=>new Error("ours")])',
    refused: true,
  },
  {
    id: 'map-call-data-result-array-this-quiet',
    source: `${ROW}function frames(mappers:[(v:number)=>Row]){return Array.prototype.map.call<number[],[(v:number)=>Row],Row[]>([1],...mappers)[0]!.stack;}`,
    invocation: 'frames([()=>({stack:"fixed",title:"t"})])',
    refused: false,
  },
  {
    id: 'map-call-alias-data-result-array-this-quiet',
    source: `${ROW}type Rows=Row[];function frames(mappers:[(v:number)=>Row]){return Array.prototype.map.call<number[],[(v:number)=>Row],Rows>([1],...mappers)[0]!.stack;}`,
    invocation: 'frames([()=>({stack:"fixed",title:"t"})])',
    refused: false,
  },
  {
    id: 'map-call-data-result-any-this-quiet',
    source: `${ROW}function frames(mappers:[(v:number)=>Row]){return Array.prototype.map.call<any,[(v:number)=>Row],Row[]>([1],...mappers)[0]!.stack;}`,
    invocation: 'frames([()=>({stack:"fixed",title:"t"})])',
    refused: false,
  },
  {
    id: 'flat-map-call-data-result-any-this-quiet',
    source: `${ROW}function frames(mappers:[(v:number)=>Row[]]){return Array.prototype.flatMap.call<any,[(v:number)=>Row[]],Row[]>([1],...mappers)[0]!.stack;}`,
    invocation: 'frames([()=>[{stack:"fixed",title:"t"}]])',
    refused: false,
  },
  {
    id: 'map-call-error-result-any-this',
    source:
      'function frames(mappers:[(v:number)=>Error]){return Array.prototype.map.call<any,[(v:number)=>Error],Error[]>([1],...mappers)[0]!.stack;}',
    invocation: 'frames([()=>new Error("ours")])',
    refused: true,
  },
  {
    id: 'map-error-result-method-type-argument',
    source:
      'function frames(mappers:[(v:number)=>Error]){return [1].map<Error>(...mappers)[0]!.stack;}',
    invocation: 'frames([()=>new Error("ours")])',
    refused: true,
  },
  {
    id: 'reduce-error-result-method-type-argument',
    source: `function frames(reducers:${REDUCERS}){return [1].reduce<Error>(...reducers).stack;}`,
    invocation: 'frames([(a)=>a,new Error("ours")])',
    refused: true,
  },
  {
    id: 'map-data-result-method-type-argument-quiet',
    source: `${ROW}function frames(mappers:[(v:number)=>Row]){return [1].map<Row>(...mappers)[0]!.stack;}`,
    invocation: 'frames([()=>({stack:"fixed",title:"t"})])',
    refused: false,
  },
];

describe('borrowed native methods with type arguments', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'borrowed-result-types.ts', source);
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

describe('shared borrowed native method results', () => {
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

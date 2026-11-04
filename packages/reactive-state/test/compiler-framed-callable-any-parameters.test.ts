import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Whole callable parameter domains normalize source-written any before alternatives. */
const CASES = [
  {
    id: 'reported-target-any-union',
    source:
      'type Failure = ((value:number)=>void) extends ((value:any|string)=>void) ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-alias-actual-environment',
    source:
      'type Domain<T> = T|string; type Select<T> = ((value:number)=>void) extends ((value:Domain<T>)=>void) ? Error : {stack:string}; type Failure = Select<any>; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'construct-target-any-union',
    source:
      'type Failure = (new(value:number)=>{tag:string}) extends (new(value:any|string)=>{tag:string}) ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'optional-target-any-union',
    source:
      'type Failure = ((value?:number)=>void) extends ((value?:any|string)=>void) ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'rest-target-any-union',
    source:
      'type Failure = ((...values:number[])=>void) extends ((...values:(any|string)[])=>void) ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'inferred-result-with-any-union-target',
    source:
      'type Failure = ((value:number)=>Error) extends ((value:any|string)=>infer Result) ? Result : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'accepted-any-union-prior-pin',
    source:
      'type Failure = ((value:any|string)=>void) extends ((value:boolean)=>void) ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'unknown-target-data',
    source:
      'type Failure = ((value:number)=>void) extends ((value:unknown|string)=>void) ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'never-accepted-rejects-any',
    source:
      'type Failure = ((value:never)=>void) extends ((value:any|string)=>void) ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'plain-any-target-prior-pin',
    source:
      'type Failure = ((value:number)=>void) extends ((value:any)=>void) ? Error : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'boolean-complete-union-data',
    source:
      'type Failure = ((value:true|false)=>void) extends ((value:boolean)=>void) ? {stack:string} : Error; function frames(value:Failure){return value.stack;}',
    argument: '{stack:"fixed"}',
    refused: false,
  },
  {
    id: 'captured-parameter-prior-pin',
    source:
      'type Failure = ((value:any|string)=>void) extends ((value:infer Item)=>void) ? (number extends Item ? Error : {stack:string}) : {stack:string}; function frames(value:Failure){return value.stack;}',
    argument: 'new Error("ours")',
    refused: true,
  },
] as const;

describe('callable whole-any parameter readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'callable-any-parameters.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(refused);
  });
});

describe('shared helpers with callable whole-any parameters', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, argument, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(${argument})).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const unsettled = compile(app).refusals.map((item) =>
      item.reason.includes('a shared module that answers otherwise'),
    );

    expect(unsettled).toStrictEqual(refused ? [true] : []);
  });
});

/** Stack observations are read through the original native compiler syntax tree. */
function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

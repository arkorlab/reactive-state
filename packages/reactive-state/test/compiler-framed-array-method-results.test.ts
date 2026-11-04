import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Borrowed selectors and source-written at implementations retain their returned errors. */
const CASES = [
  {
    id: 'borrowed-at-call',
    source: 'function frames(error:Error){return Array.prototype.at.call([error],0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-at-apply',
    source: 'function frames(error:Error){return Array.prototype.at.apply([error],[0])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-at-reflect',
    source:
      'function frames(error:Error){return Reflect.apply(Array.prototype.at,[error],[0])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-at-alias',
    source:
      'function frames(error:Error){const at=Array.prototype.at;return at.call([error],0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-at-opaque-indices',
    source:
      'function frames(error:Error,indices:number[]){return Array.prototype.at.apply([error],indices as [number])!.stack;}',
    invocation: 'frames(new Error("ours"),[0])',
    refused: true,
  },
  {
    id: 'custom-at-captured-error',
    source:
      'function frames(error:Error){const values=[error];values.at=()=>error;return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'custom-at-made-frames',
    source:
      'function frames(){const values=[new Error("ours")];values.at=()=>new Error("ours");return values.at(0)!.stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'custom-at-function-alias',
    source:
      'function frames(error:Error){const values=[error];function own(){return error;}values.at=own;return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'custom-at-object-assign',
    source:
      'function frames(error:Error){const values=[error];Object.assign(values,{at:()=>error});return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'custom-at-data-descriptor',
    source:
      'function frames(error:Error){const values=[error];Object.defineProperty(values,"at",{value:()=>error});return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'custom-at-descriptor-map',
    source:
      'function frames(error:Error){const values=[error];Object.defineProperties(values,{at:{value:()=>error}});return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-selected-data',
    source:
      'function frames(){return Array.prototype.at.call([{stack:"fixed"},new Error("ours")],0)!.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'borrowed-negative-error',
    source:
      'function frames(){return Array.prototype.at.call([{stack:"fixed"},new Error("ours")],-1)!.stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'borrowed-out-of-bounds',
    source:
      'function frames(){return Reflect.apply(Array.prototype.at,[new Error("ours")],[2])?.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'borrowed-written-words',
    source: 'function frames(){return Array.prototype.at.call([new Error("ours")],0)!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'borrowed-supplied-words',
    source: 'function frames(error:Error){return Array.prototype.at.call([error],0)!.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'custom-at-pure-data',
    source:
      'function frames(error:Error){const values=[error];values.at=()=>({stack:"fixed"} as Error);return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'custom-at-written-words',
    source:
      'function frames(error:Error){const values=[error];values.at=()=>new Error("ours");return values.at(0)!.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'custom-at-function-data',
    source:
      'function frames(error:Error){const values=[error];function own(){return {stack:"fixed"} as Error;}values.at=own;return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'borrowed-shadowed-array',
    source:
      'function frames(error:Error){const Array={prototype:{at(_index:number){return {stack:"fixed"};}}};return Array.prototype.at.call([error],0).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'borrowed-shadowed-reflect',
    source:
      'function frames(error:Error){const Reflect={apply(_fn:unknown,_receiver:unknown,_args:unknown){return {stack:"fixed"};}};return Reflect.apply(Array.prototype.at,[error],[0]).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'custom-at-native-restoration',
    source:
      'function frames(error:Error){const values=[error];values.at=()=>({stack:"fixed"} as Error);values.at=Array.prototype.at;return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'custom-at-last-data-wins',
    source:
      'function frames(error:Error){const values=[error];values.at=()=>error;values.at=()=>({stack:"fixed"} as Error);return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'custom-at-unknown-not-proof',
    source:
      'function frames(error:Error,replace:unknown){const values=[error];values.at=replace as typeof values.at;return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"),Array.prototype.at)',
    refused: true,
  },
  {
    id: 'custom-at-conditional-error',
    source:
      'function frames(error:Error,choose:boolean){const values=[error];values.at=choose?()=>error:()=>({stack:"fixed"} as Error);return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"),true)',
    refused: true,
  },
  {
    id: 'custom-at-known-false-data',
    source:
      'function frames(error:Error){const values=[error];values.at=false?()=>error:()=>({stack:"fixed"} as Error);return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'apply-list-prior-entry-write',
    source:
      'function frames(error:Error){const indices=[0];indices[0]=1;return Array.prototype.at.apply([{stack:"fixed"},error],indices as [number])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'apply-list-prior-alias-write',
    source:
      'function frames(error:Error){const indices=[0];const alias=indices;alias[0]=1;return Array.prototype.at.apply([{stack:"fixed"},error],indices as [number])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'apply-list-stable-data',
    source:
      'function frames(error:Error){const indices=[0];return Array.prototype.at.apply([{stack:"fixed"},error],indices as [number])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'apply-list-stable-alias-chain',
    source:
      'function frames(error:Error){const indices=[0];const alias=indices;const next=alias;return Array.prototype.at.apply([{stack:"fixed"},error],next as [number])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'apply-list-direct-data',
    source:
      'function frames(error:Error){return Array.prototype.at.apply([{stack:"fixed"},error],[0])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'apply-list-later-same-owner-write',
    source:
      'function frames(error:Error){const indices=[0];const result=Array.prototype.at.apply([{stack:"fixed"},error],indices as [number])!.stack;indices[0]=1;return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'apply-index-default-source',
    source:
      'function frames(error:Error){const indices=[0];const {a=Array.prototype.at.apply([{stack:"fixed"},error],indices as [number])!.stack}=(indices[0]=1,{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'apply-index-default-source-other',
    source:
      'function frames(error:Error){const indices=[0];const other=[0];const {a=Array.prototype.at.apply([{stack:"fixed"},error],indices as [number])!.stack}=(other[0]=1,{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('borrowed and custom array selector readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-method-results.ts', source);
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

describe('shared borrowed and custom array results', () => {
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

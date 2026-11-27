import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'to-spliced-retained-first',
    source: 'function frames(error:Error){return[error].toSpliced(1,0)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-inserted-error',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].toSpliced(0,0,error as never)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-shifted-suffix',
    source: 'function frames(error:Error){return[{stack:"fixed"},error].toSpliced(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-negative-start',
    source:
      'function frames(error:Error){return[error,{stack:"fixed"}].toSpliced(-1,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-omitted-arguments',
    source:
      'function frames(error:Error){return([error].toSpliced as(...args:unknown[])=>Error[])()[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-supplied-words',
    source: 'function frames(error:Error){return[error].toSpliced(1,0)[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-stable-alias',
    source:
      'function frames(error:Error){const list=[error];return list.toSpliced(1,0)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-explicit-undefined-delete',
    source:
      'function frames(error:Error){return[error].toSpliced(0,undefined as never)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-known-spread-arguments',
    source: 'function frames(error:Error){return[error].toSpliced(...[1,0] as const)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-borrowed-call',
    source:
      'function frames(error:Error){return Array.prototype.toSpliced.call([error],1,0)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-borrowed-apply',
    source:
      'function frames(error:Error){return Array.prototype.toSpliced.apply([error],[1,0])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-deleted-error-pin',
    source: 'function frames(error:Error){return[error,{stack:"fixed"}].toSpliced(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'to-spliced-inserted-data-pin',
    source:
      'function frames(error:Error){return[error].toSpliced(0,1,{stack:"fixed"} as never)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'to-spliced-local-words-pin',
    source: 'function frames(){return[new Error("fixed")].toSpliced(1,0)[0]!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'to-spliced-data-pin',
    source: 'function frames(){return[{stack:"fixed"}].toSpliced(1,0)[0]!.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'to-spliced-own-method-pin',
    source:
      'function frames(error:Error){const list=[error];list.toSpliced=(()=>[{stack:"fixed"}]) as never;return list.toSpliced(1,0)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-own-descriptor-method-pin',
    source:
      'function frames(error:Error){const list=[error];Object.defineProperty(list,"toSpliced",{value:()=>[{stack:"fixed"}]});return list.toSpliced(1,0)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-removed-stable-alias-pin',
    source:
      'function frames(error:Error){const list=[error,{stack:"fixed"}];return list.toSpliced(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'to-spliced-one-argument-deletion-pin',
    source: 'function frames(error:Error){return[{stack:"fixed"},error].toSpliced(1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'to-spliced-negative-delete-is-zero',
    source: 'function frames(error:Error){return[error].toSpliced(0,-1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-exact-middle-slot-pin',
    source:
      'function frames(error:Error){return[error,{stack:"fixed"}].toSpliced(1,0,{stack:"inserted"})[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'to-spliced-own-set-time-bound',
    source:
      'function frames(error:Error){const receiver={setTime(_value:number){return 1;}};return[error,{stack:"fixed"}].toSpliced(receiver.setTime(NaN),1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-own-set-time-bound-alias',
    source:
      'function frames(error:Error){const receiver={setTime(_value:number){return 1;}};const start=receiver.setTime(NaN);return[error,{stack:"fixed"}].toSpliced(start,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-arithmetic-bound-data-pin',
    source:
      'function frames(error:Error){return[error,{stack:"fixed"}].toSpliced(0+0,2-1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'to-spliced-delete-all-unknown-length-pin',
    source:
      'function frames(errors:Error[]){return errors.toSpliced(0,Infinity,{stack:"fixed"} as never)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: false,
  },
  {
    id: 'to-spliced-inserted-own-getter-pin',
    source:
      'function frames(error:Error){return[error].toSpliced(0,1,{get stack(){return"fixed";}} as never)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'tospliced-loop-push',
    source:
      'function frames(error:Error){const values:Array<{stack?:string}>=[];let result:unknown;let i=0;do result=values.toSpliced(0,0)[0]?.stack;while((values.push(error),i++<1));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'tospliced-loop-push-data',
    source:
      'function frames(error:Error){const values:Array<{stack?:string}>=[];let result:unknown;let i=0;do result=values.toSpliced(0,0)[0]?.stack;while((values.push({stack:"later"}),i++<1));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native toSpliced Error origins readers', () => {
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

describe('native toSpliced Error origins admissions', () => {
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

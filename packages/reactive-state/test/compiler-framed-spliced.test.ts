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
  // Re-pinned: an operator is no pure syntax, so no position is exact; the precision cost.
  {
    // No spread moves a written argument, so the bounds are read where written; natively the
    // splice removes the Error and the read answers 'fixed'.
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
  {
    id: 'to-spliced-call-spread',
    source:
      "function args(e:Error):[number,number,Error]{return [0,0,e];}function frames(error:Error){return ([{stack:'fixed'}] as {stack?:string}[]).toSpliced(...args(error))[0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-call-spread-titled-pin',
    source:
      "function args():[number,number,{stack?:string;title:string}]{return [0,0,{stack:'fixed',title:'t'}];}function frames(error:Error){void error;return ([{stack:'fixed',title:'t'}]as{stack?:string;title:string}[]).toSpliced(...args())[0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'to-spliced-start-control-pin',
    source:
      "function read(items:{stack:string;title:string}[],error:Error){return [{stack:'fixed',title:'t'}].toSpliced(error as never,0,...items)[0]?.stack;}function frames(error:Error){return read([],error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'to-spliced-count-control-pin',
    source:
      "function read(items:{stack:string;title:string}[],error:Error){return [{stack:'fixed',title:'t'}].toSpliced(0,error as never,...items)[0]?.stack;}function frames(error:Error){return read([],error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'to-spliced-covered-control',
    source:
      "function lead():number[]{return [0,0];}function frames(error:Error){return [{stack:'fixed',title:'t'}].toSpliced(...lead(),error as never)[0]?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'to-spliced-known-spread-count-pin',
    source:
      "function read(items:{stack:string;title:string}[],error:Error){return [{stack:'fixed',title:'t'}].toSpliced(...([0] as const),error as never,...items)[0]?.stack;}function frames(error:Error){return read([],error);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'to-spliced-known-spread-inserted',
    source:
      "function read(items:{stack:string;title:string}[],error:Error){return [{stack:'fixed',title:'t'}].toSpliced(...([0,0] as const),error as never,...items)[0]?.stack;}function frames(error:Error){return read([],error);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spliced-effect-before-spread-retains-error',
    source:
      "function frames(error:Error){const args:number[]=[];const items:{stack?:string;title:string}[]=[];return ([{stack:'fixed',title:'t'}] as {stack?:string;title:string}[]).toSpliced((args.push(0),0),...args,error as never,...items)[0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  // Re-pinned: a spread of a name supplies a count the compile does not trust; the precision cost.
  {
    id: 'spliced-quiet-before-spread-safe-pin',
    source:
      "function frames(error:Error){const args:number[]=[];const items:{stack?:string;title:string}[]=[];return ([{stack:'fixed',title:'t'}] as {stack?:string;title:string}[]).toSpliced(0,...args,error as never,...items)[0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spliced-effect-before-open-spread-retains-error',
    source:
      "function read(items:{stack?:string;title:string}[],error:Error){const args:number[]=[];return ([{stack:'fixed',title:'t'}] as {stack?:string;title:string}[]).toSpliced((args.push(0),0),...args,error as never,...items)[0]!.stack;}function frames(error:Error){return read([],error);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spliced-nested-effect-retains',
    source:
      "function frames(error:Error,items:{stack:string;title:string}[]){const args:number[]=[];const receiver:{stack:string;title:string}[]=[{stack:'fixed',title:'t'}];return receiver.toSpliced(...[(args.push(0),0),...args],error as never,...items)[0]!.stack;}",
    invocation: 'frames(new Error("ours"),[])',
    refused: true,
  },
  // Re-pinned: a literal that spreads a name is no pure literal; the precision cost.
  {
    id: 'spliced-nested-quiet',
    source:
      "function frames(error:Error,items:{stack:string;title:string}[]){const args:number[]=[];const receiver:{stack:string;title:string}[]=[{stack:'fixed',title:'t'}];return receiver.toSpliced(...[0,...args],error as never,...items)[0]!.stack;}",
    invocation: 'frames(new Error("ours"),[])',
    refused: true,
  },
  {
    id: 'spliced-apply-tail-retains',
    source:
      "function frames(error:Error){const args:unknown[]=[error,0];const receiver=[{stack:'fixed'}];return (Array.prototype.toSpliced.apply(receiver,args as never,(args.unshift(0,0),undefined) as never) as {stack?:string}[])[0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spliced-apply-tail-quiet',
    source:
      "function frames(error:Error){const args:unknown[]=[error,0];const receiver=[{stack:'fixed'}];return (Array.prototype.toSpliced.apply(receiver,args as never,undefined as never) as {stack?:string}[])[0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  // Positions stand as written only where all the call evaluates first is pure syntax.
  {
    id: 'spliced-comma-nested-effect-retains',
    source:
      "function frames(error:Error,items:{stack:string;title:string}[]){const args:number[]=[];const receiver:{stack:string;title:string}[]=[{stack:'fixed',title:'t'}];return receiver.toSpliced(...(void 0,[(args.push(0),0),...args]),error as never,...items)[0]!.stack;}",
    invocation: 'frames(new Error("ours"),[])',
    refused: true,
  },
  {
    id: 'spliced-apply-receiver-effect-retains',
    source:
      "function frames(error:Error){const args:unknown[]=[error];const receiver=[{stack:'fixed'}];return (Array.prototype.toSpliced.apply((args.unshift(0,0),receiver),args as never) as {stack?:string}[])[0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  // Thirty nested pure spreads are read once each: the compile stays fast.
  {
    id: 'spliced-deep-spread-linear',
    source: `function frames(error:Error,items:{stack:string;title:string}[]){const receiver:{stack:string;title:string}[]=[{stack:'fixed',title:'t'}];return receiver.toSpliced(${'...['.repeat(30)}0${']'.repeat(30)},error as never,...items)[0]!.stack;}`,
    invocation: 'frames(new Error("ours"),[])',
    refused: false,
  },
  // An `apply` list the compile cannot read may hand the native any of its elements.
  {
    id: 'spliced-apply-unread-list-retains',
    source:
      "function read(args:unknown[]){const receiver=[{stack:'fixed'}];return (Array.prototype.toSpliced.apply(receiver,args as never) as {stack?:string}[])[0]!.stack;}function frames(error:Error){return read([0,0,error]);}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
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

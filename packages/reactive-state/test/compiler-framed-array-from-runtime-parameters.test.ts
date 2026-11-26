import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'reported-this-element',
    source:
      'function frames(error:Error){return(Array.from([error],function(this:void,value:unknown){return value;})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'this-computed-element',
    source:
      'function frames(error:Error){return(Array.from([{stack:"fixed"},error],function(this:void,value:unknown){return value;})[1]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'this-last-element',
    source:
      'function frames(error:Error){return(Array.from([undefined,error],function(this:void,value:unknown){return value;})[1]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'this-function-declaration',
    source:
      'function frames(error:Error){function mapper(this:void,value:unknown){return value;}return(Array.from([error],mapper)[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'this-const-callback',
    source:
      'function frames(error:Error){const mapper=function(this:void,value:unknown){return value;};return(Array.from([error],mapper)[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'this-const-callback-chain',
    source:
      'function frames(error:Error){const mapper=function(this:void,value:unknown){return value;};const alias=mapper;return(Array.from([error],alias)[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'this-native-function-alias',
    source:
      'function frames(error:Error){const from=Array.from;return(from([error],function(this:void,value:unknown){return value;})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'this-global-native',
    source:
      'function frames(error:Error){return(globalThis.Array.from([error],function(this:void,value:unknown){return value;})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'this-source-alias-data',
    source:
      'function frames(error:Error){const values=[{stack:"fixed"}];return(Array.from(values,function(this:void,value:unknown){return value;})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'existing-no-this',
    source:
      'function frames(error:Error){return(Array.from([error],function(value:unknown){return value;})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'this-first-data',
    source:
      'function frames(error:Error){return(Array.from([{stack:"fixed"},error],function(this:void,value:unknown){return value;})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'this-fixed-return',
    source:
      'function frames(error:Error){return(Array.from([error],function(this:void,_value:unknown){return{stack:"fixed"};})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'this-index-return',
    source:
      'function frames(error:Error){return(Array.from([error],function(this:void,_value:unknown,index:unknown){return index;})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'this-zero-runtime-parameters',
    source:
      'function frames(error:Error){return(Array.from([error],function(this:void){return{stack:"fixed"};})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'zero-syntax-parameters',
    source:
      'function frames(error:Error){return(Array.from([error],function(){return{stack:"fixed"};})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'this-fixed-source',
    source:
      'function frames(error:Error){return(Array.from([{stack:"fixed"}],function(this:void,value:unknown){return value;})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'this-third-argument-write',
    source:
      'function frames(error:Error){return(Array.from([error],function(this:void,value:unknown){return value;},Object.assign(error,{stack:"fixed"}))[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'this-prior-input-write',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return(Array.from([error],function(this:void,value:unknown){return value;})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'this-callback-prefix-write',
    source:
      'function frames(error:Error){return(Array.from([error],function(this:void,value:unknown){Object.defineProperty(error,"stack",{value:"fixed"});return value;})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-native-name-shadow',
    source:
      'function frames(error:Error){const Array={from(..._args:unknown[]){return[{stack:"fixed"}]}};return(Array.from([error],function(this:void,value:unknown){return value;})[0]as unknown as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native Array.from runtime parameters readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-reduce.ts', source);
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

describe('native Array.from runtime parameters shared', () => {
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

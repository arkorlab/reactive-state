import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native synchronous callback rest patterns preserve the actual argument slot and remaining member keys. */
const CASES = [
  {
    id: 'reported-set-first-rest-pattern',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...[value]:unknown[])=>{result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-second-rest-pattern',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...[,value]:unknown[])=>{result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-rest-after-first-parameter',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((_first,...[value]:unknown[])=>{result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-named-rest-array-data',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...values:unknown[])=>{result=(values as {stack?:string}).stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-named-rest-first-member',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...values:unknown[])=>{result=(values[0] as {stack?:string}).stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-named-rest-second-member',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...values:unknown[])=>{result=(values[1] as {stack?:string}).stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-first-rest-pattern',
    source:
      'function frames(error:Error){let result:string|undefined;[error].forEach((...[value]:unknown[])=>{result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-rest-index-data',
    source:
      'function frames(error:Error){let result:string|undefined;[error].forEach((_first,...[value]:unknown[])=>{result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-value-first-rest-pattern',
    source:
      'function frames(error:Error){let result:string|undefined;new Map([["key",error]]).forEach((...[value]:unknown[])=>{result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-key-second-rest-pattern',
    source:
      'function frames(error:Error){let result:string|undefined;new Map([[error,0]]).forEach((...[,value]:unknown[])=>{result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-key-rest-after-value',
    source:
      'function frames(error:Error){let result:string|undefined;new Map([[error,0]]).forEach((_first,...[value]:unknown[])=>{result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-named-rest-array-data',
    source:
      'function frames(error:Error){let result:string|undefined;new Map([["key",error]]).forEach((...values:unknown[])=>{result=(values as {stack?:string}).stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-nested-rest-binding-member',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([{failure:error}]).forEach((...[{failure:value}]:[{failure:unknown},...unknown[]])=>{result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'borrowed-array-first-rest-pattern',
    source:
      'function frames(error:Error){let result:string|undefined;Array.prototype.forEach.call([error],(...[value]:unknown[])=>{result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-map-body-rest-input',
    source:
      'function frames(error:Error){let result:string|undefined;[error].map((...[value]:unknown[])=>{result=(value as {stack?:string}).stack;return 0;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'ordinary-set-positional-input',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach(value=>{result=value.stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'ordinary-map-key-input',
    source:
      'function frames(error:Error){let result:string|undefined;new Map([[error,0]]).forEach((_value,key)=>{result=key.stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-for-each-keeps-data',
    source:
      'function frames(error:Error){let result:string|undefined;({forEach(callback:(value:unknown)=>void){callback({stack:"fixed"})}}).forEach((...[value]:unknown[])=>{result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-locally-written-message',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([new Error("fixed")]).forEach((...[value]:unknown[])=>{result=(value as {message:string}).message});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-third-rest-slot-is-container',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...[,,value]:unknown[])=>{result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'rest-container-reassigned-error',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...values:unknown[])=>{values=error as unknown as unknown[];result=(values as {stack?:string}).stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'rest-member-reassigned-data',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...values:unknown[])=>{values=[{stack:"fixed"}];result=(values[0] as {stack?:string}).stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'rest-member-written-error',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([0]).forEach((...values:unknown[])=>{values=[error];result=(values[0] as {stack?:string}).stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'rest-pattern-written-data',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...[value]:unknown[])=>{value={stack:"fixed"};result=(value as {stack?:string}).stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'rest-pattern-written-error',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([0]).forEach((...[value]:unknown[])=>{value=error;result=(value as {stack?:string}).stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'rest-element-written-data',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...values:unknown[])=>{values[0]={stack:"fixed"};result=(values[0] as {stack?:string}).stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'rest-pattern-evaluated-thisarg-data',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...[value]:unknown[])=>{result=(value as {stack?:string}).stack;},Object.assign(error,{stack:"fixed"}));return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'rest-pattern-earlier-callback-work-data',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...[value]:unknown[])=>{Object.assign(value as {stack?:string},{stack:"fixed"});result=(value as {stack?:string}).stack;});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'unknown-nested-getter-keeps-data',
    source:
      'function frames(holder:{failure:Error}){let result:string|undefined;new Set([holder]).forEach((...[{failure:value}]:[{failure:unknown},...unknown[]])=>{result=(value as {stack?:string}).stack});return result;}',
    invocation: 'frames({get failure(){return {name:"Fixed",message:"fixed",stack:"fixed"}}})',
    reader: false,
    refused: false,
  },
  {
    id: 'unknown-nested-iterator-keeps-data',
    source:
      'function frames(errors:[Error]){let result:string|undefined;[errors].forEach((...[[value]]:[Iterable<unknown>,...unknown[]])=>{result=(value as {stack?:string}).stack});return result;}',
    invocation:
      'frames(Object.assign([new Error("ours")] as [Error],{[Symbol.iterator]:function*(){yield {name:"Fixed",message:"fixed",stack:"fixed"}}}))',
    reader: false,
    refused: true,
  },
  {
    id: 'executed-rest-default-keeps-data',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach((...[value,,,_ignored=Object.assign(error,{stack:"fixed"})]:unknown[])=>{result=(value as {stack?:string}).stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'computed-unused-binding-keeps-data',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([{failure:error}]).forEach((...[{failure:value,[(()=>{Object.assign(error,{stack:"fixed"});return "ignored"})()]:ignored}]:[{failure:unknown;[key:string]:unknown},...unknown[]])=>{result=(value as {stack?:string}).stack});return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'rest-member-alias-selected-data-first',
    source:
      'function frames(error:Error){return([{failure:{stack:"fixed"}},{failure:error}].map((...values:unknown[])=>{const held=values[0];return(held as{failure:unknown}).failure;})[0]as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-rest-pattern-source',
    source:
      'function frames(error:Error){let result:string|undefined;const {a}=(new Set([error]).forEach((...[value]:unknown[])=>{result=(value as {stack?:string}).stack;}),{} as {a?:number});void a;return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-rest-pattern-source-data',
    source:
      'function frames(){let result:string|undefined;const {a}=(new Set([{stack:"fixed"}]).forEach((...[value]:unknown[])=>{result=(value as {stack?:string}).stack;}),{} as {a?:number});void a;return result;}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
];

describe('callback rest inputs readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
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

describe('callback rest inputs admissions', () => {
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

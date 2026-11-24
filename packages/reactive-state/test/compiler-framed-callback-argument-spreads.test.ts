import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'reported-forEach',
    source:
      'function frames(error:Error){let result:string|undefined;[error].forEach(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'computed-forEach',
    source:
      'function frames(error:Error){let result:string|undefined;[error]["forEach"](...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'function-this-forEach',
    source:
      'function frames(error:Error){let result:string|undefined;[error].forEach(...([function(this:void,value:{stack?:string}){result=value.stack;}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-spread-forEach',
    source:
      'function frames(error:Error){let result:string|undefined;[error].forEach(...([...([(value:{stack?:string})=>{result=value.stack;return[];}]as const)]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-spread-before-callback',
    source:
      'function frames(error:Error){let result:string|undefined;[error].forEach(...([]as const),...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-inner-spread-callback',
    source:
      'function frames(error:Error){let result:string|undefined;[error].forEach(...([...([]as const),(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-map',
    source:
      'function frames(error:Error){let result:string|undefined;[error].map(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-filter',
    source:
      'function frames(error:Error){let result:string|undefined;[error].filter(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-some',
    source:
      'function frames(error:Error){let result:string|undefined;[error].some(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-every',
    source:
      'function frames(error:Error){let result:string|undefined;[error].every(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-find',
    source:
      'function frames(error:Error){let result:string|undefined;[error].find(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-findIndex',
    source:
      'function frames(error:Error){let result:string|undefined;[error].findIndex(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-flatMap',
    source:
      'function frames(error:Error){let result:string|undefined;[error].flatMap(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-forEach',
    source:
      'function frames(error:Error){let result:string|undefined;new Set([error]).forEach(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-forEach',
    source:
      'function frames(error:Error){let result:string|undefined;new Map([["key",error]]).forEach(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'existing-direct-forEach',
    source:
      'function frames(error:Error){let result:string|undefined;[error].forEach((value:{stack?:string})=>{result=value.stack;return[];});return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'existing-borrowed-apply',
    source:
      'function frames(error:Error){let result:string|undefined;Array.prototype.forEach.apply([error],[(value:{stack?:string})=>{result=value.stack;return[];}]);return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'ordinary-data',
    source:
      'function frames(error:Error){let result:string|undefined;[{stack:"fixed"}].forEach(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'callback-prefix-fixed-words',
    source:
      'function frames(error:Error){let result:string|undefined;[error].forEach(...([(value:{stack?:string})=>{Object.assign(value,{stack:"fixed"});result=value.stack;}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'evaluated-thisArg-fixed-words',
    source:
      'function frames(error:Error){let result:string|undefined;[error].forEach(...([(value:{stack?:string})=>{result=value.stack;return[];},Object.assign(error,{stack:"fixed"})]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'callback-value-replacement',
    source:
      'function frames(error:Error){let result:string|undefined;[error].forEach(...([(value:{stack?:string})=>{value={stack:"fixed"};result=value.stack;}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-method-data',
    source:
      'function frames(error:Error){let result:string|undefined;const values=[error];values.forEach=(callback)=>{callback({stack:"fixed"}as Error,0,values);};values.forEach(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'callback-default-data',
    source:
      'function frames(error:Error){let result:string|undefined;[undefined].forEach(...([(value:{stack?:string}={stack:"fixed"})=>{result=value.stack;}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unresolved-callback-holder-data',
    source:
      'function frames(error:Error){let result:string|undefined;const callbacks=[(value:{stack?:string})=>{result=value.stack;return[];}]as const;[{stack:"fixed"}].forEach(...callbacks);return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'empty-array-uninvoked',
    source:
      'function frames(error:Error){let result:string|undefined;([]as Error[]).forEach(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'hole-array-uninvoked',
    source:
      'function frames(error:Error){let result:string|undefined;([,]as unknown as Error[]).forEach(...([(value:{stack?:string})=>{result=value.stack;return[];}]as const));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native callback argument spreads readers', () => {
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

describe('native callback argument spreads shared', () => {
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
